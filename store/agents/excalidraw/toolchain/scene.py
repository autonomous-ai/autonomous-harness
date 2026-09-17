"""Build .excalidraw scenes from Python, so a diagram is a dozen lines instead of a thousand of JSON.

    from scene import Scene
    s = Scene()
    api = s.box(0, 0, "API", color="blue")
    db = s.box(320, 0, "Postgres", color="green", shape="ellipse")
    s.arrow(api, db, "SQL")
    s.title("Order service", 0, -120)
    s.frame([api, db], "Backend")
    s.save("diagram.excalidraw")

Every element carries the fields Excalidraw's own editor writes (schema 2), so the file opens in
excalidraw.com, VS Code's extension and the pane alike. Colours are Excalidraw's palette by name.
"""
from __future__ import annotations
import json, math, random, time
from pathlib import Path

PALETTE = {  # background → stroke, Excalidraw's own swatches
    "blue": ("#a5d8ff", "#1971c2"), "green": ("#b2f2bb", "#2f9e44"), "yellow": ("#ffec99", "#f08c00"),
    "red": ("#ffc9c9", "#e03131"), "purple": ("#d0bfff", "#6741d9"), "pink": ("#eebefa", "#9c36b5"),
    "orange": ("#ffd8a8", "#e8590c"), "teal": ("#96f2d7", "#099268"), "gray": ("#e9ecef", "#495057"),
    "none": ("transparent", "#1e1e1e"),
}
FONT_HAND, FONT_SANS, FONT_MONO = 1, 2, 3


def _id() -> str:
    return "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(20))


def _base(kind: str, x: float, y: float, w: float, h: float, stroke: str, fill: str, **more) -> dict:
    now = int(time.time() * 1000)
    el = {
        "id": _id(), "type": kind, "x": x, "y": y, "width": w, "height": h, "angle": 0,
        "strokeColor": stroke, "backgroundColor": fill, "fillStyle": "solid", "strokeWidth": 2,
        "strokeStyle": "solid", "roughness": 1, "opacity": 100, "groupIds": [], "frameId": None,
        "roundness": {"type": 3} if kind == "rectangle" else ({"type": 2} if kind in ("arrow", "line") else None),
        "seed": random.randint(1, 2**31 - 1), "version": 1, "versionNonce": random.randint(1, 2**31 - 1),
        "isDeleted": False, "boundElements": [], "updated": now, "link": None, "locked": False,
    }
    el.update(more)
    return el


def _text(x: float, y: float, w: float, h: float, text: str, size: int, font: int, color: str, container: str | None = None, align: str = "center") -> dict:
    return _base("text", x, y, w, h, color, "transparent", text=text, fontSize=size, fontFamily=font,
                 textAlign=align, verticalAlign="middle" if container else "top", containerId=container,
                 originalText=text, lineHeight=1.25, baseline=size)


def _measure(text: str, size: int) -> tuple[float, float]:
    lines = text.split("\n")
    return max(len(line) for line in lines) * size * 0.6 + 4, len(lines) * size * 1.25


class Scene:
    """A whiteboard: Excalidraw's own light canvas and ink, which is how its palette was drawn to
    look. Its dark theme is an inversion filter over the canvas, so a scene authored dark would come
    out inverted; the pane shows the file exactly as written, in the light theme."""

    def __init__(self, background: str = "#f8f9fa", dark: bool = False):
        self.elements: list[dict] = []
        self.background = background
        self.dark = dark
        self.ink = "#e9ecef" if dark else "#1e1e1e"

    # ---- nodes ----
    def box(self, x: float, y: float, label: str = "", color: str = "blue", shape: str = "rectangle",
            w: float | None = None, h: float | None = None, size: int = 20, font: int = FONT_HAND) -> dict:
        """A rectangle, ellipse or diamond with a centred label. Returns the shape (use it for arrows)."""
        fill, stroke = PALETTE.get(color, PALETTE["blue"])
        tw, th = _measure(label, size) if label else (0, 0)
        w = w or max(160, tw + 48)
        h = h or max(72, th + 36)
        kind = {"rectangle": "rectangle", "ellipse": "ellipse", "diamond": "diamond"}[shape]
        node = _base(kind, x, y, w, h, stroke, fill)
        if label:
            t = _text(x + (w - tw) / 2, y + (h - th) / 2, tw, th, label, size, font, "#1e1e1e", container=node["id"])
            node["boundElements"].append({"id": t["id"], "type": "text"})
            self.elements += [node, t]
        else:
            self.elements.append(node)
        return node

    def text(self, x: float, y: float, text: str, size: int = 20, font: int = FONT_HAND, color: str | None = None, align: str = "left") -> dict:
        tw, th = _measure(text, size)
        t = _text(x, y, tw, th, text, size, font, color or self.ink, align=align)
        self.elements.append(t)
        return t

    def title(self, text: str, x: float, y: float, size: int = 32) -> dict:
        return self.text(x, y, text, size=size)

    def note(self, x: float, y: float, text: str, color: str = "yellow", w: float = 220) -> dict:
        """A sticky note: a filled box with left-aligned small text."""
        return self.box(x, y, text, color=color, w=w, size=16)

    # ---- edges ----
    def arrow(self, a: dict, b: dict, label: str = "", color: str | None = None, dashed: bool = False, both: bool = False) -> dict:
        """An arrow from the edge of a to the edge of b, bound to both so dragging keeps it attached."""
        ax, ay = a["x"] + a["width"] / 2, a["y"] + a["height"] / 2
        bx, by = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
        sx, sy = _edge(a, bx, by)
        ex, ey = _edge(b, ax, ay)
        el = _base("arrow", sx, sy, ex - sx, ey - sy, color or self.ink, "transparent",
                   points=[[0, 0], [ex - sx, ey - sy]], lastCommittedPoint=None,
                   startBinding={"elementId": a["id"], "focus": 0, "gap": 4},
                   endBinding={"elementId": b["id"], "focus": 0, "gap": 4},
                   startArrowhead="arrow" if both else None, endArrowhead="arrow")
        if dashed:
            el["strokeStyle"] = "dashed"
        a["boundElements"].append({"id": el["id"], "type": "arrow"})
        b["boundElements"].append({"id": el["id"], "type": "arrow"})
        self.elements.append(el)
        if label:
            tw, th = _measure(label, 16)
            mx, my = (sx + ex) / 2, (sy + ey) / 2
            t = _text(mx - tw / 2, my - th / 2, tw, th, label, 16, FONT_HAND, self.ink, container=el["id"])
            el["boundElements"].append({"id": t["id"], "type": "text"})
            self.elements.append(t)
        return el

    # ---- groups ----
    def frame(self, members: list[dict], name: str, pad: float = 32) -> dict:
        """A named frame around the members (and their labels)."""
        ids = {m["id"] for m in members}
        parts = [e for e in self.elements if e["id"] in ids or e.get("containerId") in ids]
        x0 = min(e["x"] for e in parts) - pad
        y0 = min(e["y"] for e in parts) - pad - 8
        x1 = max(e["x"] + e["width"] for e in parts) + pad
        y1 = max(e["y"] + e["height"] for e in parts) + pad
        f = _base("frame", x0, y0, x1 - x0, y1 - y0, "#bbb", "transparent", name=name)
        f["roundness"] = None
        for e in parts:
            e["frameId"] = f["id"]
        self.elements.insert(0, f)
        return f

    # ---- output ----
    def to_dict(self) -> dict:
        return {
            "type": "excalidraw", "version": 2, "source": "https://github.com/autonomous-ai/autonomous-harness/tree/main/store/agents/excalidraw",
            "elements": self.elements,
            "appState": {"viewBackgroundColor": self.background, "gridSize": None, "theme": "dark" if self.dark else "light"},
            "files": {},
        }

    def save(self, path: str | Path = "diagram.excalidraw") -> Path:
        p = Path(path)
        p.write_text(json.dumps(self.to_dict(), indent=1))
        return p


def _edge(el: dict, tx: float, ty: float) -> tuple[float, float]:
    """Where a line from el's centre toward (tx, ty) leaves el's box."""
    cx, cy = el["x"] + el["width"] / 2, el["y"] + el["height"] / 2
    dx, dy = tx - cx, ty - cy
    if dx == 0 and dy == 0:
        return cx, cy
    hw, hh = el["width"] / 2, el["height"] / 2
    if el["type"] == "ellipse":
        ang = math.atan2(dy, dx)
        return cx + hw * math.cos(ang), cy + hh * math.sin(ang)
    sx = hw / abs(dx) if dx else math.inf
    sy = hh / abs(dy) if dy else math.inf
    s = min(sx, sy)
    if el["type"] == "diamond":
        s = 1 / (abs(dx) / hw + abs(dy) / hh)
    return cx + dx * s, cy + dy * s
