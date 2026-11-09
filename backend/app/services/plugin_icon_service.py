"""Read small, self-contained SVG plugin icons without active content."""

import re
from pathlib import Path
from xml.etree import ElementTree


BUILTIN_ICONS_DIR = Path(__file__).parent.parent / "plugin_icons"
MAX_ICON_BYTES = 4 * 1024
MAX_LEGACY_SVG_BYTES = 64 * 1024
SVG_NAMESPACE = "{http://www.w3.org/2000/svg}"
SVG_ELEMENTS = {"svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "title", "desc"}
SVG_ATTRIBUTES = {
    "viewBox", "width", "height", "fill", "stroke", "stroke-width",
    "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray",
    "stroke-dashoffset", "fill-rule", "clip-rule", "opacity", "fill-opacity",
    "stroke-opacity", "transform", "d", "x", "y", "x1", "y1", "x2", "y2",
    "cx", "cy", "r", "rx", "ry", "points", "preserveAspectRatio",
}


def read_plugin_icon(plugin_dir: Path, icon: str, *, max_bytes: int = MAX_LEGACY_SVG_BYTES) -> bytes:
    """Check SVG paths and contents while preserving the read limit for installed icons."""
    if (
        not isinstance(icon, str)
        or len(icon) > 250
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*\.svg", icon)
        or any(part in ("", ".", "..") for part in icon.split("/"))
        or plugin_dir.is_symlink()
    ):
        raise ValueError("icon must be a relative .svg path within the plugin package")
    path = (plugin_dir / icon).resolve()
    if not path.is_relative_to(plugin_dir.resolve()):
        raise ValueError("icon must stay within the plugin package")
    with path.open("rb") as stream:
        data = stream.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise ValueError(f"icon must be at most {max_bytes // 1024} KiB")
    source = data.decode("utf-8")
    if "<!" in source or re.search(r"<\?(?!xml\s)", source, re.IGNORECASE):
        raise ValueError("icon must not contain declarations, entities or comments")
    try:
        root = ElementTree.fromstring(source)
    except ElementTree.ParseError as error:
        raise ValueError("icon must be valid SVG XML") from error
    if root.tag != SVG_NAMESPACE + "svg":
        raise ValueError("icon must have an SVG root with the SVG namespace")
    for node in root.iter():
        if node.tag not in {SVG_NAMESPACE + tag for tag in SVG_ELEMENTS}:
            raise ValueError("icon contains an unsupported SVG element")
        for attribute, value in node.attrib.items():
            if attribute not in SVG_ATTRIBUTES or re.search(r"url\s*\(|[\\\x00-\x1f]", value, re.IGNORECASE):
                raise ValueError("icon contains an unsupported SVG attribute or reference")
    return data
