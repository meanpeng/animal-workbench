from __future__ import annotations

import shutil
import sqlite3
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from ..config import AppPaths, get_paths
from .media import IMAGE_EXTENSIONS, image_dimensions, sha256_file


def register_media_assets_batch(
    conn: sqlite3.Connection,
    project_id: int,
    items: list[tuple[Path, str]],
    paths: AppPaths | None = None,
    reporter: Any | None = None,
    *,
    progress_base: float = 15,
    progress_range: float = 55,
) -> tuple[list[dict[str, Any]], list[str], dict[str, dict[str, Any]], dict[Path, dict[str, Any]]]:
    """Parallel hash + copy + sequential DB insert. Returns (imported, skipped, checksum_to_asset, path_to_asset)."""
    paths = paths or get_paths()
    if not items:
        return [], [], {}, {}

    total = len(items)
    workers = max(1, min(8, total))

    # Phase 1: parallel SHA256 hashing
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

    # Phase 2: DB deduplication
    imported: list[dict[str, Any]] = []
    skipped: list[str] = []
    checksum_to_asset: dict[str, dict[str, Any]] = {}
    to_prepare: list[tuple[Path, str, str]] = []

    for path, source_kind, checksum in hashed:
        if checksum is None:
            skipped.append(str(path))
            continue
        if checksum in checksum_to_asset:
            imported.append(checksum_to_asset[checksum])
            continue
        existing = conn.execute(
            "SELECT * FROM media_assets WHERE project_id = ? AND checksum_sha256 = ?",
            (project_id, checksum),
        ).fetchone()
        if existing:
            asset = dict(existing)
            checksum_to_asset[checksum] = asset
            imported.append(asset)
        else:
            to_prepare.append((path, source_kind, checksum))

    # Phase 3: parallel file copy + dimensions
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
                else:
                    item = futures[future]
                    skipped.append(str(item[0]))
                done += 1
                if reporter and (done % 20 == 0 or done == prep_total):
                    reporter.update_on(
                        conn, stage="copying",
                        percent=progress_base + progress_range * 0.5 + progress_range * 0.3 * done / max(prep_total, 1),
                        current=done, total=prep_total,
                        message=f"已复制文件 {done}/{prep_total}",
                    )

    # Phase 4: sequential DB insert
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
        imported.append(asset)

    # Build path→asset mapping from the hashed list (preserves original path info)
    path_to_asset: dict[Path, dict[str, Any]] = {}
    for path, _source_kind, checksum in hashed:
        if checksum is not None and checksum in checksum_to_asset:
            path_to_asset[path] = checksum_to_asset[checksum]

    return imported, skipped, checksum_to_asset, path_to_asset


def create_annotation_batch(
    conn: sqlite3.Connection,
    project_id: int,
    name: str,
    media_asset_ids: list[int],
) -> dict[str, Any] | None:
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


def batch_insert_annotations(
    conn: sqlite3.Connection,
    project_id: int,
    valid_samples: list,
    class_ids: dict[str, int],
    media_by_path: dict[Path, dict[str, Any]],
) -> tuple[int, int]:
    """Batch insert annotations, skipping duplicates. Returns (saved, skipped)."""
    # Build set of all annotation keys to check
    check_entries: list[tuple[int, int, float, float, float, float]] = []
    for sample in valid_samples:
        media_id = media_by_path[sample.image_path]["id"]
        for box in sample.boxes:
            class_id = class_ids.get(box.class_name)
            if class_id is not None:
                check_entries.append((media_id, class_id, box.x, box.y, box.width, box.height))

    existing_set: set[tuple[int, int, float, float, float, float]] = set()
    if check_entries:
        BATCH_SIZE = 500
        for i in range(0, len(check_entries), BATCH_SIZE):
            batch = check_entries[i:i + BATCH_SIZE]
            conditions = " OR ".join(
                "(media_asset_id = ? AND class_id = ? AND x = ? AND y = ? AND width = ? AND height = ?)"
                for _ in batch
            )
            params: list[Any] = [project_id]
            for entry in batch:
                params.extend(entry)
            rows = conn.execute(
                f"SELECT media_asset_id, class_id, x, y, width, height FROM annotations WHERE project_id = ? AND ({conditions})",
                params,
            ).fetchall()
            for row in rows:
                existing_set.add((row["media_asset_id"], row["class_id"], row["x"], row["y"], row["width"], row["height"]))

    # Filter out existing, prepare new annotations
    new_params: list[tuple[int, int, int, float, float, float, float]] = []
    skipped = 0
    for sample in valid_samples:
        media_id = media_by_path[sample.image_path]["id"]
        for box in sample.boxes:
            class_id = class_ids.get(box.class_name)
            if class_id is None:
                continue
            if (media_id, class_id, box.x, box.y, box.width, box.height) in existing_set:
                skipped += 1
            else:
                new_params.append((project_id, media_id, class_id, box.x, box.y, box.width, box.height))

    if new_params:
        conn.executemany(
            """
            INSERT INTO annotations(project_id, media_asset_id, class_id, x, y, width, height, review_status)
            VALUES(?, ?, ?, ?, ?, ?, ?, 'confirmed')
            """,
            new_params,
        )

    return len(new_params), skipped
