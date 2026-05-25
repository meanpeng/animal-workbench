from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml
from PIL import Image

from .media import IMAGE_EXTENSIONS


@dataclass
class ParsedBox:
    class_name: str
    x: float
    y: float
    width: float
    height: float


@dataclass
class ParsedSample:
    image_path: Path
    split: str = "unassigned"
    boxes: list[ParsedBox] = field(default_factory=list)


@dataclass
class ParsedDataset:
    format: str
    classes: list[str]
    samples: list[ParsedSample]


def parse_dataset_folder(root: Path, forced_kind: str = "auto") -> ParsedDataset | None:
    root = root.expanduser().resolve()
    if forced_kind != "unlabeled":
        yolo = parse_yolo_dataset(root)
        if yolo is not None:
            return yolo
        coco = parse_coco_dataset(root)
        if coco is not None:
            return coco
        voc = parse_voc_dataset(root)
        if voc is not None:
            return voc
    if forced_kind == "labeled":
        return None
    samples = [ParsedSample(image_path=path) for path in iter_images(root)]
    return ParsedDataset(format="unlabeled", classes=[], samples=samples) if samples else None


def iter_images(root: Path) -> list[Path]:
    return sorted(
        [path for path in root.rglob("*") if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS],
        key=lambda item: str(item).lower(),
    )


def image_size(path: Path) -> tuple[int, int]:
    with Image.open(path) as image:
        return image.width, image.height


def parse_yolo_dataset(root: Path) -> ParsedDataset | None:
    yaml_path = next((item for item in [root / "dataset.yaml", root / "data.yaml"] if item.exists()), None)
    names: list[str] = []
    samples: list[ParsedSample] = []
    if yaml_path is not None:
        data = yaml.safe_load(yaml_path.read_text(encoding="utf-8")) or {}
        names = normalize_names(data.get("names"))
        base = Path(data.get("path") or yaml_path.parent)
        if not base.is_absolute():
            base = (yaml_path.parent / base).resolve()
        for split in ("train", "val", "test"):
            for image_dir in as_paths(data.get(split), base):
                samples.extend(parse_yolo_image_dir(image_dir, split, names))
    else:
        image_root = root / "images"
        label_root = root / "labels"
        if not image_root.exists() or not label_root.exists():
            return None
        for split_dir in sorted([item for item in image_root.iterdir() if item.is_dir()]):
            samples.extend(parse_yolo_image_dir(split_dir, split_dir.name, names))
        if not samples:
            samples.extend(parse_yolo_image_dir(image_root, "unassigned", names))

    if not samples:
        return None
    max_class_id = -1
    for sample in samples:
        for box in sample.boxes:
            if box.class_name.startswith("class_"):
                try:
                    max_class_id = max(max_class_id, int(box.class_name.removeprefix("class_")))
                except ValueError:
                    pass
    while len(names) <= max_class_id:
        names.append(f"class_{len(names)}")
    return ParsedDataset(format="yolo", classes=names or sorted({box.class_name for sample in samples for box in sample.boxes}), samples=samples)


def parse_yolo_image_dir(image_dir: Path, split: str, names: list[str]) -> list[ParsedSample]:
    samples = []
    if not image_dir.exists():
        return samples
    for image_path in sorted([item for item in image_dir.rglob("*") if item.is_file() and item.suffix.lower() in IMAGE_EXTENSIONS]):
        label_path = yolo_label_path(image_path)
        boxes = []
        if label_path.exists():
            for line in label_path.read_text(encoding="utf-8").splitlines():
                parts = line.split()
                if len(parts) < 5:
                    continue
                try:
                    class_id = int(float(parts[0]))
                    xc, yc, bw, bh = [float(value) for value in parts[1:5]]
                except ValueError:
                    continue
                class_name = names[class_id] if 0 <= class_id < len(names) else f"class_{class_id}"
                boxes.append(ParsedBox(class_name, clamp01(xc - bw / 2), clamp01(yc - bh / 2), clamp01(bw), clamp01(bh)))
        samples.append(ParsedSample(image_path=image_path, split=normalize_split(split), boxes=boxes))
    return samples


def yolo_label_path(image_path: Path) -> Path:
    parts = list(image_path.parts)
    if "images" in parts:
        parts[parts.index("images")] = "labels"
        return Path(*parts).with_suffix(".txt")
    return image_path.parent.parent / "labels" / f"{image_path.stem}.txt"


def parse_coco_dataset(root: Path) -> ParsedDataset | None:
    json_paths = sorted(
        path for path in root.rglob("*.json") if path.is_file() and path.stat().st_size > 0
    )
    # Pre-scan disk once: map filename -> full path
    disk_index: dict[str, Path] = {}
    for p in root.rglob("*"):
        if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS:
            disk_index[p.name] = p
    for json_path in json_paths:
        try:
            data = json.loads(json_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not all(key in data for key in ("images", "annotations", "categories")):
            continue
        category_by_id = {int(item["id"]): str(item.get("name") or item["id"]) for item in data["categories"]}
        annotations_by_image: dict[str, list[dict[str, Any]]] = {}
        for ann in data["annotations"]:
            if "bbox" not in ann:
                continue
            annotations_by_image.setdefault(str(ann["image_id"]), []).append(ann)
        samples = []
        for image in data["images"]:
            file_name = str(image.get("file_name") or "")
            image_path = disk_index.get(Path(file_name).name) if file_name else None
            if image_path is None:
                continue
            width = int(image.get("width") or image_size(image_path)[0])
            height = int(image.get("height") or image_size(image_path)[1])
            boxes = []
            for ann in annotations_by_image.get(str(image["id"]), []):
                box = coco_bbox_to_normalized(ann["bbox"], width, height)
                if box is None:
                    continue
                boxes.append(ParsedBox(category_by_id.get(int(ann["category_id"]), f"class_{ann['category_id']}"), *box))
            samples.append(ParsedSample(image_path=image_path, split=infer_split(image_path), boxes=boxes))
        if samples:
            return ParsedDataset(format="coco", classes=list(dict.fromkeys(category_by_id.values())), samples=samples)
    return None


def resolve_coco_image(root: Path, annotation_dir: Path, file_name: str) -> Path | None:
    candidates = [
        root / file_name,
        annotation_dir / file_name,
        root / "images" / file_name,
        root / Path(file_name).name,
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    name = Path(file_name).name
    matches = list(root.rglob(name))
    return matches[0] if matches else None


def parse_voc_dataset(root: Path) -> ParsedDataset | None:
    xml_paths = sorted(root.rglob("*.xml"))
    samples = []
    class_names: list[str] = []
    for xml_path in xml_paths:
        try:
            tree = ET.parse(xml_path)
        except ET.ParseError:
            continue
        doc = tree.getroot()
        filename = text_of(doc, "filename")
        if not filename:
            continue
        image_path = resolve_coco_image(root, xml_path.parent, filename)
        if image_path is None:
            continue
        width = int(text_of(doc.find("size"), "width") or image_size(image_path)[0])
        height = int(text_of(doc.find("size"), "height") or image_size(image_path)[1])
        boxes = []
        for obj in doc.findall("object"):
            name = text_of(obj, "name") or "object"
            bnd = obj.find("bndbox")
            if bnd is None:
                continue
            try:
                xmin = float(text_of(bnd, "xmin") or 0)
                ymin = float(text_of(bnd, "ymin") or 0)
                xmax = float(text_of(bnd, "xmax") or 0)
                ymax = float(text_of(bnd, "ymax") or 0)
            except ValueError:
                continue
            box = xyxy_to_normalized(xmin, ymin, xmax, ymax, width, height)
            if box is None:
                continue
            boxes.append(ParsedBox(name, *box))
            if name not in class_names:
                class_names.append(name)
        samples.append(ParsedSample(image_path=image_path, split=infer_split(image_path), boxes=boxes))
    return ParsedDataset(format="voc", classes=class_names, samples=samples) if samples else None


def text_of(node: ET.Element | None, child: str) -> str | None:
    if node is None:
        return None
    found = node.find(child)
    if found is None or found.text is None:
        return None
    return found.text.strip()


def normalize_names(value: object) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value]
    if isinstance(value, dict):
        return [str(value[key]) for key in sorted(value, key=lambda item: int(item))]
    return []


def as_paths(value: object, base: Path) -> list[Path]:
    if value is None:
        return []
    items = value if isinstance(value, list) else [value]
    paths = []
    for item in items:
        path = Path(str(item))
        if not path.is_absolute():
            path = base / path
        paths.append(path)
    return paths


def coco_bbox_to_normalized(bbox: list[float], width: int, height: int) -> tuple[float, float, float, float] | None:
    x, y, w, h = [float(value) for value in bbox[:4]]
    if width <= 0 or height <= 0 or w <= 0 or h <= 0:
        return None
    return clamp01(x / width), clamp01(y / height), clamp01(w / width), clamp01(h / height)


def xyxy_to_normalized(xmin: float, ymin: float, xmax: float, ymax: float, width: int, height: int) -> tuple[float, float, float, float] | None:
    w = xmax - xmin
    h = ymax - ymin
    if width <= 0 or height <= 0 or w <= 0 or h <= 0:
        return None
    return clamp01(xmin / width), clamp01(ymin / height), clamp01(w / width), clamp01(h / height)


def normalize_split(value: str) -> str:
    return value if value in {"train", "val", "test"} else "unassigned"


def infer_split(path: Path) -> str:
    parts = {part.lower() for part in path.parts}
    for split in ("train", "val", "test"):
        if split in parts:
            return split
    return "unassigned"


def clamp01(value: float) -> float:
    return max(0.0, min(float(value), 1.0))
