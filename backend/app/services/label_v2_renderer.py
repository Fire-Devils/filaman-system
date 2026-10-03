"""Best-effort Pillow renderer for saved version 2 label designs."""

import re
from datetime import date, datetime
from io import BytesIO
from math import ceil, floor, isfinite

from fastapi import HTTPException
from PIL import Image, ImageDraw, ImageFont, ImageOps, UnidentifiedImageError

from app.services.label_basic_renderer import (
    label_qr_target,
    label_swatch_colors,
    render_qr_image,
)


def _range(value: object, minimum: float, maximum: float) -> float:
    if (
        not isinstance(value, (int, float))
        or not isfinite(value)
        or not minimum <= value <= maximum
    ):
        raise HTTPException(
            status_code=422, detail="Preset design has invalid geometry"
        )
    return float(value)


def _mm(value: object, maximum: float) -> float:
    return _range(value, 0, maximum)


def _position(value: object, element_size: float, label_size: float) -> float:
    # Match frontend clampElementPosition, including zero-sized legacy text.
    overlap = min(0.1, element_size)
    return _range(value, overlap - element_size, label_size - overlap)


def _color(value: object, *, allow_empty: bool = False) -> str | None:
    if allow_empty and value == "":
        return None
    if not isinstance(value, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        raise HTTPException(
            status_code=422, detail="Preset design has an invalid color"
        )
    return value


def resolve_v2_text(template: str, values: dict[str, object]) -> str:
    protected: list[str] = []

    def protect(raw: object) -> str:
        def keep(match: re.Match) -> str:
            protected.append(match.group())
            return f"\0{len(protected) - 1}\0"

        return re.sub(
            r"[\0{}]|\*{1,3}|==|__|@@|\^\^|\[/?(?:b|i|size(?:=\d{1,3}%?)?|font(?:=[^\]\n]+)?)\]",
            keep,
            str(raw),
            flags=re.IGNORECASE,
        )

    def value(token: str) -> str:
        key = token.strip()
        missing = object()
        raw = values.get(key, missing)
        date_only = False
        if raw is missing and (match := re.fullmatch(r"(.*)\|date", key, re.IGNORECASE)):
            raw = values.get(match.group(1).strip(), missing)
            date_only = True
        if raw is missing:
            return ""
        if raw is None or raw == "":
            return ""
        if date_only:
            try:
                parsed = raw.date() if isinstance(raw, datetime) else raw
                if not isinstance(parsed, date):
                    parsed = date.fromisoformat(str(raw)[:10])
                raw = parsed.strftime("%x")
            except ValueError:
                pass
        return protect(raw)

    expanded = template.replace("\\n", "\n")
    conditional = re.compile(
        r"\[if=\{([^{}\n]+)\}\]((?:(?!\[if=).)*?)\[/if\]",
        re.IGNORECASE | re.DOTALL,
    )
    while conditional.search(expanded):
        expanded = conditional.sub(
            lambda match: match.group(2) if value(match.group(1)) else "", expanded
        )
    expanded = re.sub(
        r"\{([^{}]*)\{([^{}]+)\}([^{}]*)\}",
        lambda match: (
            match.group(1) + value(match.group(2)) + match.group(3)
            if value(match.group(2))
            else ""
        ),
        expanded,
    )
    expanded = re.sub(r"\{([^{}]+)\}", lambda match: value(match.group(1)), expanded)
    expanded = re.sub(
        r"\^\^([\s\S]*?)\^\^", lambda match: match.group(1).upper(), expanded
    )
    expanded = re.sub(
        r"\[/?(?:b|i|size(?:=\d{1,3}%?)?|font(?:=[^\]\n]+)?)\]",
        "",
        expanded,
        flags=re.IGNORECASE,
    )
    expanded = re.sub(r"\*{1,3}|==|__|@@", "", expanded)
    return re.sub(r"\0(\d+)\0", lambda match: protected[int(match.group(1))], expanded)


def render_v2_label(
    design: dict,
    width: int,
    values: dict[str, str],
    colors: list[str],
    qr_url: str,
    logo_content: bytes | None,
    assets: dict[str, bytes],
    colored: bool,
) -> Image.Image:
    label = design.get("label")
    elements = design.get("elements")
    if (
        design.get("version") != 2
        or not isinstance(label, dict)
        or not isinstance(elements, list)
        or len(elements) > 100
    ):
        raise HTTPException(status_code=422, detail="Preset design is invalid")
    width_mm = _mm(label.get("widthMm"), 300)
    height_mm = _mm(label.get("heightMm"), 200)
    if width_mm < 20 or height_mm < 10:
        raise HTTPException(
            status_code=422, detail="Preset design has invalid dimensions"
        )
    scale = width / width_mm
    height = round(height_mm * scale)
    if height > 2048:
        raise HTTPException(
            status_code=422, detail="Preset is too tall for the requested width"
        )
    image = Image.new("RGB", (width, height), "white")
    colors = label_swatch_colors(colors)
    draw = ImageDraw.Draw(image)
    if label.get("border"):
        inset = round(_mm(label.get("marginMm", 0), 6) * scale)
        if 2 * inset < min(width, height):
            draw.rectangle(
                (inset, inset, width - inset - 1, height - inset - 1),
                outline="black",
                width=max(1, round(0.3 * scale)),
            )

    if any(
        not isinstance(item, dict) or not isinstance(item.get("z", 0), int)
        for item in elements
    ):
        raise HTTPException(
            status_code=422, detail="Preset design has an invalid element"
        )
    for element in sorted(elements, key=lambda item: item.get("z", 0)):
        if element.get("type") not in {
            "text",
            "qr",
            "manufacturerLogo",
            "image",
            "swatch",
            "shape",
        }:
            raise HTTPException(
                status_code=422, detail="Preset design has an unsupported element"
            )
        # Migrated QR boxes may overhang short labels; Pillow clips the paste.
        legacy_qr = element["type"] == "qr" and element.get("legacyVAlign") in ("top", "center", "bottom")
        w_mm = _mm(element.get("w"), 40 if legacy_qr else width_mm)
        h_mm = _mm(element.get("h"), 40 if legacy_qr else height_mm)
        x = round(_position(element.get("x"), w_mm, width_mm) * scale)
        y = round(_position(element.get("y"), h_mm, height_mm) * scale)
        w = max(1, round(w_mm * scale))
        h = max(1, round(h_mm * scale))
        layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        painter = ImageDraw.Draw(layer)
        kind = element["type"]
        if kind == "shape":
            fill = _color(element.get("fill", ""), allow_empty=True)
            stroke = _color(element.get("stroke", ""), allow_empty=True)
            line_width = round(_mm(element.get("strokeWidthMm", 0), 10) * scale)
            shape = element.get("shape")
            if shape == "line":
                if stroke and line_width:
                    painter.line((0, h // 2, w, h // 2), fill=stroke, width=line_width)
            elif shape in {"rectangle", "square", "circle"}:
                box = (0, 0, w - 1, h - 1)
                if shape == "circle":
                    painter.ellipse(box, fill=fill, outline=stroke, width=line_width)
                else:
                    radius = round(
                        _mm(element.get("radiusMm", 0), min(width_mm, height_mm))
                        * scale
                    )
                    painter.rounded_rectangle(
                        box, radius=radius, fill=fill, outline=stroke, width=line_width
                    )
            else:
                raise HTTPException(
                    status_code=422, detail="Preset design has an unsupported shape"
                )
        elif kind == "swatch":
            if colors:
                for index, color in enumerate(colors):
                    painter.rectangle(
                        (
                            index * w // len(colors),
                            0,
                            (index + 1) * w // len(colors),
                            h,
                        ),
                        fill=color,
                    )
        elif kind == "text":
            content = resolve_v2_text(str(element.get("template", ""))[:8000], values)
            font_size = max(1, round(_mm(element.get("fontSizeMm", 3.2), 20) * scale))
            font = ImageFont.load_default(size=font_size)
            if element.get("fitToWidth"):
                while font_size > 2 and any(
                    painter.textlength(line, font=font) > w
                    for line in content.splitlines()
                ):
                    font_size -= 1
                    font = ImageFont.load_default(size=font_size)
            align = element.get("align", "left")
            for line_number, line in enumerate(content.splitlines() or [""]):
                line_y = line_number * round(font_size * 1.15)
                if line_y >= h:
                    break
                line_width = painter.textlength(line, font=font)
                line_x = max(
                    0,
                    round(
                        (w - line_width)
                        * (0.5 if align == "center" else 1 if align == "right" else 0)
                    ),
                )
                painter.text(
                    (line_x, line_y),
                    line,
                    font=font,
                    fill=_color(element.get("color", "#000000")),
                )
        elif kind == "qr":
            target = label_qr_target(
                element.get("linkMode"),
                str(element.get("urlTemplate", "")),
                qr_url,
                values["id"],
            )
            qr = render_qr_image(target, min(w, h), "RGBA")
            layer.paste(qr, (0, 0))
        elif kind in {"manufacturerLogo", "image"}:
            source = (
                logo_content
                if kind == "manufacturerLogo"
                else assets.get(str(element.get("assetId", "")))
            )
            if kind == "image" and source is None:
                raise HTTPException(
                    status_code=422, detail="Preset image is unavailable"
                )
            try:
                if source is not None:
                    with Image.open(BytesIO(source)) as original:
                        picture = original.convert("RGBA")
                    crop = element.get("crop")
                    if isinstance(crop, dict):
                        cx, cy, cw, ch = (
                            _mm(crop.get(key), 1) for key in ("x", "y", "w", "h")
                        )
                        if cw <= 0 or ch <= 0 or cx + cw > 1 or cy + ch > 1:
                            raise HTTPException(
                                status_code=422, detail="Preset image crop is invalid"
                            )
                        left, top = (
                            floor(cx * picture.width),
                            floor(cy * picture.height),
                        )
                        right = max(left + 1, ceil((cx + cw) * picture.width))
                        bottom = max(top + 1, ceil((cy + ch) * picture.height))
                        picture = picture.crop((left, top, right, bottom))
                    picture = ImageOps.contain(
                        picture,
                        (w, h),
                        Image.Resampling.LANCZOS,
                    )
                    layer.paste(
                        picture, ((w - picture.width) // 2, (h - picture.height) // 2)
                    )
            except (OSError, UnidentifiedImageError):
                if kind == "image":
                    raise HTTPException(
                        status_code=422, detail="Preset image is unavailable"
                    ) from None
        image.paste(layer, (x, y), layer)
    return image if colored else image.convert("L").convert("RGB")
