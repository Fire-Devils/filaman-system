"""Frozen V1 input bridge; geometry mirrors freeform-label/migrate-v1.ts.

This is deliberately not a renderer or a normalizer for existing V2 designs.
Keep original settings for recovery, and never silently replace unknown data.
"""

import copy
import json
import math

_LIMIT = 128 * 1024
_SECTIONS = {"label", "logo", "title", "title2", "info", "info2", "qr"}
_MISSING = object()


def _number(raw, default, low, high):
    # JavaScript Number(null/"") is zero; absent properties use the default.
    try:
        value = 0 if raw is None or isinstance(raw, str) and not raw.strip() else float(raw)
        if not math.isfinite(value):
            value = default
    except (TypeError, ValueError, OverflowError):
        value = default
    return max(low, min(high, value))


def _section(source, name, defaults):
    raw = source.get(name, {})
    result = {}
    bounds = {"sizeMm": (1, 20 if name.startswith("title") else 10),
              "marginMm": (-1, 4), "spaceMm": (2, 20), "manualSizeMm": (2, 20)}
    choices = {"align": ("left", "center", "right"), "hAlign": ("left", "center", "right"),
               "vAlign": ("top", "center", "bottom")}
    for key, default in defaults.items():
        value = raw.get(key, _MISSING)
        if key in bounds:
            result[key] = _number(value, default, *bounds[key])
        elif key in choices:
            result[key] = value if value in choices[key] else default
        else:
            result[key] = value if isinstance(value, type(default)) else default
    return result


def convert_label_preset_data(data: object, preset_type: str) -> object:
    if preset_type not in ("spool", "filament") or not isinstance(data, dict):
        return data
    if "design" in data or ("version" in data and data["version"] != 1):
        return data
    source = data.get("settings", data)
    if not isinstance(source, dict) or not (
        ("settings" in data and not source) or data.get("version") == 1 or _SECTIONS.intersection(source)
    ):
        return data
    if any(not isinstance(source[key], dict) for key in _SECTIONS.intersection(source)):
        return data
    try:
        if len(json.dumps(data, allow_nan=False).encode()) > _LIMIT:
            return data
        result = _convert(source)
        if len(json.dumps(result, allow_nan=False).encode()) > _LIMIT:
            return data
    except (TypeError, ValueError, OverflowError, RecursionError):
        return data
    return result


def _convert(source):
    raw = source.get("label", {})
    width = _number(raw.get("width", _MISSING), 60, 20, 300)
    height = _number(raw.get("height", _MISSING), 40, 10, 200)
    margin_mm = _number(raw.get("marginMm", _MISSING), 1, 0, 6)
    border = raw.get("border") is True
    margin = margin_mm + (0.6 if border else 0)
    content_w = max(3, width - margin * 2)
    logo = _section(source, "logo", {"show": True, "spaceMm": 6, "scaleToFit": True, "manualSizeMm": 6, "align": "left"})
    titles = [_section(source, name, {"show": first, "sizeMm": 4 if first else 3.5,
        "marginMm": 0, "fitToWidth": True, "align": "left", "template": "{filament.name}" if first else "",
        "dividerAbove": False, "dividerBelow": first}) for name, first in (("title", True), ("title2", False))]
    info = _section(source, "info", {"show": True, "sizeMm": 2.5, "marginMm": 0, "hAlign": "left",
        "vAlign": "bottom", "template": "{filament.type}\n{filament.color}\nDiameter: {filament.diameter} mm"})
    info2 = _section(source, "info2", {"show": False, "sizeMm": 2.5, "vsep": False,
        "hAlign": "left", "vAlign": "bottom", "template": ""})
    qr = source.get("qr", {})
    show_qr = qr.get("show") if isinstance(qr.get("show"), bool) else qr.get("mode") != "none"
    mode = qr.get("mode", "logo")
    if mode == "icon":
        mode = "colorLogo" if qr.get("colorLogo") is True else "logo"
    if mode not in ("simple", "logo", "colorLogo"):
        mode = "logo"
    size = _number(qr.get("sizeMm", _MISSING), 18, 8, 40)
    valign = qr.get("vAlign") if qr.get("vAlign") in ("top", "center", "bottom") else "bottom"
    elements = []

    def add(kind, x, y, w, h, **attrs):
        elements.append(dict(id=f"v1-{len(elements) + 1}", type=kind, x=x, y=y,
                             w=w, h=h, z=len(elements), **attrs))

    def divider(y, **attrs):
        add("shape", margin, y, content_w, 25.4 / 96, shape="rectangle", fill="#000000",
            stroke="", strokeWidthMm=0, radiusMm=0, **attrs)
        return y + 25.4 / 96

    def text(x, y, w, h, section, role, **attrs):
        add("text", x, y, w, h, template=section["template"][:8000], fontFamily="Space Grotesk",
            fontSizeMm=section["sizeMm"], fontWeight=700 if role == "title" else 400,
            italic=False, underline=False, color="#000000", wrap=role == "info",
            legacyTextRole=role, **attrs)

    y = margin
    if logo["show"]:
        logo_h = math.floor(logo["spaceMm"] * 3.78 + 0.5) / (96 / 25.4)
        add("manufacturerLogo", margin, y, content_w, logo_h, objectFit="contain",
            align=logo["align"], collapseWhenEmpty=True,
            **({"manualSizeMm": logo["manualSizeMm"]} if not logo["scaleToFit"] else {}))
        y += logo_h + 0.5
    for title in titles:
        if not title["show"] or not title["template"].strip():
            continue
        if title["dividerAbove"]:
            y = divider(y)
        y += title["marginMm"]
        text(margin, y, content_w, title["sizeMm"], title, "title", align=title["align"],
             fitToWidth=title["fitToWidth"], legacyTitleMarginMm=title["marginMm"],
             **({"legacyDividerBelow": True} if title["dividerBelow"] else {}))
        y += title["sizeMm"] + title["marginMm"]
        if title["dividerBelow"]:
            y = divider(y)
    if logo["show"] and not any(t["show"] and t["template"].strip() for t in titles) and titles[0]["dividerBelow"]:
        y = divider(y + 0.5, legacyLogoDivider=True)
    row_y = min(height - margin - 3, y + info["marginMm"])
    row_h = max(3, height - margin - row_y)
    has_info = info["show"] and bool(info["template"].strip())
    has_info2 = info2["show"]
    separator = has_info2 and info2["vsep"]
    slots = (["info"] if has_info else []) + (["separator"] if separator else [])
    slots += (["info2"] if has_info2 else []) + (["qr"] if show_qr else [])
    count = int(has_info) + int(has_info2)
    info_w = max(0, (content_w - (25.4 / 96 if separator else 0) - (size if show_qr else 0)
                    - max(0, len(slots) - 1) * 1.5) / count) if count else 0
    left = qr.get("position") == "left"
    cursor = margin + content_w if left else margin
    positions = {}
    for slot in slots:
        slot_w = size if slot == "qr" else 25.4 / 96 if slot == "separator" else info_w
        if left:
            cursor -= slot_w
        positions[slot] = cursor
        cursor += -1.5 if left else slot_w + 1.5
    if show_qr:
        qr_y = row_y + (row_h - size) * {"top": 0, "center": 0.5, "bottom": 1}[valign]
        add("qr", positions["qr"], qr_y, size, size, mode=mode,
            linkMode="url" if qr.get("linkMode") == "url" else "spool",
            urlTemplate=qr.get("urlTemplate", "")[:8000] if isinstance(qr.get("urlTemplate", ""), str) else "",
            legacyVAlign=valign)
    for slot, section, visible in (("info", info, has_info), ("info2", info2, has_info2)):
        if visible:
            text(positions[slot], row_y, info_w, row_h, section, "info", align=section["hAlign"],
                 verticalAlign="middle" if section["vAlign"] == "center" else section["vAlign"])
    if separator:
        add("shape", positions["separator"], row_y, 25.4 / 96, row_h, shape="rectangle",
            fill="#000000", stroke="", strokeWidthMm=0, radiusMm=0)
    # Only the boxes emitted above need normalization. Do not reinterpret native V2.
    for element in elements:
        kind = element["type"]
        minimum = 0.1 if kind == "shape" else 3
        element["w"] = min(40 if kind == "qr" else width, max(
            0 if element.get("legacyTextRole") == "info" else minimum, element["w"]))
        element["h"] = element["w"] if kind == "qr" else min(height, max(
            0 if kind == "text" else minimum, element["h"]))
        for position, side, limit in (("x", "w", width), ("y", "h", height)):
            overlap = max(0, min(0.1, element[side]))
            element[position] = min(limit - overlap, max(overlap - element[side], element[position]))
    elements.sort(key=lambda element: element["type"] == "qr")
    for z, element in enumerate(elements):
        element["z"] = z
    return {"version": 2, "design": {"version": 2, "label": {"widthMm": width, "heightMm": height,
                "marginMm": margin_mm, "border": border}, "elements": elements}, "legacy_v1": copy.deepcopy(source)}
