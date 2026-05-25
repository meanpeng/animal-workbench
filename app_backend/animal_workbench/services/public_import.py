from __future__ import annotations

import io
import json
import os
import random
import shutil
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from zipfile import ZipFile

import yaml
from PIL import Image

from .dataset_import import import_dataset_folder
from .dataset_jobs import JobReporter
from .public_catalog import PublicDatasetSpec, public_dataset_dir


ENA24_CLASS_NAMES = [
    "Bird",
    "Eastern Gray Squirrel",
    "Eastern Chipmunk",
    "Woodchuck",
    "Wild Turkey",
    "White_Tailed_Deer",
    "Virginia Opossum",
    "Eastern Cottontail",
    "Human",
    "Vehicle",
    "Striped Skunk",
    "Red Fox",
    "Eastern Fox Squirrel",
    "Northern Raccoon",
    "Grey Fox",
    "Horse",
    "Dog",
    "American Crow",
    "Chicken",
    "Domestic Cat",
    "Coyote",
    "Bobcat",
    "American Black Bear",
]


def import_public_dataset(
    conn,
    project_id: int,
    spec: PublicDatasetSpec,
    *,
    source_path: str | None,
    sample_limit: int | None,
    reporter: JobReporter,
) -> dict:
    root = Path(source_path).expanduser().resolve() if source_path else public_dataset_dir(spec.key)
    if not root.exists():
        raise FileNotFoundError(f"公开数据目录不存在: {root}")

    reporter.update(stage="scanning", percent=5, message=f"正在检查 {spec.name} 数据目录")
    if any((root / name).exists() for name in ("dataset.yaml", "data.yaml")):
        return import_dataset_folder(conn, project_id, str(root), name=spec.name, dataset_kind="auto", dataset_type="public", reporter=reporter, skip_copy=True)
    if spec.key not in {"swg", "wcs"} and (root / "images").exists():
        return import_dataset_folder(conn, project_id, str(root), name=spec.name, dataset_kind="auto", dataset_type="public", reporter=reporter, skip_copy=True)

    effective_sample_limit = sample_limit if sample_limit is not None else (spec.default_sample_limit if source_path is None else None)
    materialized = public_dataset_dir(spec.key) / "materialized_yolo"
    if spec.key == "lote":
        materialize_lote(root, materialized, effective_sample_limit, reporter)
    elif spec.key == "ena24":
        materialize_ena24(root, materialized, effective_sample_limit, reporter)
    elif spec.key in {"swg", "wcs"}:
        materialize_lila(root, materialized, effective_sample_limit, reporter)
    else:
        raise ValueError(f"未知公开数据集: {spec.key}")

    return import_dataset_folder(conn, project_id, str(materialized), name=spec.name, dataset_kind="labeled", dataset_type="public", reporter=reporter, skip_copy=True)


def materialize_lote(root: Path, output: Path, limit: int | None, reporter: JobReporter) -> None:
    wild_zip = first_existing(root, ["wild_dataset/wild.zip", "wild.zip"])
    json_zip = first_existing(root, ["corrected_annotations_wild_and_web/json.zip", "json.zip"])
    if wild_zip is None or json_zip is None:
        raise FileNotFoundError("LoTE 需要 wild.zip 和 json.zip。")
    reset_yolo(output)
    with ZipFile(json_zip) as ann_zip, ZipFile(wild_zip) as image_zip:
        ann_members = [name for name in ann_zip.namelist() if name.endswith(".json") and "annotations" in name]
        categories = None
        # Phase 1: Parse annotations and read image data in the main thread.
        write_tasks: list[tuple[Path, bytes, Path, str]] = []  # (target_image, image_bytes, target_label, label_text)
        for ann_member in ann_members:
            split = split_from_name(ann_member)
            data = json.loads(ann_zip.read(ann_member).decode("utf-8"))
            categories = categories or data.get("categories") or []
            anns_by_image = defaultdict(list)
            for ann in data.get("annotations", []):
                anns_by_image[int(ann["image_id"])].append(ann)
            for image in data.get("images", []):
                if limit is not None and len(write_tasks) >= limit:
                    break
                file_name = image["file_name"]
                image_member = f"images/{split}/{file_name}"
                if image_member not in image_zip.namelist():
                    continue
                target_image = output / "images" / split / file_name
                target_label = output / "labels" / split / f"{Path(file_name).stem}.txt"
                image_bytes = image_zip.read(image_member)
                lines = []
                for ann in anns_by_image.get(int(image["id"]), []):
                    box = coco_bbox_to_yolo(ann["bbox"], int(image["width"]), int(image["height"]))
                    if box:
                        class_id = max(0, int(ann["category_id"]) - 1)
                        lines.append(f"{class_id} {box[0]:.6f} {box[1]:.6f} {box[2]:.6f} {box[3]:.6f}")
                write_tasks.append((target_image, image_bytes, target_label, "\n".join(lines)))

        # Phase 2: Write files in parallel.
        def _write_task(task: tuple[Path, bytes, Path, str]) -> None:
            target_image, image_bytes, target_label, label_text = task
            target_image.parent.mkdir(parents=True, exist_ok=True)
            target_label.parent.mkdir(parents=True, exist_ok=True)
            target_image.write_bytes(image_bytes)
            target_label.write_text(label_text, encoding="utf-8")

        total = len(write_tasks)
        with ThreadPoolExecutor(max_workers=max(1, min(8, total))) as pool:
            done = 0
            futures = {pool.submit(_write_task, task): task for task in write_tasks}
            for future in as_completed(futures):
                future.result()  # propagate exceptions
                done += 1
                if done % 50 == 0 or done == total:
                    reporter.update(stage="parsing", percent=10, current=done, total=total, message=f"LoTE 已物化 {done} 张图片")

        names = [str(item.get("name") or item["id"]) for item in (categories or [])]
    write_dataset_yaml(output, names or ["animal"])


def materialize_ena24(root: Path, output: Path, limit: int | None, reporter: JobReporter) -> None:
    try:
        import pyarrow.parquet as pq
    except ImportError as exc:
        raise RuntimeError("导入 ENA24 parquet 需要安装 pyarrow。") from exc
    parquet_files = sorted(root.rglob("*.parquet"))
    if not parquet_files:
        raise FileNotFoundError("没有找到 ENA24 parquet 文件。")
    reset_yolo(output)
    rng = random.Random(42)

    # Phase 1: Parse parquet data and build write tasks.
    write_tasks: list[tuple[Path, bytes, Path, str]] = []
    for parquet_path in parquet_files:
        rows = pq.read_table(parquet_path).to_pylist()
        for row in rows:
            if limit is not None and len(write_tasks) >= limit:
                break
            split = choose_split(rng)
            stem = f"{len(write_tasks):08d}"
            target_image = output / "images" / split / f"{stem}.jpg"
            target_label = output / "labels" / split / f"{stem}.txt"
            image_bytes = row["image"]["bytes"]
            width = int(row.get("width") or 1)
            height = int(row.get("height") or 1)
            objects = row.get("objects") or {}
            bboxes = objects.get("bbox") or []
            categories = objects.get("category") or [0] * len(bboxes)
            lines = []
            for bbox, category in zip(bboxes, categories):
                category = int(category)
                if category in {8, 9}:
                    continue
                box = coco_bbox_to_yolo(bbox, width, height)
                if box:
                    lines.append(f"{category} {box[0]:.6f} {box[1]:.6f} {box[2]:.6f} {box[3]:.6f}")
            write_tasks.append((target_image, image_bytes, target_label, "\n".join(lines)))
        if limit is not None and len(write_tasks) >= limit:
            break

    # Phase 2: Write files in parallel.
    def _write_task(task: tuple[Path, bytes, Path, str]) -> None:
        target_image, image_bytes, target_label, label_text = task
        target_image.parent.mkdir(parents=True, exist_ok=True)
        target_label.parent.mkdir(parents=True, exist_ok=True)
        target_image.write_bytes(image_bytes)
        target_label.write_text(label_text, encoding="utf-8")

    total = len(write_tasks)
    with ThreadPoolExecutor(max_workers=max(1, min(8, total))) as pool:
        done = 0
        futures = {pool.submit(_write_task, task): task for task in write_tasks}
        for future in as_completed(futures):
            future.result()
            done += 1
            if done % 50 == 0 or done == total:
                reporter.update(stage="parsing", percent=10, current=done, total=total, message=f"ENA24 已物化 {done} 张图片")

    write_dataset_yaml(output, ENA24_CLASS_NAMES)


def materialize_lila(root: Path, output: Path, limit: int | None, reporter: JobReporter) -> None:
    json_path = next(root.glob("*.json"), None)
    if json_path is None:
        raise FileNotFoundError("没有找到 LILA COCO JSON。")
    image_base = (root / "image_base_url.txt").read_text(encoding="utf-8").strip() if (root / "image_base_url.txt").exists() else ""
    data = json.loads(json_path.read_text(encoding="utf-8"))
    reset_yolo(output)
    category_by_id = {int(item["id"]): str(item.get("name") or item["id"]) for item in data.get("categories", [])}
    class_names = list(dict.fromkeys(category_by_id.values()))
    class_to_id = {name: index for index, name in enumerate(class_names)}
    anns_by_image = defaultdict(list)
    for ann in data.get("annotations", []):
        if "bbox" in ann:
            anns_by_image[str(ann["image_id"])].append(ann)
    images = [image for image in data.get("images", []) if str(image["id"]) in anns_by_image]
    random.Random(42).shuffle(images)
    local_image_index = {
        path.name: path
        for path in root.rglob("*")
        if path.is_file() and path.suffix.lower() in {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}
    }
    if local_image_index:
        local_images = [image for image in images if any(name in local_image_index for name in lila_image_candidate_names(image))]
        if local_images:
            images = local_images
    if limit is not None:
        images = images[:limit]

    # Phase 1: Download or locate images in parallel.
    def _fetch_image(image: dict) -> tuple[dict, Path | None]:
        return image, find_or_download_lila_image(root, image_base, image, local_image_index)

    fetched: list[tuple[dict, Path | None]] = []
    total = len(images)
    with ThreadPoolExecutor(max_workers=max(1, min(8, total))) as pool:
        futures = {pool.submit(_fetch_image, img): img for img in images}
        done = 0
        for future in as_completed(futures):
            try:
                fetched.append(future.result())
            except Exception:
                fetched.append((futures[future], None))
            done += 1
            if done % 25 == 0 or done == total:
                reporter.update(stage="parsing", percent=10, current=done, total=total, message=f"已下载/查找 {done}/{total} 张公开图片")

    # Phase 2: Generate image links and label text.
    write_tasks: list[tuple[Path, Path, Path, str]] = []
    for image, raw_image in fetched:
        if raw_image is None:
            continue
        split = choose_split(random)
        target_image = output / "images" / split / raw_image.name
        target_label = output / "labels" / split / f"{raw_image.stem}.txt"
        width = int(image.get("width") or Image.open(raw_image).width)
        height = int(image.get("height") or Image.open(raw_image).height)
        lines = []
        for ann in anns_by_image[str(image["id"])]:
            category_name = category_by_id.get(int(ann["category_id"]))
            if category_name is None:
                continue
            box = coco_bbox_to_yolo(ann["bbox"], width, height)
            if box:
                lines.append(f"{class_to_id[category_name]} {box[0]:.6f} {box[1]:.6f} {box[2]:.6f} {box[3]:.6f}")
        write_tasks.append((raw_image, target_image, target_label, "\n".join(lines)))

    # Phase 3: Write files in parallel.
    def _write_task(task: tuple[Path, Path, Path, str]) -> None:
        source_image, target_image, target_label, label_text = task
        link_or_copy(source_image, target_image)
        target_label.parent.mkdir(parents=True, exist_ok=True)
        target_label.write_text(label_text, encoding="utf-8")

    if write_tasks:
        with ThreadPoolExecutor(max_workers=max(1, min(8, len(write_tasks)))) as pool:
            for _ in pool.map(_write_task, write_tasks):
                pass

    write_dataset_yaml(output, class_names or ["animal"])


def lila_image_candidate_names(image: dict) -> list[str]:
    file_name = str(image.get("file_name") or "")
    return list(dict.fromkeys(item for item in [
        Path(file_name).name if file_name else "",
        f"{image.get('id')}.jpg" if image.get("id") else "",
        str(image.get("wcs_id") or ""),
    ] if item))


def find_or_download_lila_image(root: Path, image_base: str, image: dict, local_image_index: dict[str, Path] | None = None) -> Path | None:
    file_name = str(image.get("file_name") or "")
    for name in lila_image_candidate_names(image):
        existing = (local_image_index or {}).get(name)
        if existing:
            return existing
        if local_image_index is None:
            existing = next(root.rglob(name), None)
            if existing:
                return existing
    if not image_base:
        return None
    if not file_name:
        return None
    target_name = Path(file_name).name if file_name else f"{image['id']}.jpg"
    target = root / "images" / target_name
    target.parent.mkdir(parents=True, exist_ok=True)
    url = image_base + urllib.parse.quote(file_name.replace("\\", "/"), safe="/")
    try:
        with urllib.request.urlopen(url, timeout=60) as response:
            target.write_bytes(response.read())
        return target
    except Exception:
        return None


def reset_yolo(output: Path) -> None:
    if output.exists():
        for path in sorted(output.rglob("*"), reverse=True):
            if path.is_file():
                path.unlink()
            elif path.is_dir():
                path.rmdir()
    for split in ("train", "val", "test"):
        (output / "images" / split).mkdir(parents=True, exist_ok=True)
        (output / "labels" / split).mkdir(parents=True, exist_ok=True)


def link_or_copy(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        target.unlink()
    try:
        os.link(source, target)
        return
    except OSError:
        pass
    try:
        target.symlink_to(source)
        return
    except OSError:
        pass
    shutil.copy2(source, target)


def write_dataset_yaml(output: Path, names: list[str]) -> None:
    data = {"path": str(output), "train": "images/train", "val": "images/val", "test": "images/test", "names": names}
    (output / "dataset.yaml").write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")


def first_existing(root: Path, candidates: list[str]) -> Path | None:
    for candidate in candidates:
        path = root / candidate
        if path.exists():
            return path
    return None


def split_from_name(name: str) -> str:
    lowered = name.lower()
    if "val" in lowered:
        return "val"
    if "test" in lowered:
        return "test"
    return "train"


def coco_bbox_to_yolo(bbox, width: int, height: int):
    x, y, w, h = [float(value) for value in bbox[:4]]
    if width <= 0 or height <= 0 or w <= 0 or h <= 0:
        return None
    return (x + w / 2) / width, (y + h / 2) / height, w / width, h / height


def choose_split(rng) -> str:
    value = rng.random()
    if value < 0.8:
        return "train"
    if value < 0.9:
        return "val"
    return "test"
