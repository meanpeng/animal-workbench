from __future__ import annotations

import sqlite3
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from ..class_colors import class_color_for_index
from ..config import get_paths
from ..repository import json_dumps
from .datasets import add_media_to_dataset, bind_classes_to_dataset
from .annotation_parsers import ParsedDataset, parse_dataset_folder
from .dataset_jobs import JobReporter
from .common import create_annotation_batch
from .media import IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, iter_importable_files
from .video_utils import cleanup_temp_dirs, extract_video_frames


def import_dataset_folder(
    conn: sqlite3.Connection,
    project_id: int,
    folder: str,
    *,
    name: str | None = None,
    dataset_kind: str = "auto",
    batch_name: str | None = None,
    create_dataset: bool = True,
    dataset_type: str | None = None,
    target_dataset: dict[str, Any] | None = None,
    reporter: JobReporter | None = None,
    extract_frames: bool = False,
) -> dict[str, Any]:
    root = Path(folder).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        raise FileNotFoundError(f"数据集文件夹不存在: {root}")

    if reporter:
        reporter.update_on(conn, stage="scanning", percent=5, message=f"正在扫描 {root}")
    parsed = parse_dataset_folder(root, dataset_kind)
    if parsed is None:
        raise ValueError("没有找到可导入的图片、视频或支持的标注格式。")

    dataset_name = name or root.name
    if parsed.format == "unlabeled":
        return import_unlabeled_folder(
            conn,
            project_id,
            root,
            dataset_name=dataset_name,
            batch_name=batch_name,
            create_dataset=create_dataset,
            dataset_type=dataset_type,
            target_dataset=target_dataset,
            reporter=reporter,
            extract_frames=extract_frames,
        )
    # labeled datasets only handle images (parse_dataset_folder already filters),
    # so extract_frames is irrelevant here
    return import_parsed_labeled_dataset(
        conn,
        project_id,
        root,
        parsed,
        dataset_name=dataset_name,
        create_dataset=create_dataset,
        dataset_type=dataset_type,
        target_dataset=target_dataset,
        reporter=reporter,
    )


def _batch_register_media_assets(
    conn: sqlite3.Connection,
    project_id: int,
    items: list[tuple[Path, str]],
    paths=None,
    reporter: JobReporter | None = None,
    *,
    progress_base: float = 15,
    progress_range: float = 55,
) -> dict[Path, dict[str, Any]]:
    """并行计算哈希 + 复制文件，顺序写入数据库。返回 {source_path: asset_dict}。"""
    if not items:
        return {}
    from .common import register_media_assets_batch
    _imported, _skipped, _checksum_map, path_to_asset = register_media_assets_batch(
        conn, project_id, items, paths, reporter,
        progress_base=progress_base, progress_range=progress_range,
    )
    return path_to_asset


def import_unlabeled_folder(
    conn: sqlite3.Connection,
    project_id: int,
    root: Path,
    *,
    dataset_name: str,
    batch_name: str | None,
    create_dataset: bool = True,
    dataset_type: str | None = None,
    target_dataset: dict[str, Any] | None = None,
    reporter: JobReporter | None,
    extract_frames: bool = False,
) -> dict[str, Any]:
    files = iter_importable_files([str(root)])
    paths = get_paths()

    # Pre-filter: separate images and videos
    image_files = [f for f in files if f.suffix.lower() in IMAGE_EXTENSIONS]
    video_files = [f for f in files if f.suffix.lower() in VIDEO_EXTENSIONS]

    # Build the final list of files to import
    to_import: list[Path] = list(image_files)  # always import images

    # Handle videos — 并行抽帧
    skipped_videos = 0
    video_count = len(video_files)
    if extract_frames and video_count > 0:
        if reporter:
            reporter.update_on(conn, stage="scanning", percent=8, current=0, total=video_count,
                               message=f"扫描完成，正在提取视频帧 (0/{video_count})")
        all_frames: dict[Path, list[Path]] = {}
        with ThreadPoolExecutor(max_workers=max(1, min(4, video_count))) as pool:
            future_to_video = {pool.submit(extract_video_frames, vf): vf for vf in video_files}
            completed = 0
            for future in as_completed(future_to_video):
                vf = future_to_video[future]
                try:
                    all_frames[vf] = future.result()
                except Exception:
                    all_frames[vf] = []
                completed += 1
                if reporter:
                    reporter.update_on(conn, stage="extracting_frames",
                                       percent=8 + 5 * completed / max(video_count, 1),
                                       current=completed, total=video_count,
                                       message=f"正在提取视频帧 ({completed}/{video_count}): {vf.name}")
        for vf in video_files:
            to_import.extend(all_frames.get(vf, []))
    elif not extract_frames:
        skipped_videos = video_count

    total = len(to_import)
    if reporter:
        reporter.update_on(conn, stage="importing_media", percent=15, current=0, total=total,
                           message="正在导入素材")

    # 并行批量注册素材
    items: list[tuple[Path, str]] = []
    for path in to_import:
        source_kind = "frame" if extract_frames and path.suffix.lower() == ".jpg" and path.parent.name.startswith("video_frames_") else "dataset_import"
        items.append((path, source_kind))

    path_to_asset = _batch_register_media_assets(
        conn, project_id, items, paths, reporter,
        progress_base=15, progress_range=55,
    )
    imported = [path_to_asset[path] for path in to_import if path in path_to_asset]

    cleanup_temp_dirs()

    media_ids = [item["id"] for item in imported]
    if target_dataset and target_dataset.get("mode") == "existing":
        dataset = add_media_to_dataset(conn, project_id, int(target_dataset["dataset_id"]), media_ids, commit=False)
        batch = create_annotation_batch(conn, project_id, batch_name or f"{dataset_name} 待标注", media_ids)
    elif target_dataset and target_dataset.get("mode") == "new":
        dataset = create_dataset_record(
            conn,
            project_id,
            str(target_dataset.get("name") or dataset_name),
            dataset_type or "user",
            media_ids,
            {
                "source": "folder",
                "source_path": str(root),
                "annotation_status": "unlabeled",
                "format": "unlabeled",
            },
            {
                "media_count": len(imported),
                "annotation_count": 0,
                "class_count": 0,
                "annotation_status": "unlabeled",
            },
        )
        batch = create_annotation_batch(conn, project_id, batch_name or f"{dataset['name']} 待标注", media_ids)
    elif create_dataset:
        dataset = create_dataset_record(
            conn,
            project_id,
            dataset_name,
            dataset_type or "user",
            media_ids,
            {
                "source": "folder",
                "source_path": str(root),
                "annotation_status": "unlabeled",
                "format": "unlabeled",
            },
            {
                "media_count": len(imported),
                "annotation_count": 0,
                "class_count": 0,
                "annotation_status": "unlabeled",
            },
        )
        batch = create_annotation_batch(conn, project_id, batch_name or f"{dataset_name} 待标注", media_ids)
    else:
        dataset = None
        batch = None
    conn.commit()
    return {
        "dataset": dataset,
        "batch": batch,
        "media_ids": media_ids,
        "linked_media_count": len(media_ids) if dataset else 0,
        "media_count": len(imported),
        "annotation_count": 0,
        "class_count": 0,
        "format": "unlabeled",
    }


def import_parsed_labeled_dataset(
    conn: sqlite3.Connection,
    project_id: int,
    root: Path,
    parsed: ParsedDataset,
    *,
    dataset_name: str,
    create_dataset: bool = True,
    dataset_type: str | None = None,
    target_dataset: dict[str, Any] | None = None,
    reporter: JobReporter | None,
) -> dict[str, Any]:
    if reporter:
        reporter.update_on(conn, stage="parsing", percent=10, current=len(parsed.samples), total=len(parsed.samples), message=f"识别到 {parsed.format} 标注")

    class_ids = {
        class_name: ensure_class(conn, project_id, class_name, index)
        for index, class_name in enumerate(parsed.classes or sorted({box.class_name for sample in parsed.samples for box in sample.boxes}))
    }
    paths = get_paths()
    total_samples = len(parsed.samples)

    # 并行批量注册素材
    items = [(sample.image_path, "dataset_import") for sample in parsed.samples]
    path_to_asset = _batch_register_media_assets(
        conn, project_id, items, paths, reporter,
        progress_base=20, progress_range=35,
    )
    media_by_path: dict[Path, dict[str, Any]] = {}
    for sample in parsed.samples:
        if sample.image_path in path_to_asset:
            media_by_path[sample.image_path] = path_to_asset[sample.image_path]

    valid_samples = [s for s in parsed.samples if s.image_path in media_by_path]
    media_ids = [media_by_path[sample.image_path]["id"] for sample in valid_samples]
    annotation_count = sum(len(sample.boxes) for sample in valid_samples)
    if target_dataset and target_dataset.get("mode") == "existing":
        dataset = add_media_to_dataset(conn, project_id, int(target_dataset["dataset_id"]), list(dict.fromkeys(media_ids)), commit=False)
        bind_classes_to_dataset(conn, project_id, int(dataset["id"]), list(class_ids.values()))
        for sample in valid_samples:
            conn.execute(
                "INSERT OR IGNORE INTO dataset_assets(dataset_id, media_asset_id, split) VALUES(?, ?, ?)",
                (dataset["id"], media_by_path[sample.image_path]["id"], sample.split),
            )
    elif target_dataset and target_dataset.get("mode") == "new":
        dataset = create_dataset_record(
            conn,
            project_id,
            str(target_dataset.get("name") or dataset_name),
            dataset_type or ("public" if root.parts[-2:] and "public" in [part.lower() for part in root.parts] else "user"),
            list(dict.fromkeys(media_ids)),
            {
                "source": "folder",
                "source_path": str(root),
                "annotation_status": "labeled",
                "format": parsed.format,
            },
            {
                "media_count": len(set(media_ids)),
                "annotation_count": annotation_count,
                "class_count": len(class_ids),
                "annotation_status": "labeled",
                "format": parsed.format,
            },
        )
        conn.executemany(
            "INSERT OR IGNORE INTO dataset_assets(dataset_id, media_asset_id, split) VALUES(?, ?, ?)",
            [(dataset["id"], media_by_path[sample.image_path]["id"], sample.split) for sample in valid_samples],
        )
    elif create_dataset:
        dataset = create_dataset_record(
            conn,
            project_id,
            dataset_name,
            dataset_type or ("public" if root.parts[-2:] and "public" in [part.lower() for part in root.parts] else "user"),
            list(dict.fromkeys(media_ids)),
            {
                "source": "folder",
                "source_path": str(root),
                "annotation_status": "labeled",
                "format": parsed.format,
            },
            {
                "media_count": len(set(media_ids)),
                "annotation_count": annotation_count,
                "class_count": len(class_ids),
                "annotation_status": "labeled",
                "format": parsed.format,
            },
        )
        conn.executemany(
            "INSERT OR IGNORE INTO dataset_assets(dataset_id, media_asset_id, split) VALUES(?, ?, ?)",
            [(dataset["id"], media_by_path[sample.image_path]["id"], sample.split) for sample in valid_samples],
        )
    else:
        dataset = None

    if reporter:
        reporter.update_on(conn, stage="saving_annotations", percent=60, current=0, total=annotation_count, message="正在写入标注框")
    from .common import batch_insert_annotations
    saved, skipped_duplicate_annotations = batch_insert_annotations(
        conn, project_id, valid_samples, class_ids, media_by_path,
    )
    if reporter:
        reporter.update_on(
            conn,
            stage="saving_annotations",
            percent=90,
            current=saved,
            total=annotation_count,
            message=f"已写入 {saved}/{annotation_count} 个标注框",
        )
    if dataset:
        bind_classes_to_dataset(conn, project_id, int(dataset["id"]), list(class_ids.values()))
        refresh_dataset_sample_stats(conn, project_id, int(dataset["id"]), parsed.format, "labeled")
        dataset = dict(conn.execute("SELECT * FROM datasets WHERE id = ?", (dataset["id"],)).fetchone())
    conn.commit()
    return {
        "dataset": dataset,
        "media_ids": list(dict.fromkeys(media_ids)),
        "linked_media_count": len(set(media_ids)) if dataset else 0,
        "media_count": len(set(media_ids)),
        "annotation_count": saved,
        "skipped_duplicate_annotations": skipped_duplicate_annotations,
        "class_count": len(class_ids),
        "format": parsed.format,
    }


def ensure_class(conn: sqlite3.Connection, project_id: int, class_name: str, sort_order: int) -> int:
    row = conn.execute(
        "SELECT id FROM classes WHERE project_id = ? AND name = ?",
        (project_id, class_name),
    ).fetchone()
    if row:
        return int(row["id"])
    cursor = conn.execute(
        """
        INSERT INTO classes(project_id, name, display_name, color, sort_order)
        VALUES(?, ?, ?, ?, ?)
        """,
        (project_id, class_name, class_name, class_color_for_index(sort_order), sort_order),
    )
    return int(cursor.lastrowid)


def create_dataset_record(
    conn: sqlite3.Connection,
    project_id: int,
    name: str,
    dataset_type: str,
    media_asset_ids: list[int],
    composition_rule: dict[str, Any],
    sample_stats: dict[str, Any],
) -> dict[str, Any]:
    final_name = unique_dataset_name(conn, project_id, name)
    cursor = conn.execute(
        """
        INSERT INTO datasets(project_id, name, dataset_type, composition_rule, sample_stats)
        VALUES(?, ?, ?, ?, ?)
        """,
        (project_id, final_name, dataset_type, json_dumps(composition_rule), json_dumps(sample_stats)),
    )
    dataset_id = int(cursor.lastrowid)
    if media_asset_ids:
        conn.executemany(
            "INSERT OR IGNORE INTO dataset_assets(dataset_id, media_asset_id, split) VALUES(?, ?, 'unassigned')",
            [(dataset_id, media_id) for media_id in media_asset_ids],
        )
    return dict(conn.execute("SELECT * FROM datasets WHERE id = ?", (dataset_id,)).fetchone())


def refresh_dataset_sample_stats(
    conn: sqlite3.Connection,
    project_id: int,
    dataset_id: int,
    dataset_format: str,
    annotation_status: str,
) -> None:
    row = conn.execute(
        """
        SELECT
            COUNT(DISTINCT da.media_asset_id) AS media_count,
            COUNT(a.id) AS annotation_count
        FROM dataset_assets da
        JOIN media_assets ma ON ma.id = da.media_asset_id AND ma.project_id = ?
        LEFT JOIN annotations a ON a.media_asset_id = da.media_asset_id AND a.project_id = ?
        WHERE da.dataset_id = ?
        """,
        (project_id, project_id, dataset_id),
    ).fetchone()
    conn.execute(
        """
        UPDATE datasets
        SET sample_stats = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND project_id = ?
        """,
        (
            json_dumps(
                {
                    "media_count": int(row["media_count"]),
                    "annotation_count": int(row["annotation_count"]),
                    "class_count": conn.execute(
                        "SELECT COUNT(*) AS cnt FROM dataset_classes WHERE dataset_id = ?",
                        (dataset_id,),
                    ).fetchone()["cnt"],
                    "annotation_status": annotation_status,
                    "format": dataset_format,
                }
            ),
            dataset_id,
            project_id,
        ),
    )


def unique_dataset_name(conn: sqlite3.Connection, project_id: int, name: str) -> str:
    candidate = name.strip() or "导入数据集"
    exists = conn.execute(
        "SELECT 1 FROM datasets WHERE project_id = ? AND name = ? AND version = 1",
        (project_id, candidate),
    ).fetchone()
    if not exists:
        return candidate
    suffix = 2
    while True:
        next_name = f"{candidate} ({suffix})"
        exists = conn.execute(
            "SELECT 1 FROM datasets WHERE project_id = ? AND name = ? AND version = 1",
            (project_id, next_name),
        ).fetchone()
        if not exists:
            return next_name
        suffix += 1


