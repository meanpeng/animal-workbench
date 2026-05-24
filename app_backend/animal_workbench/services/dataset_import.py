from __future__ import annotations

import shutil
import sqlite3
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from ..class_colors import class_color_for_index
from ..config import AppPaths, get_paths
from ..repository import json_dumps
from .datasets import add_media_to_dataset, bind_classes_to_dataset
from .annotation_parsers import ParsedDataset, parse_dataset_folder
from .dataset_jobs import JobReporter
from .media import IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, image_dimensions, iter_importable_files, sha256_file
from .video_utils import extract_video_frames


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
    paths: AppPaths,
    reporter: JobReporter | None = None,
    *,
    progress_base: float = 15,
    progress_range: float = 55,
) -> dict[Path, dict[str, Any]]:
    """Hash and copy files in parallel, then return assets by source path."""
    if not items:
        return {}

    total = len(items)
    workers = max(1, min(8, total))

    # Phase 1: Compute SHA256 hashes in parallel.
    def _hash(item: tuple[Path, str]) -> tuple[Path, str, str | None]:
        path, kind = item
        try:
            return path, kind, sha256_file(path)
        except Exception:
            return path, kind, None

    hashed: list[tuple[Path, str, str | None]] = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_hash, item): item for item in items}
        done = 0
        for future in as_completed(futures):
            hashed.append(future.result())
            done += 1
            if reporter and (done % 20 == 0 or done == total):
                reporter.update_on(
                    conn, stage="hashing",
                    percent=progress_base + progress_range * 0.3 * done / max(total, 1),
                    current=done, total=total,
                    message=f"已计算文件哈希 {done}/{total}",
                )

    # Phase 2: Check the database for duplicates.
    path_to_asset: dict[Path, dict[str, Any]] = {}
    checksum_to_asset: dict[str, dict[str, Any]] = {}
    to_prepare: list[tuple[Path, str, str]] = []

    for path, source_kind, checksum in hashed:
        if checksum is None:
            continue
        if checksum in checksum_to_asset:
            path_to_asset[path] = checksum_to_asset[checksum]
            continue
        existing = conn.execute(
            "SELECT * FROM media_assets WHERE project_id = ? AND checksum_sha256 = ?",
            (project_id, checksum),
        ).fetchone()
        if existing:
            asset = dict(existing)
            checksum_to_asset[checksum] = asset
            path_to_asset[path] = asset
        else:
            to_prepare.append((path, source_kind, checksum))

    # Phase 3: Copy files and read dimensions in parallel.
    def _prepare(item: tuple[Path, str, str]) -> tuple[Path, str, str, str, int | None, int | None, str] | None:
        path, source_kind, checksum = item
        try:
            suffix = path.suffix.lower()
            width, height = image_dimensions(path)
            storage_dir = paths.media_dir / checksum[:2] / checksum[2:4]
            storage_dir.mkdir(parents=True, exist_ok=True)
            internal_path = storage_dir / f"{uuid.uuid4().hex}{suffix}"
            shutil.copy2(path, internal_path)
            return path, source_kind, checksum, suffix, width, height, str(internal_path)
        except Exception:
            return None

    prepared: list[tuple[Path, str, str, str, int | None, int | None, str]] = []
    if to_prepare:
        prep_total = len(to_prepare)
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(_prepare, item): item for item in to_prepare}
            done = 0
            for future in as_completed(futures):
                result = future.result()
                if result is not None:
                    prepared.append(result)
                done += 1
                if reporter and (done % 20 == 0 or done == prep_total):
                    reporter.update_on(
                        conn, stage="copying",
                        percent=progress_base + progress_range * 0.5 + progress_range * 0.3 * done / max(prep_total, 1),
                        current=done, total=prep_total,
                        message=f"已复制文件 {done}/{prep_total}",
                    )

    # Phase 4: Write database rows sequentially.
    for path, source_kind, checksum, suffix, width, height, internal_path in prepared:
        media_type = "image" if suffix in IMAGE_EXTENSIONS else "video"
        cursor = conn.execute(
            """
            INSERT INTO media_assets(
              project_id, media_type, original_name, source_kind,
              width, height, checksum_sha256, internal_path
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (project_id, media_type, path.name, source_kind, width, height, checksum, internal_path),
        )
        asset = dict(conn.execute("SELECT * FROM media_assets WHERE id = ?", (cursor.lastrowid,)).fetchone())
        checksum_to_asset[checksum] = asset
        path_to_asset[path] = asset

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

    # Handle videos by extracting frames in parallel.
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

    # Register media in bulk.
    items: list[tuple[Path, str]] = []
    for path in to_import:
        source_kind = "frame" if extract_frames and path.suffix.lower() == ".jpg" and path.parent.name.startswith("video_frames_") else "dataset_import"
        items.append((path, source_kind))

    path_to_asset = _batch_register_media_assets(
        conn, project_id, items, paths, reporter,
        progress_base=15, progress_range=55,
    )
    imported = [path_to_asset[path] for path in to_import if path in path_to_asset]

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

    # Register media in bulk.
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

    saved = 0
    skipped_duplicate_annotations = 0
    if reporter:
        reporter.update_on(conn, stage="saving_annotations", percent=60, current=0, total=annotation_count, message="正在写入标注框")
    for sample in valid_samples:
        media_id = media_by_path[sample.image_path]["id"]
        for box in sample.boxes:
            class_id = class_ids.get(box.class_name)
            if class_id is None:
                continue
            existing = conn.execute(
                """
                SELECT id
                FROM annotations
                WHERE project_id = ?
                  AND media_asset_id = ?
                  AND class_id = ?
                  AND x = ?
                  AND y = ?
                  AND width = ?
                  AND height = ?
                """,
                (project_id, media_id, class_id, box.x, box.y, box.width, box.height),
            ).fetchone()
            if existing:
                skipped_duplicate_annotations += 1
            else:
                conn.execute(
                    """
                    INSERT INTO annotations(project_id, media_asset_id, class_id, x, y, width, height, review_status)
                    VALUES(?, ?, ?, ?, ?, ?, ?, 'confirmed')
                    """,
                    (project_id, media_id, class_id, box.x, box.y, box.width, box.height),
                )
                saved += 1
            if reporter and (saved == annotation_count or saved % 100 == 0):
                reporter.update_on(
                    conn,
                    stage="saving_annotations",
                    percent=60 + 30 * saved / max(annotation_count, 1),
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


def register_media_asset(
    conn: sqlite3.Connection,
    project_id: int,
    source_path: Path,
    paths: AppPaths,
    *,
    source_kind: str,
) -> dict[str, Any]:
    checksum = sha256_file(source_path)
    existing = conn.execute(
        "SELECT * FROM media_assets WHERE project_id = ? AND checksum_sha256 = ?",
        (project_id, checksum),
    ).fetchone()
    if existing:
        return dict(existing)

    suffix = source_path.suffix.lower()
    media_type = "image" if suffix in IMAGE_EXTENSIONS else "video"
    width, height = image_dimensions(source_path)
    storage_dir = paths.media_dir / checksum[:2] / checksum[2:4]
    storage_dir.mkdir(parents=True, exist_ok=True)
    internal_path = storage_dir / f"{uuid.uuid4().hex}{suffix}"
    shutil.copy2(source_path, internal_path)
    cursor = conn.execute(
        """
        INSERT INTO media_assets(
          project_id, media_type, original_name, source_kind,
          width, height, checksum_sha256, internal_path
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (project_id, media_type, source_path.name, source_kind, width, height, checksum, str(internal_path)),
    )
    return dict(conn.execute("SELECT * FROM media_assets WHERE id = ?", (cursor.lastrowid,)).fetchone())


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


def create_annotation_batch(conn: sqlite3.Connection, project_id: int, name: str, media_asset_ids: list[int]) -> dict[str, Any] | None:
    if not media_asset_ids:
        return None
    cursor = conn.execute(
        """
        INSERT INTO annotation_batches(project_id, name, status, total_items)
        VALUES(?, ?, 'open', ?)
        """,
        (project_id, name, len(media_asset_ids)),
    )
    batch_id = int(cursor.lastrowid)
    conn.executemany(
        "INSERT OR IGNORE INTO annotation_batch_items(batch_id, media_asset_id) VALUES(?, ?)",
        [(batch_id, media_id) for media_id in media_asset_ids],
    )
    return dict(conn.execute("SELECT * FROM annotation_batches WHERE id = ?", (batch_id,)).fetchone())
