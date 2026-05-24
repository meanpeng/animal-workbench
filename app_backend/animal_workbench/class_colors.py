from __future__ import annotations

CLASS_COLORS = [
    "#2979ff",
    "#ff6d00",
    "#d500f9",
    "#00c853",
    "#ff1744",
    "#00b8d4",
    "#ffab00",
    "#651fff",
    "#76ff03",
    "#f50057",
    "#00e5ff",
    "#c6ff00",
]

DEFAULT_CLASSES = [
    ("animal", "动物", CLASS_COLORS[0]),
    ("bird", "鸟类", CLASS_COLORS[1]),
    ("mammal", "兽类", CLASS_COLORS[2]),
]

OLD_CLASS_COLORS = {
    "#0f766e",
    "#2563eb",
    "#b45309",
    "#7c3aed",
    "#be123c",
    "#15803d",
    "#0369a1",
    "#a16207",
}


def class_color_for_index(index: int) -> str:
    return CLASS_COLORS[index % len(CLASS_COLORS)]
