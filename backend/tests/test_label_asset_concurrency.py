"""Exercise asset deletion with independently committed preset writes."""

import io
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, cast

import pytest
from app.api.v1.label_assets import delete_label_asset
from app.core.security import Principal
from app.models import Base, LabelAsset, LabelPreset, LabelPresetAsset, User
from app.models.label_preset import label_preset_name_key
from app.services.label_asset_service import (
    cleanup_orphaned_label_assets,
    create_label_asset,
    set_label_preset_asset_references,
)
from fastapi import HTTPException
from PIL import Image
from sqlalchemy import Delete, event, func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["cleanup", "delete"])
async def test_deletion_preserves_a_concurrently_referenced_asset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    # Match production SQLite: distinct connections, foreign keys and WAL.
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'assets.db'}")

    @event.listens_for(engine.sync_engine, "connect")
    def set_pragmas(connection: Any, _record: Any) -> None:
        cursor = connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()

    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with sessions() as seed:
            user = User(email="asset-race@example.com")
            seed.add(user)
            await seed.flush()
            content = io.BytesIO()
            Image.new("RGB", (1, 1)).save(content, format="PNG")
            asset, _ = await create_label_asset(
                seed, user.id, "race.png", content.getvalue()
            )
            asset.orphaned_at = datetime.now(UTC) - timedelta(days=31)
            preset = LabelPreset(
                user_id=user.id,
                preset_type="spool",
                name="Concurrent image",
                name_key=label_preset_name_key("Concurrent image"),
                data={"version": 2, "design": {"version": 2, "elements": []}},
            )
            seed.add(preset)
            await seed.commit()
            asset_id, preset_id, user_id = asset.id, preset.id, user.id

        async def save_reference() -> None:
            async with sessions() as writer:
                saved_preset = await writer.get(LabelPreset, preset_id)
                assert saved_preset is not None
                saved_preset.data = {
                    "version": 2,
                    "design": {
                        "version": 2,
                        "elements": [{"type": "image", "assetId": asset_id}],
                    },
                }
                await set_label_preset_asset_references(
                    writer, saved_preset, {asset_id}
                )
                await writer.commit()

        async with sessions() as deleting:
            original_execute = deleting.execute
            original_delete = deleting.delete
            saved = False

            async def save_before_delete() -> None:
                nonlocal saved
                if not saved:
                    saved = True
                    await save_reference()

            async def execute_with_concurrent_save(
                statement: Any, *args: Any, **kwargs: Any
            ) -> Any:
                if isinstance(statement, Delete):
                    await save_before_delete()
                return await original_execute(statement, *args, **kwargs)

            async def delete_with_concurrent_save(instance: object) -> None:
                await save_before_delete()
                await original_delete(instance)

            # Interpose an actual second transaction just before the DELETE.
            # This catches both stale candidate IDs and stale in-use checks.
            monkeypatch.setattr(deleting, "execute", execute_with_concurrent_save)
            monkeypatch.setattr(deleting, "delete", delete_with_concurrent_save)
            if operation == "cleanup":
                assert await cleanup_orphaned_label_assets(deleting) == 0
                await deleting.commit()
            else:
                with pytest.raises(HTTPException) as rejected:
                    await delete_label_asset(
                        asset_id, deleting, Principal(auth_type="session", user_id=user_id)
                    )
                assert rejected.value.status_code == 409
                assert cast(dict[str, str], rejected.value.detail)["code"] == "label_asset_in_use"
                await deleting.rollback()

        async with sessions() as check:
            retained_asset = await check.get(LabelAsset, asset_id)
            assert retained_asset is not None
            assert retained_asset.orphaned_at is None
            assert await check.scalar(
                select(func.count()).select_from(LabelPresetAsset)
            ) == 1
            retained_preset = await check.get(LabelPreset, preset_id)
            assert retained_preset is not None
            assert retained_preset.data["design"]["elements"][0]["assetId"] == asset_id
    finally:
        await engine.dispose()
