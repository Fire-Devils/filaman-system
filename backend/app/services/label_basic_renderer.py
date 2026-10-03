"""Small fixed-layout renderer for browserless label installations."""

import re
from io import BytesIO
from math import isfinite
from urllib.parse import urlsplit

import qrcode
from fastapi import HTTPException
from PIL import Image, ImageDraw, ImageFont
from qrcode.exceptions import DataOverflowError

from app.models import Spool
from app.utils.colors import visible_rgb_hex

_MAX_QR_CONTENT = 2048


def label_qr_target(
    link_mode: object,
    template: str,
    fallback: str,
    spool_id: str,
) -> str:
    if link_mode == "url":
        try:
            candidate = urlsplit(template)
            if candidate.scheme in {"http", "https"} and candidate.hostname:
                host = candidate.netloc.rsplit("@", 1)[-1]
                return f"{candidate.scheme}://{host}{candidate.path.rstrip('/')}/spools/{spool_id}"
        except ValueError:
            pass
    return fallback


def render_qr_image(target: str, size: int, mode: str = "RGB") -> Image.Image:
    if len(target) > _MAX_QR_CONTENT:
        raise HTTPException(422, "QR content is too long")
    try:
        return qrcode.make(target).convert(mode).resize(
            (size, size), Image.Resampling.NEAREST
        )
    except (DataOverflowError, ValueError) as exc:
        raise HTTPException(422, "QR content is too long") from exc


def _number(value, default: float, low: float, high: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return min(high, max(low, number)) if isfinite(number) else default


def label_swatch_colors(colors: list[str]) -> list[str]:
    valid_colors = []
    for color in colors:
        try:
            valid_colors.append(visible_rgb_hex(color))
        except ValueError:
            pass
    return valid_colors


def render_basic_label(
    spool: Spool,
    label_width: int,
    label_height: int,
    qr_url: str,
    colors: list[str],
    settings: dict | None = None,
    values: dict[str, str] | None = None,
    logo_content: bytes | None = None,
    colored: bool = False,
) -> Image.Image:
    filament = spool.filament
    display_values = [
        filament.manufacturer.name,
        filament.designation,
        filament.material_type,
        filament.manufacturer_color_name or "",
    ]
    display_text = "".join(display_values)
    if any(
        ord(character) < 32 or 127 <= ord(character) < 160 for character in display_text
    ):
        raise HTTPException(422, "Basic labels support printable text only")

    colors = label_swatch_colors(colors)

    image = Image.new("RGB", (label_width, label_height), "white")
    draw = ImageDraw.Draw(image)

    if settings is not None:
        label = settings.get("label") or {}
        width_mm = _number(label.get("width"), 60, 20, 300)
        margin = max(
            0, round(label_width * _number(label.get("marginMm"), 1, 0, 6) / width_mm)
        )
        if label.get("border") and 2 * margin < min(label_width, label_height):
            draw.rectangle(
                (margin, margin, label_width - margin - 1, label_height - margin - 1),
                outline="black",
                width=2,
            )
        inset = margin + max(4, label_width // 100)
        qr_config = settings.get("qr") or {}
        qr_show = qr_config.get("show", True) is not False
        qr_size = (
            min(
                label_height - inset * 2,
                round(
                    label_width * _number(qr_config.get("sizeMm"), 18, 3, 80) / width_mm
                ),
            )
            if qr_show
            else 0
        )
        qr_left = qr_config.get("position") == "left"
        text_x = inset + qr_size + inset if qr_left and qr_show else inset
        text_width = (
            max(1, label_width - qr_size - inset * 3)
            if qr_show
            else label_width - inset * 2
        )
        token_values = values or {}

        def resolved(template: str) -> str:
            # Match whole tokens first; neither keys nor values are markup.
            return re.sub(
                r"\{([\w.]+)\}|\*{1,3}|==|__|@@",
                lambda match: token_values.get(match[1], "") if match[1] is not None else "",
                template.replace("\\n", "\n"),
            )

        def section(
            config: dict, default: str, fallback_mm: float, bold: bool = False
        ) -> None:
            nonlocal y
            if config.get("show", True) is False:
                return
            template = str(config.get("template", default))[:8000]
            size = max(
                10,
                round(
                    label_width
                    * _number(config.get("sizeMm"), fallback_mm, 1, 20)
                    / width_mm
                ),
            )
            if config.get("dividerAbove"):
                draw.line((text_x, y, text_x + text_width, y), fill="black", width=2)
                y += max(3, size // 4)
            for raw_line in resolved(template).splitlines():
                has_swatch = "{color_swatch" in raw_line
                text_line = re.sub(r"\{color_swatch\[\d+\]\}", "", raw_line).strip()
                font_size = size
                font = ImageFont.load_default(size=font_size)
                if config.get("fitToWidth", True):
                    while (
                        font_size > 10
                        and draw.textlength(text_line, font=font) > text_width
                    ):
                        font_size -= 1
                        font = ImageFont.load_default(size=font_size)
                if draw.textlength(text_line, font=font) > text_width:
                    while (
                        text_line
                        and draw.textlength(text_line + "...", font=font) > text_width
                    ):
                        text_line = text_line[:-1]
                    text_line += "..."
                if text_line:
                    align = config.get("align", config.get("hAlign", "left"))
                    factor = 0.5 if align == "center" else 1 if align == "right" else 0
                    offset = max(
                        0,
                        round(
                            (text_width - draw.textlength(text_line, font=font))
                            * factor
                        ),
                    )
                    draw.text(
                        (text_x + offset, y),
                        text_line,
                        fill="black",
                        font=font,
                        stroke_width=1 if bold else 0,
                    )
                if has_swatch and colors:
                    swatch_y = y + (font_size if text_line else 0)
                    segment = max(1, min(text_width, label_width // 4) // len(colors))
                    for index, hex_code in enumerate(colors):
                        draw.rectangle(
                            (
                                text_x + index * segment,
                                swatch_y,
                                text_x + (index + 1) * segment - 1,
                                swatch_y + max(6, size // 2),
                            ),
                            fill=hex_code if colored else "black",
                        )
                    y = swatch_y + max(6, size // 2)
                else:
                    y += font_size + max(2, size // 6)
                if y >= label_height - inset:
                    break
            if config.get("dividerBelow") and y < label_height - inset:
                draw.line((text_x, y, text_x + text_width, y), fill="black", width=2)
                y += max(3, size // 4)

        y = inset
        logo_config = settings.get("logo") or {}
        if logo_config.get("show", True) and logo_content is not None:
            try:
                with Image.open(BytesIO(logo_content)) as source:
                    logo = source.convert("RGB" if colored else "L").convert("RGB")
                    logo.thumbnail(
                        (
                            text_width,
                            round(
                                label_width
                                * _number(logo_config.get("spaceMm"), 6, 2, 20)
                                / width_mm
                            ),
                        )
                    )
                align = logo_config.get("align", "left")
                offset = (
                    (text_width - logo.width) // (2 if align == "center" else 1)
                    if align in {"center", "right"}
                    else 0
                )
                image.paste(logo, (text_x + offset, y))
                y += logo.height + max(3, label_width // 100)
            except OSError:
                section({"template": "{filament.manufacturer}", "sizeMm": 3}, "", 3)
        section(settings.get("title") or {}, "{filament.name}", 4, True)
        section(settings.get("title2") or {"show": False}, "", 3.5, True)
        section(settings.get("info") or {}, "{filament.type}\n{filament.color}", 2.5)
        section(settings.get("info2") or {"show": False}, "", 2.5)
        if qr_show and qr_size > 0:
            target = label_qr_target(
                qr_config.get("linkMode"),
                resolved(str(qr_config.get("urlTemplate", ""))).strip(),
                qr_url,
                str(spool.id),
            )
            qr = render_qr_image(target, qr_size)
            image.paste(
                qr,
                (
                    inset if qr_left else label_width - qr_size - inset,
                    label_height - qr_size - inset,
                ),
            )
        return image if colored else image.convert("L").convert("RGB")

    margin = max(4, label_width // 40)
    qr_size = label_height // 2
    text_width = label_width - qr_size - margin * 3

    def line(value: str, y: int, size: int) -> int:
        size = max(8, size)
        font = ImageFont.load_default(size=size)
        while size > 8 and draw.textlength(value, font=font) > text_width:
            size -= 1
            font = ImageFont.load_default(size=size)
        if draw.textlength(value, font=font) > text_width:
            while value and draw.textlength(value + "...", font=font) > text_width:
                value = value[:-1]
            value += "..."
        draw.text((margin, y), value, fill="black", font=font)
        return y + size + max(2, label_width // 120)

    y = margin
    y = line(display_values[0], y, label_width // 20)
    y = line(display_values[1], y, label_width // 16)
    y = line(display_values[2], y, label_width // 22)
    if display_values[3]:
        y = line(display_values[3], y, label_width // 24)
    if spool.remaining_weight_g is not None:
        y = line(f"{round(spool.remaining_weight_g)} g remaining", y, label_width // 26)
    if colors:
        swatch_width = min(text_width, label_width // 4)
        segment = max(1, swatch_width // len(colors))
        for index, hex_code in enumerate(colors):
            draw.rectangle(
                (
                    margin + index * segment,
                    y,
                    margin + (index + 1) * segment - 1,
                    y + max(8, label_width // 50),
                ),
                fill=hex_code,
            )

    footer_y = label_height - margin * 3
    draw.line((margin, footer_y, label_width - margin, footer_y), fill="black", width=2)
    draw.text(
        (margin, footer_y + margin),
        f"Spool #{spool.id}",
        fill="black",
        font=ImageFont.load_default(size=max(8, label_width // 35)),
    )
    qr = render_qr_image(qr_url, qr_size)
    image.paste(qr, (label_width - qr_size - margin, margin))
    return image
