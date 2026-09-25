import hashlib
import io
import json
import logging
import struct
import zlib
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from app.models import LabelAsset, LabelPreset, LabelPresetAsset, Manufacturer
from app.models.label_preset import label_preset_name_key
from app.services.label_asset_service import (
    LabelAssetLimitError,
    LabelAssetValidationError,
    canonicalize_label_image,
    cleanup_orphaned_label_assets,
    create_label_asset,
    set_label_preset_asset_references,
)
from PIL import Image, PngImagePlugin
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import async_sessionmaker

from tests.support.backup import export_backup_data


def image_bytes(
    image_format: str = "PNG",
    *,
    mode: str = "RGB",
    color=(20, 80, 160),
    size=(24, 12),
    animated: bool = False,
    metadata: bool = False,
) -> bytes:
    image = Image.new(mode, size, color)
    output = io.BytesIO()
    kwargs = {}
    if animated:
        kwargs = {
            "save_all": True,
            "append_images": [Image.new(mode, size, color[::-1])],
            "duration": 100,
            "loop": 0,
        }
    if metadata and image_format == "PNG":
        pnginfo = PngImagePlugin.PngInfo()
        pnginfo.add_text("Comment", "must be stripped")
        kwargs["pnginfo"] = pnginfo
    image.save(output, format=image_format, **kwargs)
    return output.getvalue()


def designer_data(asset_id: str) -> dict:
    return {
        "version": 2,
        "design": {
            "version": 2,
            "label": {
                "widthMm": 60,
                "heightMm": 40,
                "marginMm": 1,
                "border": False,
            },
            "elements": [
                {
                    "id": "image-1",
                    "type": "image",
                    "assetId": asset_id,
                    "x": 1,
                    "y": 1,
                    "w": 20,
                    "h": 10,
                    "z": 0,
                    "objectFit": "contain",
                }
            ],
        },
    }


def jsonl_backup(*records: dict) -> bytes:
    from app.services.backup_stream import write_record

    output = io.BytesIO()
    for record in records:
        write_record(output, record)
    return output.getvalue()


class TestLabelImageCanonicalization:
    @pytest.mark.parametrize("transparency", [None, 0, 32768, 65535])
    def test_16_bit_grayscale_png_preserves_samples(self, transparency):
        samples = [0, 255, 256, 32767, 32768, 32769, 65535]
        source = Image.new("I;16", (len(samples), 1))
        for x, sample in enumerate(samples):
            source.putpixel((x, 0), sample)
        metadata = PngImagePlugin.PngInfo()
        metadata.add_text("Comment", "must be stripped")
        uploaded = io.BytesIO()
        options = {} if transparency is None else {"transparency": transparency}
        source.save(uploaded, format="PNG", pnginfo=metadata, **options)

        canonical = canonicalize_label_image(uploaded.getvalue())

        with Image.open(io.BytesIO(canonical.content)) as reopened:
            assert reopened.mode == "I;16"
            assert [reopened.getpixel((x, 0)) for x in range(len(samples))] == samples
            assert reopened.info.get("transparency") == transparency
            assert "Comment" not in reopened.info

    @pytest.mark.parametrize(
        "bits, transparent",
        [(1, 1), (2, 0), (2, 1), (2, 3), (4, 0), (4, 7), (4, 15), (8, 127), (16, 32768)],
    )
    def test_grayscale_png_transparency_uses_original_sample_depth(self, bits, transparent):
        # Pillow cannot write 2/4-bit grayscale fixtures, and its decoder is
        # the source of the unscaled transparency key this test must catch.
        def chunk(kind, data):
            return (
                struct.pack("!I", len(data)) + kind + data
                + struct.pack("!I", zlib.crc32(kind + data))
            )

        opaque = (transparent + 1) % (1 << bits)
        if bits < 8:
            pixels = bytes([(transparent << (8 - bits)) | (opaque << (8 - 2 * bits))])
        elif bits == 8:
            pixels = bytes([transparent, opaque])
        else:
            pixels = struct.pack("!HH", transparent, opaque)
        uploaded = (
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack("!IIBBBBB", 2, 1, bits, 0, 0, 0, 0))
            + chunk(b"tRNS", struct.pack("!H", transparent))
            + chunk(b"IDAT", zlib.compress(b"\0" + pixels))
            + chunk(b"IEND", b"")
        )

        canonical = canonicalize_label_image(uploaded)

        with Image.open(io.BytesIO(canonical.content)) as reopened:
            if reopened.mode in {"1", "I;16"}:
                offset = canonical.content.index(b"tRNS") + 4
                # Assert the actual PNG sample key, not Pillow's expanded key.
                assert int.from_bytes(canonical.content[offset : offset + 2], "big") == transparent
                if reopened.mode == "I;16":
                    assert reopened.getpixel((0, 0)) == transparent
                    assert reopened.getpixel((1, 0)) == opaque
                    return
            alpha = reopened.convert("RGBA").getchannel("A")
            assert alpha.getpixel((0, 0)) == 0
            assert alpha.getpixel((1, 0)) == 255

    @pytest.mark.parametrize(
        "mode, transparent, opaque",
        [
            ("1", 0, 255),
            ("I;16", 32768, 32769),
            ("L", 120, 121),
            ("RGB", (1, 2, 3), (4, 5, 6)),
            ("P", 0, 1),
            ("LA", (120, 0), (120, 255)),
            ("RGBA", (1, 2, 3, 0), (1, 2, 3, 255)),
        ],
    )
    def test_png_transparency_preserves_transparent_and_opaque_pixels(
        self, mode, transparent, opaque
    ):
        source = Image.new(mode, (2, 1), transparent)
        source.putpixel((1, 0), opaque)
        if mode == "P":
            source.putpalette([value for value in range(256) for _ in range(3)])
        uploaded = io.BytesIO()
        options = {} if mode in {"LA", "RGBA"} else {"transparency": transparent}
        source.save(uploaded, format="PNG", **options)

        canonical = canonicalize_label_image(uploaded.getvalue())

        with Image.open(io.BytesIO(canonical.content)) as reopened:
            if mode == "I;16":
                # PNG transparency matches the full 16-bit sample, before any
                # display conversion; adjacent opaque samples must stay distinct.
                assert reopened.info["transparency"] == 32768
                assert reopened.getpixel((0, 0)) == 32768
                assert reopened.getpixel((1, 0)) == 32769
            else:
                alpha = reopened.convert("RGBA").getchannel("A")
                assert alpha.getpixel((0, 0)) == 0
                assert alpha.getpixel((1, 0)) == 255

    @pytest.mark.parametrize("orientation, position", [(1, (0, 1)), (6, (0, 0)), (8, (1, 2))])
    @pytest.mark.parametrize(
        "mode, pixel, output_mode, expected_pixel",
        [
            ("RGB", (50, 100, 150), "RGB", (50, 100, 150)),
            ("RGBA", (50, 100, 150, 80), "RGBA", (50, 100, 150, 80)),
            ("L", 120, "RGB", (120, 120, 120)),
            ("LA", (120, 80), "RGBA", (120, 120, 120, 80)),
            ("P", 120, "RGBA", (120, 120, 120, 255)),
        ],
    )
    def test_canonical_bytes_preserve_orientation_and_alpha(
        self, mode, pixel, output_mode, expected_pixel, orientation, position
    ):
        source = Image.new(mode, (3, 2))
        if mode == "P":
            source.putpalette([value for value in range(256) for _ in range(3)])
            source.info["transparency"] = 0
        source.putpixel((0, 1), pixel)
        exif = source.getexif()
        exif[274] = orientation
        uploaded = io.BytesIO()
        source.save(uploaded, format="PNG", exif=exif)

        expected = Image.new(output_mode, (3, 2) if orientation == 1 else (2, 3))
        expected.putpixel(position, expected_pixel)
        encoded = io.BytesIO()
        expected.save(encoded, format="PNG", optimize=True)

        canonical = canonicalize_label_image(uploaded.getvalue())
        assert canonical.content == encoded.getvalue()
        assert (canonical.width, canonical.height) == expected.size

    @pytest.mark.parametrize("image_format", ["PNG", "JPEG", "WEBP"])
    def test_accepts_supported_formats_and_reencodes_canonical_png(self, image_format):
        canonical = canonicalize_label_image(image_bytes(image_format))

        assert canonical.content.startswith(b"\x89PNG\r\n\x1a\n")
        assert canonical.media_type == "image/png"
        assert (canonical.width, canonical.height) == (24, 12)
        assert canonical.byte_size == len(canonical.content)
        assert len(canonical.sha256) == 64

    def test_preserves_transparency_but_strips_metadata(self):
        canonical = canonicalize_label_image(
            image_bytes(
                mode="RGBA",
                color=(20, 80, 160, 90),
                metadata=True,
            )
        )

        with Image.open(io.BytesIO(canonical.content)) as reopened:
            assert reopened.mode == "RGBA"
            pixel = reopened.getpixel((0, 0))
            assert isinstance(pixel, tuple)
            assert pixel[3] == 90
            assert "Comment" not in reopened.info

    @pytest.mark.parametrize(
        "content",
        [b"not an image", b'<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
    )
    def test_rejects_invalid_bytes_and_svg(self, content):
        with pytest.raises(LabelAssetValidationError):
            canonicalize_label_image(content)

    def test_rejects_animation_and_input_or_pixel_limits(self):
        with pytest.raises(LabelAssetValidationError, match="[Aa]nimated"):
            canonicalize_label_image(image_bytes(animated=True))
        with pytest.raises(LabelAssetValidationError, match="5 MiB"):
            canonicalize_label_image(b"x" * (5 * 1024 * 1024 + 1))
        with pytest.raises(LabelAssetValidationError, match="12 megapixels"):
            canonicalize_label_image(image_bytes(size=(4000, 3100)))


class TestLabelAssetPersistence:
    @pytest.mark.asyncio
    async def test_same_user_deduplicates_but_users_remain_isolated(
        self, db_session, admin_user, normal_user
    ):
        content = image_bytes()
        first, first_created = await create_label_asset(
            db_session, admin_user.id, "logo.png", content
        )
        duplicate, duplicate_created = await create_label_asset(
            db_session, admin_user.id, "renamed.png", content
        )
        other_user, other_created = await create_label_asset(
            db_session, normal_user.id, "logo.png", content
        )
        await db_session.commit()

        assert first_created is True
        assert duplicate_created is False
        assert duplicate.id == first.id
        assert duplicate.display_name == "logo.png"
        assert other_created is True
        assert other_user.id != first.id
        assert other_user.sha256 == first.sha256
        assert (
            await db_session.scalar(select(func.count()).select_from(LabelAsset)) == 2
        )

    @pytest.mark.asyncio
    async def test_reuploading_an_orphan_renews_its_cleanup_grace_period(
        self, db_session, admin_user
    ):
        content = image_bytes()
        asset, _ = await create_label_asset(
            db_session, admin_user.id, "old.png", content
        )
        previous = datetime.now(UTC) - timedelta(days=29)
        asset.orphaned_at = previous
        await db_session.flush()

        duplicate, created = await create_label_asset(
            db_session, admin_user.id, "again.png", content
        )

        assert created is False
        assert duplicate.id == asset.id
        assert duplicate.orphaned_at is not None
        assert duplicate.orphaned_at > previous

        duplicate.orphaned_at = None
        referenced, created = await create_label_asset(
            db_session, admin_user.id, "referenced.png", content
        )
        assert created is False
        assert referenced.orphaned_at is None

    @pytest.mark.asyncio
    async def test_enforces_per_user_count_and_byte_quotas(
        self, db_session, admin_user, monkeypatch
    ):
        import app.services.label_asset_service as service

        user_id = admin_user.id
        monkeypatch.setattr(service, "MAX_ASSETS_PER_USER", 1)
        await create_label_asset(
            db_session, user_id, "first.png", image_bytes(color=(1, 2, 3))
        )
        with pytest.raises(LabelAssetLimitError, match="100"):
            await create_label_asset(
                db_session,
                user_id,
                "second.png",
                image_bytes(color=(4, 5, 6)),
            )

        await db_session.rollback()
        monkeypatch.setattr(service, "MAX_ASSETS_PER_USER", 100)
        monkeypatch.setattr(service, "MAX_TOTAL_ASSET_BYTES_PER_USER", 1)
        with pytest.raises(LabelAssetLimitError, match="50 MiB"):
            await create_label_asset(db_session, user_id, "large.png", image_bytes())

    @pytest.mark.asyncio
    async def test_reference_rows_control_orphan_state_and_thirty_day_cleanup(
        self, db_session, admin_user
    ):
        asset, _ = await create_label_asset(
            db_session, admin_user.id, "logo.png", image_bytes()
        )
        preset = LabelPreset(
            user_id=admin_user.id,
            preset_type="spool",
            name="With image",
            name_key=label_preset_name_key("With image"),
            data={"version": 2},
        )
        db_session.add(preset)
        await db_session.flush()

        await set_label_preset_asset_references(db_session, preset, {asset.id})
        await db_session.flush()
        assert asset.orphaned_at is None
        assert (
            await db_session.scalar(select(func.count()).select_from(LabelPresetAsset))
            == 1
        )

        orphaned_at = datetime.now(UTC) - timedelta(days=31)
        await set_label_preset_asset_references(
            db_session, preset, set(), orphaned_at=orphaned_at
        )
        await db_session.flush()
        assert asset.orphaned_at == orphaned_at

        deleted = await cleanup_orphaned_label_assets(db_session, now=datetime.now(UTC))
        await db_session.flush()
        assert deleted == 1
        assert await db_session.get(LabelAsset, asset.id) is None

    @pytest.mark.asyncio
    async def test_rejects_cross_user_asset_references(
        self, db_session, admin_user, normal_user
    ):
        asset, _ = await create_label_asset(
            db_session, normal_user.id, "private.png", image_bytes()
        )
        preset = LabelPreset(
            user_id=admin_user.id,
            preset_type="spool",
            name="Admin",
            name_key=label_preset_name_key("Admin"),
            data={"version": 2},
        )
        db_session.add(preset)
        await db_session.flush()

        with pytest.raises(LabelAssetValidationError, match="not found"):
            await set_label_preset_asset_references(db_session, preset, {asset.id})


class TestLabelAssetApi:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("mode, transparency", [("1", 0), ("I;16", 32768)])
    async def test_upload_accepts_transparent_grayscale_png(
        self, auth_client, mode, transparency
    ):
        uploaded = io.BytesIO()
        Image.new(mode, (2, 1), transparency).save(
            uploaded, format="PNG", transparency=transparency
        )
        client, csrf_token = auth_client

        response = await client.post(
            "/api/v1/me/label-assets",
            files={"file": ("transparent.png", uploaded.getvalue(), "image/png")},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        asset = response.json()
        assert asset["media_type"] == "image/png"
        assert (asset["width"], asset["height"]) == (2, 1)
        content = await client.get(f"/api/v1/me/label-assets/{asset['id']}/content")
        assert content.status_code == 200
        assert hashlib.sha256(content.content).hexdigest() == asset["sha256"]

    @pytest.mark.asyncio
    @pytest.mark.parametrize("text_after_idat", [False, True])
    async def test_rejects_png_text_decompression_limit(
        self, auth_client, db_session, text_after_idat
    ):
        metadata = PngImagePlugin.PngInfo()
        metadata.add_text("Comment", "x" * (1024 * 1024 + 1), zip=True)
        content = io.BytesIO()
        Image.new("RGB", (2, 2)).save(content, format="PNG", pnginfo=metadata)
        payload = content.getvalue()
        if text_after_idat:
            # Move the complete zTXt chunk, retaining its CRC, just before IEND.
            start = payload.index(b"zTXt") - 4
            end = start + int.from_bytes(payload[start : start + 4], "big") + 12
            payload = payload[:start] + payload[end:-12] + payload[start:end] + payload[-12:]
        client, csrf_token = auth_client

        response = await client.post(
            "/api/v1/me/label-assets",
            files={"file": ("compressed-text.png", payload, "image/png")},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 422
        assert response.json()["detail"]["code"] == "invalid_label_asset"
        assert await db_session.scalar(select(func.count()).select_from(LabelAsset)) == 0

    @pytest.mark.asyncio
    async def test_upload_list_and_private_revalidated_content(self, auth_client):
        client, csrf_token = auth_client
        response = await client.post(
            "/api/v1/me/label-assets",
            files={"file": ("my logo.webp", image_bytes("WEBP"), "image/webp")},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        uploaded = response.json()
        assert uploaded["display_name"] == "my logo.webp"
        assert uploaded["media_type"] == "image/png"
        assert uploaded["width"] == 24
        assert uploaded["height"] == 12
        assert "content" not in uploaded

        listed = await client.get("/api/v1/me/label-assets")
        assert listed.status_code == 200
        assert listed.json() == [uploaded]

        content = await client.get(f"/api/v1/me/label-assets/{uploaded['id']}/content")
        assert content.status_code == 200
        assert content.headers["content-type"] == "image/png"
        assert content.headers["cache-control"] == "private, no-cache"
        assert content.headers["etag"] == f'"{uploaded["sha256"]}"'
        assert content.content.startswith(b"\x89PNG\r\n\x1a\n")

        unchanged = await client.get(
            f"/api/v1/me/label-assets/{uploaded['id']}/content",
            headers={"If-None-Match": content.headers["etag"]},
        )
        assert unchanged.status_code == 304
        assert unchanged.headers["etag"] == content.headers["etag"]
        assert unchanged.content == b""

    @pytest.mark.asyncio
    async def test_upload_requires_authentication(self, client):
        response = await client.post(
            "/api/v1/me/label-assets",
            files={"file": ("logo.png", image_bytes(), "image/png")},
        )
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_cookie_upload_requires_csrf(self, auth_client):
        client, _csrf_token = auth_client
        response = await client.post(
            "/api/v1/me/label-assets",
            files={"file": ("logo.png", image_bytes(), "image/png")},
        )
        assert response.status_code == 403

    @pytest.mark.asyncio
    async def test_assets_support_api_key_auth(self, client, db_session, normal_user):
        from app.core.security import generate_token_secret, hash_token
        from app.models import UserApiKey

        secret = generate_token_secret()
        api_key = UserApiKey(
            user_id=normal_user.id,
            name="Label images",
            key_hash=hash_token(secret),
        )
        db_session.add(api_key)
        await db_session.commit()
        await db_session.refresh(api_key)
        headers = {"Authorization": f"ApiKey uak.{api_key.id}.{secret}"}

        response = await client.post(
            "/api/v1/me/label-assets",
            files={"file": ("logo.png", image_bytes(), "image/png")},
            headers=headers,
        )
        assert response.status_code == 200
        assert (await client.get("/api/v1/me/label-assets", headers=headers)).json()

    @pytest.mark.asyncio
    async def test_ownership_is_hidden_and_unreferenced_assets_can_be_deleted(
        self, auth_client, db_session, normal_user
    ):
        client, csrf_token = auth_client
        private_asset, _ = await create_label_asset(
            db_session, normal_user.id, "private.png", image_bytes()
        )
        await db_session.commit()

        assert (
            await client.get(f"/api/v1/me/label-assets/{private_asset.id}/content")
        ).status_code == 404
        assert (
            await client.delete(
                f"/api/v1/me/label-assets/{private_asset.id}",
                headers={"X-CSRF-Token": csrf_token},
            )
        ).status_code == 404

        uploaded = await client.post(
            "/api/v1/me/label-assets",
            files={"file": ("delete.png", image_bytes(color=(9, 8, 7)), "image/png")},
            headers={"X-CSRF-Token": csrf_token},
        )
        response = await client.delete(
            f"/api/v1/me/label-assets/{uploaded.json()['id']}",
            headers={"X-CSRF-Token": csrf_token},
        )
        assert response.status_code == 204

    @pytest.mark.asyncio
    async def test_preset_references_prevent_deletion_then_become_orphaned(
        self, auth_client, db_session
    ):
        client, csrf_token = auth_client
        uploaded = await client.post(
            "/api/v1/me/label-assets",
            files={"file": ("used.png", image_bytes(), "image/png")},
            headers={"X-CSRF-Token": csrf_token},
        )
        asset_id = uploaded.json()["id"]

        preset = await client.put(
            "/api/v1/me/label-presets/spool/item",
            json={"name": "Uses image", "data": designer_data(asset_id)},
            headers={"X-CSRF-Token": csrf_token},
        )
        assert preset.status_code == 200
        assert (
            await client.delete(
                f"/api/v1/me/label-assets/{asset_id}",
                headers={"X-CSRF-Token": csrf_token},
            )
        ).status_code == 409

        deleted = await client.delete(
            "/api/v1/me/label-presets/spool/item?name=Uses%20image",
            headers={"X-CSRF-Token": csrf_token},
        )
        assert deleted.status_code == 204
        asset = await db_session.get(LabelAsset, asset_id)
        await db_session.refresh(asset)
        assert asset.orphaned_at is not None

    @pytest.mark.asyncio
    async def test_preset_rejects_missing_or_cross_user_asset_ids(
        self, auth_client, db_session, normal_user
    ):
        client, csrf_token = auth_client
        private_asset, _ = await create_label_asset(
            db_session, normal_user.id, "private.png", image_bytes()
        )
        await db_session.commit()

        for asset_id in (private_asset.id, "00000000-0000-0000-0000-000000000000"):
            response = await client.put(
                "/api/v1/me/label-presets/spool/item",
                json={"name": "Invalid image", "data": designer_data(asset_id)},
                headers={"X-CSRF-Token": csrf_token},
            )
            assert response.status_code == 422
            assert response.json()["detail"]["code"] == "invalid_label_asset"

    @pytest.mark.asyncio
    async def test_browser_preset_migration_restores_image_references(
        self, auth_client, db_session
    ):
        client, csrf_token = auth_client
        uploaded = await client.post(
            "/api/v1/me/label-assets",
            files={"file": ("migrated.png", image_bytes(), "image/png")},
            headers={"X-CSRF-Token": csrf_token},
        )
        asset_id = uploaded.json()["id"]

        response = await client.post(
            "/api/v1/me/label-presets/migrate",
            json={
                "presets": [
                    {
                        "preset_type": "spool",
                        "name": "Migrated v2",
                        "data": designer_data(asset_id),
                    }
                ]
            },
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200
        assert response.json()[0]["data"] == designer_data(asset_id)
        assert (
            await db_session.scalar(
                select(func.count())
                .select_from(LabelPresetAsset)
                .where(LabelPresetAsset.asset_id == asset_id)
            )
            == 1
        )


class TestLabelAssetBackups:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("endpoint", ["export", "export-inventory"])
    async def test_backup_defaults_to_legacy_json(self, auth_client, endpoint):
        client, _csrf_token = auth_client
        response = await client.get(f"/api/v1/admin/system/backup/{endpoint}")

        assert response.status_code == 200
        assert response.headers["content-type"] == "application/json"
        assert response.headers["content-disposition"].endswith('.json"')
        payload = response.json()
        assert set(payload) == {"metadata", "data"}
        assert set(payload["metadata"]) == {
            "export_date",
            "app_version",
            "schema_version",
            "plugins",
        }
        assert isinstance(payload["data"]["manufacturers"], list)
        assert ("users" in payload["data"]) == (endpoint == "export")

    @pytest.mark.asyncio
    @pytest.mark.parametrize("format", ["jsonl", "auto"])
    @pytest.mark.parametrize(
        "endpoint, kind", [("export", "complete"), ("export-inventory", "inventory")]
    )
    async def test_backup_exports_jsonl_on_opt_in(
        self, auth_client, endpoint, kind, format
    ):
        client, _csrf_token = auth_client
        response = await client.get(
            f"/api/v1/admin/system/backup/{endpoint}?format={format}"
        )

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/x-ndjson")
        assert response.headers["content-disposition"].endswith('.jsonl"')
        records = [json.loads(line) for line in response.content.splitlines()]
        assert records[0]["format"] == "filaman-backup"
        assert records[0]["kind"] == kind
        assert records[-1]["end"] is True

    @pytest.mark.asyncio
    @pytest.mark.parametrize("format", ["json", "auto"])
    async def test_large_custom_field_exports_and_restores_with_auto_backup(
        self, auth_client, db_session, tmp_path, monkeypatch, format
    ):
        from app.api.v1 import system

        value = "x" * (8 * 1024 * 1024)
        db_session.add(
            Manufacturer(name="Large custom field", custom_fields={"notes": value})
        )
        await db_session.commit()
        monkeypatch.setattr(system, "_get_backup_dir", lambda: tmp_path)
        client, csrf_token = auth_client
        query = "?format=auto" if format == "auto" else ""
        exported = await client.get(
            f"/api/v1/admin/system/backup/export-inventory{query}"
        )

        assert exported.status_code == 200
        assert exported.headers["content-type"] == "application/json"
        assert exported.headers["content-disposition"].endswith('.json"')
        assert exported.json()["data"]["manufacturers"][0]["custom_fields"] == {
            "notes": value
        }

        restored = await client.post(
            "/api/v1/admin/system/backup/import-inventory",
            files={"file": ("inventory.json", exported.content, "application/json")},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert restored.status_code == 200
        manufacturer = await db_session.scalar(select(Manufacturer))
        assert manufacturer.custom_fields == {"notes": value}
        backups = list(tmp_path.iterdir())
        assert len(backups) == 1
        assert backups[0].suffix == ".json"
        saved = json.loads(backups[0].read_bytes())
        assert saved["metadata"]["auto_backup"] is True
        assert saved["data"]["manufacturers"][0]["custom_fields"] == {"notes": value}

    @pytest.mark.asyncio
    async def test_asset_export_loads_only_one_blob_at_a_time(
        self, db_session, admin_user, tmp_path, monkeypatch
    ):
        from app.api.v1 import system

        for index in range(3):
            await create_label_asset(
                db_session,
                admin_user.id,
                f"{index}.png",
                image_bytes(color=(index, 0, 0)),
            )
        await db_session.commit()
        db_session.expunge_all()
        retained = []
        serialize_row = system._serialize_row

        def observe_row(row):
            retained.append(
                sum(
                    isinstance(item, LabelAsset)
                    for item in db_session.identity_map.values()
                )
            )
            return serialize_row(row)

        monkeypatch.setattr(system, "_serialize_row", observe_row)
        await system._write_backup_file(
            db_session,
            tmp_path / "assets.jsonl",
            kind="complete",
            metadata={},
            tables=(("label_assets", LabelAsset),),
        )

        assert len(retained) == 3
        assert max(retained) == 1

    @pytest.mark.asyncio
    @pytest.mark.parametrize("format", ["json", "jsonl"])
    async def test_asset_import_decodes_only_one_blob_before_flush(
        self, db_session, admin_user, monkeypatch, format
    ):
        from app.api.v1 import system

        rows = []
        for index in range(3):
            asset, _created = await create_label_asset(
                db_session,
                admin_user.id,
                f"{index}.png",
                image_bytes(color=(index, 0, 0)),
            )
            rows.append(system._serialize_row(asset))
        await db_session.commit()
        await db_session.execute(delete(LabelAsset))
        db_session.expunge_all()
        pending = []
        import_row = system._import_backup_row

        async def observe_row(*args, **kwargs):
            await import_row(*args, **kwargs)
            pending.append(sum(isinstance(item, LabelAsset) for item in db_session.new))

        monkeypatch.setattr(system, "_import_backup_row", observe_row)
        tables = (("label_assets", LabelAsset),)
        if format == "json":
            imported = await system._import_mapping_data(
                db_session, {"label_assets": rows}, tables
            )
        else:
            content = jsonl_backup(
                {
                    "format": "filaman-backup",
                    "version": 1,
                    "kind": "complete",
                    "metadata": {},
                },
                *({"table": "label_assets", "row": row} for row in rows),
                {"end": True, "counts": {"label_assets": 3}},
            )
            imported, _metadata = await system._import_jsonl_data(
                db_session, io.BytesIO(content), expected_kind="complete", tables=tables
            )

        assert imported == {"label_assets": 3}
        assert max(pending) == 1
        assert (
            await db_session.scalar(select(func.count()).select_from(LabelAsset)) == 3
        )

    @pytest.mark.asyncio
    async def test_auto_backup_uses_atomic_jsonl_writer(
        self, db_session, tmp_path, monkeypatch
    ):
        from app.api.v1 import system

        monkeypatch.setattr(system, "_get_backup_dir", lambda: tmp_path)
        path = await system._create_auto_backup(db_session)

        assert path.suffix == ".jsonl"
        records = [json.loads(line) for line in path.read_bytes().splitlines()]
        assert records[0]["metadata"]["auto_backup"] is True
        assert records[-1]["end"] is True
        assert not list(tmp_path.glob(".*"))

    @pytest.mark.asyncio
    async def test_backup_export_rejects_an_unrestorable_database_record(
        self, db_session, admin_user, tmp_path, monkeypatch
    ):
        from app.api.v1 import system
        from app.services import backup_stream

        await create_label_asset(
            db_session, admin_user.id, "large-record.png", image_bytes()
        )
        await db_session.flush()
        path = tmp_path / "backup.jsonl"
        monkeypatch.setattr(backup_stream, "MAX_BACKUP_RECORD_BYTES", 128)

        with pytest.raises(backup_stream.BackupStreamError, match="Cannot export"):
            await system._write_backup_file(
                db_session,
                path,
                kind="complete",
                metadata={},
                tables=system.COMPLETE_BACKUP_TABLES,
            )

        assert not path.exists()
        assert not list(tmp_path.glob(".*"))

    @pytest.mark.asyncio
    async def test_jsonl_export_keeps_only_a_bounded_row_batch_in_memory(
        self, db_session, tmp_path, monkeypatch
    ):
        from app.api.v1 import system

        db_session.add_all(
            Manufacturer(name=f"Streamed manufacturer {index}") for index in range(45)
        )
        await db_session.commit()
        db_session.expunge_all()
        retained: list[int] = []
        write_record = system.write_record

        def observe_rows(stream, record):
            if record.get("table") == "manufacturers":
                retained.append(
                    sum(
                        isinstance(instance, Manufacturer)
                        for instance in db_session.identity_map.values()
                    )
                )
            write_record(stream, record)

        monkeypatch.setattr(system, "write_record", observe_rows)
        await system._write_backup_file(
            db_session,
            tmp_path / "bounded.jsonl",
            kind="inventory",
            metadata={},
            tables=(("manufacturers", Manufacturer),),
        )

        assert retained
        assert max(retained) <= 20

    @pytest.mark.asyncio
    async def test_jsonl_import_flushes_bounded_batches_and_releases_presets(
        self, db_session, admin_user, monkeypatch
    ):
        from app.api.v1 import system

        records = [
            {
                "table": "label_presets",
                "row": {
                    "id": 10_000 + index,
                    "user_id": admin_user.id,
                    "preset_type": "spool",
                    "name": f"Imported {index}",
                    "name_key": "0" * 64,
                    "data": {},
                },
            }
            for index in range(45)
        ]
        content = jsonl_backup(
            {
                "format": "filaman-backup",
                "version": 1,
                "kind": "complete",
                "metadata": {},
            },
            *records,
            {
                "end": True,
                "counts": {"label_presets": 45, "label_preset_assets": 0},
            },
        )
        pending: list[int] = []
        retained_at_finish: list[int] = []
        import_row = system._import_backup_row
        finish_import = system._finish_backup_import

        async def observe_pending(*args, **kwargs):
            await import_row(*args, **kwargs)
            pending.append(len(db_session.new))

        async def observe_finish(db, imported):
            retained_at_finish.append(
                sum(
                    isinstance(instance, LabelPreset)
                    for instance in db_session.identity_map.values()
                )
            )
            return await finish_import(db, imported)

        monkeypatch.setattr(system, "_import_backup_row", observe_pending)
        monkeypatch.setattr(system, "_finish_backup_import", observe_finish)
        await system._import_jsonl_data(
            db_session,
            io.BytesIO(content),
            expected_kind="complete",
            tables=(
                ("label_presets", LabelPreset),
                ("label_preset_assets", LabelPresetAsset),
            ),
        )

        assert max(pending) <= 20
        assert max(retained_at_finish) <= 20

    def test_nginx_bounds_streaming_backup_uploads(self):
        config = (Path(__file__).parents[2] / "nginx.conf").read_text()

        assert "location ~ ^/api/v1/admin/system/backup/import" in config
        assert "client_max_body_size 2g;" in config
        assert "client_max_body_size 0;" not in config

    @pytest.mark.asyncio
    async def test_import_failure_does_not_disclose_backup_values(
        self, auth_client, tmp_path, monkeypatch, caplog
    ):
        from app.api.v1 import system

        monkeypatch.setattr(system, "_get_backup_dir", lambda: tmp_path)
        counts = {name: 0 for name, _model in system.INVENTORY_BACKUP_TABLES}
        counts["manufacturers"] = 2
        secret = "SYNTHETIC-BACKUP-SECRET"
        content = jsonl_backup(
            {
                "format": "filaman-backup",
                "version": 1,
                "kind": "inventory",
                "metadata": {},
            },
            {"table": "manufacturers", "row": {"id": 90_001, "name": secret}},
            {"table": "manufacturers", "row": {"id": 90_002, "name": secret}},
            {"end": True, "counts": counts},
        )
        client, csrf_token = auth_client

        with caplog.at_level(logging.ERROR, logger="app.api.v1.system"):
            response = await client.post(
                "/api/v1/admin/system/backup/import-inventory",
                files={
                    "file": (
                        "backup.jsonl",
                        content,
                        "application/x-ndjson",
                    )
                },
                headers={"X-CSRF-Token": csrf_token},
            )

        assert response.status_code == 500
        assert secret not in response.text
        assert secret not in caplog.text

    @pytest.mark.asyncio
    async def test_complete_backup_import_rejects_truncated_legacy_json(
        self, auth_client
    ):
        client, csrf_token = auth_client
        response = await client.post(
            "/api/v1/admin/system/backup/import",
            files={"file": ("backup.json", b"{" + b" " * 32, "application/json")},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 422
        assert response.json()["detail"]["code"] == "invalid_json"

    @pytest.mark.asyncio
    async def test_jsonl_backup_restores_assets_and_references(
        self,
        auth_client,
        db_session,
        db_engine,
        admin_user,
        tmp_path,
        monkeypatch,
    ):
        from app.api.v1 import system

        user_id = admin_user.id
        content = image_bytes()
        asset, _created = await create_label_asset(
            db_session, user_id, "streamed.png", content
        )
        preset = LabelPreset(
            user_id=user_id,
            preset_type="spool",
            name="Streamed image",
            name_key=label_preset_name_key("Streamed image"),
            data=designer_data(asset.id),
        )
        db_session.add(preset)
        await db_session.flush()
        await set_label_preset_asset_references(db_session, preset, {asset.id})
        await db_session.commit()
        asset_id, preset_id, canonical_content = asset.id, preset.id, asset.content
        client, csrf_token = auth_client
        exported = await client.get("/api/v1/admin/system/backup/export?format=jsonl")
        assert exported.status_code == 200
        monkeypatch.setattr(system, "_get_backup_dir", lambda: tmp_path)

        restored = await client.post(
            "/api/v1/admin/system/backup/import",
            files={
                "file": (
                    "backup.jsonl",
                    exported.content,
                    "application/x-ndjson",
                )
            },
            headers={"X-CSRF-Token": csrf_token},
        )

        assert restored.status_code == 200
        sessions = async_sessionmaker(db_engine, expire_on_commit=False)
        async with sessions() as fresh_db:
            restored_asset = await fresh_db.get(LabelAsset, asset_id)
            assert restored_asset is not None
            await fresh_db.refresh(restored_asset, ["content"])
            assert restored_asset.content == canonical_content
            assert restored_asset.user_id == user_id
            assert (
                await fresh_db.scalar(
                    select(func.count())
                    .select_from(LabelPresetAsset)
                    .where(
                        LabelPresetAsset.preset_id == preset_id,
                        LabelPresetAsset.asset_id == asset_id,
                        LabelPresetAsset.user_id == user_id,
                    )
                )
                == 1
            )

    @pytest.mark.asyncio
    async def test_legacy_json_backup_still_restores(
        self, auth_client, tmp_path, monkeypatch
    ):
        from app.api.v1 import system

        monkeypatch.setattr(system, "_get_backup_dir", lambda: tmp_path)
        client, csrf_token = auth_client
        legacy = json.dumps(
            {
                "metadata": {
                    "export_date": "2026-09-22",
                    "app_version": "test",
                    "schema_version": None,
                },
                "data": {},
            }
        ).encode()

        response = await client.post(
            "/api/v1/admin/system/backup/import",
            files={"file": ("backup.json", legacy, "application/json")},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_inventory_jsonl_round_trip_preserves_users(
        self,
        auth_client,
        db_session,
        db_engine,
        admin_user,
        tmp_path,
        monkeypatch,
    ):
        from app.api.v1 import system
        from app.models import User

        user_id, email = admin_user.id, admin_user.email
        db_session.add(Manufacturer(name="Inventory round trip"))
        await db_session.commit()
        client, csrf_token = auth_client
        exported = await client.get("/api/v1/admin/system/backup/export-inventory?format=jsonl")
        assert exported.status_code == 200
        monkeypatch.setattr(system, "_get_backup_dir", lambda: tmp_path)

        restored = await client.post(
            "/api/v1/admin/system/backup/import-inventory",
            files={
                "file": (
                    "inventory.jsonl",
                    exported.content,
                    "application/x-ndjson",
                )
            },
            headers={"X-CSRF-Token": csrf_token},
        )

        assert restored.status_code == 200
        sessions = async_sessionmaker(db_engine, expire_on_commit=False)
        async with sessions() as fresh_db:
            restored_user = await fresh_db.get(User, user_id)
            assert restored_user is not None
            assert restored_user.email == email
            assert (
                await fresh_db.scalar(
                    select(func.count())
                    .select_from(Manufacturer)
                    .where(Manufacturer.name == "Inventory round trip")
                )
                == 1
            )

    @pytest.mark.asyncio
    async def test_inventory_import_rejects_complete_jsonl(self, auth_client):
        client, csrf_token = auth_client
        content = jsonl_backup(
            {
                "format": "filaman-backup",
                "version": 1,
                "kind": "complete",
                "metadata": {},
            }
        )

        response = await client.post(
            "/api/v1/admin/system/backup/import-inventory",
            files={"file": ("backup.jsonl", content, "application/x-ndjson")},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 422
        assert response.json()["detail"]["code"] == "invalid_backup_structure"

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "records",
        [
            [{"table": "unknown", "row": {}}],
            [
                {"table": "colors", "row": {}},
                {"table": "manufacturers", "row": {}},
            ],
            [{"end": True, "counts": {}}],
            [],
            [
                {"end": True, "counts": {}},
                {"table": "manufacturers", "row": {}},
            ],
        ],
        ids=[
            "unknown-table",
            "reordered-table",
            "count-mismatch",
            "missing-footer",
            "trailing-data",
        ],
    )
    async def test_jsonl_import_rejects_invalid_structure(
        self, auth_client, records, tmp_path, monkeypatch
    ):
        from app.api.v1 import system

        monkeypatch.setattr(system, "_get_backup_dir", lambda: tmp_path)
        client, csrf_token = auth_client
        content = jsonl_backup(
            {
                "format": "filaman-backup",
                "version": 1,
                "kind": "inventory",
                "metadata": {},
            },
            *records,
        )

        response = await client.post(
            "/api/v1/admin/system/backup/import-inventory",
            files={"file": ("backup.jsonl", content, "application/x-ndjson")},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 422
        assert response.json()["detail"]["code"] == "invalid_backup_structure"

    @pytest.mark.asyncio
    async def test_jsonl_import_rejects_oversized_record(
        self, auth_client, tmp_path, monkeypatch
    ):
        from app.api.v1 import system
        from app.services import backup_stream

        client, csrf_token = auth_client
        header = jsonl_backup(
            {
                "format": "filaman-backup",
                "version": 1,
                "kind": "inventory",
                "metadata": {},
            }
        )
        oversized = (
            json.dumps({"table": "manufacturers", "row": {"name": "x" * 5000}}).encode()
            + b"\n"
        )
        monkeypatch.setattr(backup_stream, "MAX_BACKUP_RECORD_BYTES", 4096)
        monkeypatch.setattr(system, "_get_backup_dir", lambda: tmp_path)

        response = await client.post(
            "/api/v1/admin/system/backup/import-inventory",
            files={
                "file": (
                    "backup.jsonl",
                    header + oversized,
                    "application/x-ndjson",
                )
            },
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 422
        assert response.json()["detail"]["code"] == "invalid_backup_structure"

    @pytest.mark.asyncio
    async def test_jsonl_import_rolls_back_when_footer_is_missing(
        self, auth_client, db_session, db_engine, tmp_path, monkeypatch
    ):
        from app.api.v1 import system
        from app.models import Manufacturer

        monkeypatch.setattr(system, "_get_backup_dir", lambda: tmp_path)
        existing = Manufacturer(name="Keep me")
        db_session.add(existing)
        await db_session.commit()
        client, csrf_token = auth_client
        content = jsonl_backup(
            {
                "format": "filaman-backup",
                "version": 1,
                "kind": "inventory",
                "metadata": {},
            },
            {"table": "manufacturers", "row": {"id": 999, "name": "Replacement"}},
        )

        response = await client.post(
            "/api/v1/admin/system/backup/import-inventory",
            files={"file": ("backup.jsonl", content, "application/x-ndjson")},
            headers={"X-CSRF-Token": csrf_token},
        )

        assert response.status_code == 422
        assert response.json()["detail"]["code"] == "invalid_backup_structure"
        sessions = async_sessionmaker(db_engine, expire_on_commit=False)
        async with sessions() as fresh_db:
            names = set((await fresh_db.scalars(select(Manufacturer.name))).all())
        assert "Keep me" in names
        assert "Replacement" not in names

    @pytest.mark.asyncio
    async def test_complete_backup_round_trips_binary_assets_and_references(
        self, db_session, admin_user
    ):
        from app.api.v1.system import _import_all_data

        asset, _ = await create_label_asset(
            db_session, admin_user.id, "backup.png", image_bytes()
        )
        preset = LabelPreset(
            user_id=admin_user.id,
            preset_type="spool",
            name="Backed up image",
            name_key=label_preset_name_key("Backed up image"),
            data=designer_data(asset.id),
        )
        db_session.add(preset)
        await db_session.flush()
        await set_label_preset_asset_references(db_session, preset, {asset.id})
        await db_session.commit()

        exported = await export_backup_data(db_session)
        assert isinstance(exported["label_assets"][0]["content"], str)
        assert exported["label_assets"][0]["content"] != str(asset.content)
        assert exported["label_preset_assets"] == [
            {
                "preset_id": preset.id,
                "asset_id": asset.id,
                "user_id": admin_user.id,
            }
        ]

        await db_session.execute(delete(LabelPresetAsset))
        await db_session.execute(delete(LabelPreset))
        await db_session.execute(delete(LabelAsset))
        await db_session.flush()
        imported = await _import_all_data(
            db_session,
            {
                "label_assets": exported["label_assets"],
                "label_presets": exported["label_presets"],
                "label_preset_assets": exported["label_preset_assets"],
            },
        )

        restored = await db_session.get(LabelAsset, asset.id)
        await db_session.refresh(restored, ["content"])
        assert imported["label_assets"] == 1
        assert imported["label_preset_assets"] == 1
        assert restored.content == asset.content
        assert restored.sha256 == asset.sha256

    @pytest.mark.asyncio
    async def test_backup_accepts_valid_png_from_an_older_encoder(
        self, db_session, admin_user
    ):
        from app.api.v1.system import _import_all_data

        content = image_bytes()
        now = datetime.now(UTC).isoformat()
        await _import_all_data(
            db_session,
            {
                "label_assets": [
                    {
                        "id": "00000000-0000-0000-0000-000000000001",
                        "user_id": admin_user.id,
                        "display_name": "older-encoder.png",
                        "sha256": hashlib.sha256(content).hexdigest(),
                        "media_type": "image/png",
                        "width": 24,
                        "height": 12,
                        "byte_size": len(content),
                        "content": content,
                        "orphaned_at": now,
                        "created_at": now,
                        "updated_at": now,
                    }
                ]
            },
        )

        restored = await db_session.get(
            LabelAsset, "00000000-0000-0000-0000-000000000001"
        )
        await db_session.refresh(restored, ["content"])
        assert restored.content == content

    @pytest.mark.asyncio
    async def test_backup_rebuilds_missing_asset_junctions_from_preset_json(
        self, db_session, admin_user
    ):
        from app.api.v1.system import _import_all_data

        asset, _ = await create_label_asset(
            db_session, admin_user.id, "image.png", image_bytes()
        )
        preset = LabelPreset(
            user_id=admin_user.id,
            preset_type="spool",
            name="Image",
            name_key=label_preset_name_key("Image"),
            data=designer_data(asset.id),
        )
        db_session.add(preset)
        await db_session.flush()
        exported = await export_backup_data(db_session)
        await db_session.execute(delete(LabelPresetAsset))
        await db_session.execute(delete(LabelPreset))
        await db_session.execute(delete(LabelAsset))
        await db_session.flush()

        imported = await _import_all_data(
            db_session,
            {
                "label_assets": exported["label_assets"],
                "label_presets": exported["label_presets"],
                "label_preset_assets": [],
            },
        )

        assert imported["label_preset_assets"] == 1
        assert (
            await db_session.scalar(select(func.count()).select_from(LabelPresetAsset))
            == 1
        )

    @pytest.mark.asyncio
    async def test_backup_rebuilds_asset_junctions_for_nonpositive_preset_ids(
        self, db_session, admin_user
    ):
        from app.api.v1.system import _import_all_data

        asset, _ = await create_label_asset(
            db_session, admin_user.id, "negative-id.png", image_bytes()
        )
        preset = LabelPreset(
            id=-1,
            user_id=admin_user.id,
            preset_type="spool",
            name="Negative id",
            name_key=label_preset_name_key("Negative id"),
            data=designer_data(asset.id),
        )
        db_session.add(preset)
        await db_session.flush()
        exported = await export_backup_data(db_session)
        await db_session.execute(delete(LabelPresetAsset))
        await db_session.execute(delete(LabelPreset))
        await db_session.execute(delete(LabelAsset))
        await db_session.flush()

        imported = await _import_all_data(
            db_session,
            {
                "label_assets": exported["label_assets"],
                "label_presets": exported["label_presets"],
                "label_preset_assets": [],
            },
        )

        assert imported["label_preset_assets"] == 1
        reference = await db_session.scalar(
            select(LabelPresetAsset).where(LabelPresetAsset.preset_id == -1)
        )
        assert reference is not None
        assert reference.asset_id == asset.id

    @pytest.mark.asyncio
    async def test_backup_discards_stale_extra_asset_junctions(
        self, db_session, admin_user
    ):
        from app.api.v1.system import _import_all_data

        used, _ = await create_label_asset(
            db_session,
            admin_user.id,
            "used.png",
            image_bytes(color=(1, 2, 3)),
        )
        unused, _ = await create_label_asset(
            db_session,
            admin_user.id,
            "unused.png",
            image_bytes(color=(4, 5, 6)),
        )
        preset = LabelPreset(
            user_id=admin_user.id,
            preset_type="spool",
            name="Image",
            name_key=label_preset_name_key("Image"),
            data=designer_data(used.id),
        )
        db_session.add(preset)
        await db_session.flush()
        exported = await export_backup_data(db_session)
        stale_reference = {
            "preset_id": preset.id,
            "asset_id": unused.id,
            "user_id": admin_user.id,
        }
        await db_session.execute(delete(LabelPresetAsset))
        await db_session.execute(delete(LabelPreset))
        await db_session.execute(delete(LabelAsset))
        await db_session.flush()

        await _import_all_data(
            db_session,
            {
                "label_assets": exported["label_assets"],
                "label_presets": exported["label_presets"],
                "label_preset_assets": [stale_reference],
            },
        )

        restored_ids = set(
            (await db_session.execute(select(LabelPresetAsset.asset_id))).scalars()
        )
        assert restored_ids == {used.id}

    @pytest.mark.asyncio
    async def test_backup_rejects_preset_json_referencing_missing_asset(
        self, db_session, admin_user
    ):
        from app.api.v1.system import _import_all_data

        asset, _ = await create_label_asset(
            db_session, admin_user.id, "missing.png", image_bytes()
        )
        preset = LabelPreset(
            user_id=admin_user.id,
            preset_type="spool",
            name="Missing image",
            name_key=label_preset_name_key("Missing image"),
            data=designer_data(asset.id),
        )
        db_session.add(preset)
        await db_session.flush()
        exported = await export_backup_data(db_session)
        await db_session.execute(delete(LabelPresetAsset))
        await db_session.execute(delete(LabelPreset))
        await db_session.execute(delete(LabelAsset))
        await db_session.flush()

        with pytest.raises(LabelAssetValidationError, match="not found"):
            await _import_all_data(
                db_session,
                {"label_presets": exported["label_presets"]},
            )

    @pytest.mark.asyncio
    async def test_legacy_backup_without_asset_tables_remains_valid(self, db_session):
        from app.api.v1.system import _import_all_data

        imported = await _import_all_data(db_session, {"label_presets": []})

        assert imported["label_assets"] == 0
        assert imported["label_preset_assets"] == 0

    @pytest.mark.asyncio
    async def test_corrupt_asset_base64_is_rejected(self, db_session, admin_user):
        from app.api.v1.system import _import_all_data

        now = datetime.now(UTC).isoformat()
        with pytest.raises(ValueError, match="base64"):
            await _import_all_data(
                db_session,
                {
                    "label_assets": [
                        {
                            "id": "00000000-0000-0000-0000-000000000001",
                            "user_id": admin_user.id,
                            "display_name": "bad.png",
                            "sha256": "0" * 64,
                            "media_type": "image/png",
                            "width": 1,
                            "height": 1,
                            "byte_size": 1,
                            "content": "%%%not-base64%%%",
                            "orphaned_at": now,
                            "created_at": now,
                            "updated_at": now,
                        }
                    ]
                },
            )

    @pytest.mark.asyncio
    async def test_corrupt_cross_user_asset_reference_is_rejected(self, db_session):
        from app.api.v1.system import _import_all_data

        with pytest.raises(ValueError, match="reference"):
            await _import_all_data(
                db_session,
                {
                    "label_preset_assets": [
                        {
                            "preset_id": 999_999,
                            "asset_id": "00000000-0000-0000-0000-000000000001",
                            "user_id": 999_999,
                        }
                    ]
                },
            )

    @pytest.mark.asyncio
    async def test_backup_reference_validation_uses_database_rows_without_id_sets(
        self, db_session, admin_user
    ):
        from app.api.v1.system import _import_all_data

        asset, _ = await create_label_asset(
            db_session, admin_user.id, "existing.png", image_bytes()
        )
        preset = LabelPreset(
            user_id=admin_user.id,
            preset_type="spool",
            name="Existing",
            name_key=label_preset_name_key("Existing"),
            data=designer_data(asset.id),
        )
        db_session.add(preset)
        await db_session.flush()

        imported = await _import_all_data(
            db_session,
            {
                "label_preset_assets": [
                    {
                        "preset_id": preset.id,
                        "asset_id": asset.id,
                        "user_id": admin_user.id,
                    }
                ]
            },
        )

        assert imported["label_preset_assets"] == 1

    @pytest.mark.asyncio
    async def test_inventory_backup_excludes_label_assets(self, db_session, admin_user):
        await create_label_asset(
            db_session, admin_user.id, "not-in-inventory.png", image_bytes()
        )
        exported = await export_backup_data(db_session, kind="inventory")

        assert "label_assets" not in exported
        assert "label_preset_assets" not in exported
