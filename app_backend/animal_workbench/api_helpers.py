from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import HTTPException

from .config import get_paths
from .repository import json_loads
from .services.datasets import refresh_dataset_counts


def _cleanup_orphan_media(conn, project_id: int) -> tuple[int, int]:
    """Delete media files and rows not referenced by any dataset/annotation/prediction."""
    import os
    from .config import get_paths
    media_dir = str(get_paths().media_dir.resolve())
    orphans = conn.execute(
        """
        SELECT m.id, m.internal_path
        FROM media_assets m
        WHERE m.project_id = ?
          AND m.id NOT IN (SELECT DISTINCT media_asset_id FROM dataset_assets)
          AND m.id NOT IN (SELECT DISTINCT media_asset_id FROM annotations)
          AND m.id NOT IN (SELECT DISTINCT media_asset_id FROM annotation_batch_items)
          AND m.id NOT IN (SELECT DISTINCT media_asset_id FROM predictions)
          AND m.id NOT IN (SELECT DISTINCT parent_asset_id FROM media_assets WHERE parent_asset_id IS NOT NULL)
        """,
        (project_id,),
    ).fetchall()

    deleted_files = 0
    deleted_rows = 0
    for row in orphans:
        path = row["internal_path"]
        # Only delete files that are inside managed storage, not externally referenced.
        if path and os.path.isfile(path) and os.path.abspath(path).startswith(media_dir):
            try:
                os.remove(path)
                deleted_files += 1
            except OSError:
                pass
        conn.execute("DELETE FROM media_assets WHERE id = ?", (row["id"],))
        deleted_rows += 1

    return deleted_rows, deleted_files


def _cleanup_public_dataset_cache(dataset: dict) -> bool:
    if dataset.get("dataset_type") != "public":
        return False
    composition = json_loads(dataset.get("composition_rule"), {})
    source_path = composition.get("source_path")
    if not source_path:
        return False

    paths = get_paths()
    try:
        materialized = Path(source_path).resolve()
        public_root = paths.public_data_dir.resolve()
        relative = materialized.relative_to(public_root)
    except (OSError, ValueError):
        return False

    if relative.name != "materialized_yolo" or len(relative.parts) != 2:
        return False
    if materialized.exists() and materialized.is_dir():
        shutil.rmtree(materialized)
        return True
    return False

def require_media_asset(conn, project_id: int, media_asset_id: int) -> None:
    row = conn.execute(
        "SELECT id FROM media_assets WHERE id = ? AND project_id = ?",
        (media_asset_id, project_id),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Media asset not found.")


def require_dataset_class(conn, project_id: int, dataset_id: int, class_id: int) -> None:
    require_dataset_classes(conn, project_id, dataset_id, [class_id])


def require_dataset_classes(conn, project_id: int, dataset_id: int, class_ids: list[int]) -> None:
    unique_ids = list(dict.fromkeys(class_ids))
    if not unique_ids:
        return
    placeholders = ",".join("?" for _ in unique_ids)
    rows = conn.execute(
        f"""
        SELECT dc.class_id
        FROM dataset_classes dc
        JOIN datasets d ON d.id = dc.dataset_id
        JOIN classes cl ON cl.id = dc.class_id
        WHERE dc.dataset_id = ? AND d.project_id = ? AND cl.project_id = ?
          AND dc.class_id IN ({placeholders})
        """,
        (dataset_id, project_id, project_id, *unique_ids),
    ).fetchall()
    owned = {int(row["class_id"]) for row in rows}
    missing = [class_id for class_id in unique_ids if class_id not in owned]
    if missing:
        raise HTTPException(status_code=422, detail=f"Classes do not belong to this dataset: {missing}")


def require_media_in_dataset(conn, project_id: int, dataset_id: int, media_asset_id: int) -> None:
    row = conn.execute(
        """
        SELECT ma.id
        FROM dataset_assets da
        JOIN datasets d ON d.id = da.dataset_id
        JOIN media_assets ma ON ma.id = da.media_asset_id
        WHERE da.dataset_id = ? AND da.media_asset_id = ? AND d.project_id = ? AND ma.project_id = ?
        """,
        (dataset_id, media_asset_id, project_id, project_id),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Media asset is not in this dataset.")


def require_dataset(conn, project_id: int, dataset_id: int) -> None:
    row = conn.execute(
        "SELECT id FROM datasets WHERE id = ? AND project_id = ?",
        (dataset_id, project_id),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Dataset not found.")


def require_media_assets(conn, project_id: int, media_asset_ids: list[int]) -> None:
    unique_ids = list(dict.fromkeys(media_asset_ids))
    if not unique_ids:
        return
    _CHUNK = 500
    owned: set[int] = set()
    for ci in range(0, len(unique_ids), _CHUNK):
        chunk = unique_ids[ci : ci + _CHUNK]
        placeholders = ",".join("?" for _ in chunk)
        rows = conn.execute(
            f"SELECT id FROM media_assets WHERE project_id = ? AND id IN ({placeholders})",
            (project_id, *chunk),
        ).fetchall()
        owned |= {int(row["id"]) for row in rows}
    missing = [media_id for media_id in unique_ids if media_id not in owned]
    if missing:
        raise HTTPException(status_code=422, detail=f"Media assets do not belong to the current project: {missing}")


def dataset_ids_for_media(conn, project_id: int, media_asset_id: int) -> list[int]:
    rows = conn.execute(
        """
        SELECT d.id
        FROM datasets d
        JOIN dataset_assets da ON da.dataset_id = d.id
        WHERE d.project_id = ? AND da.media_asset_id = ?
        """,
        (project_id, media_asset_id),
    ).fetchall()
    return [int(row["id"]) for row in rows]


def sync_annotation_dependents(conn, project_id: int, media_asset_id: int, dataset_ids: list[int] | None = None) -> None:
    for dataset_id in list(dict.fromkeys(dataset_ids or dataset_ids_for_media(conn, project_id, media_asset_id))):
        refresh_dataset_counts(conn, project_id, dataset_id)

    batch_rows = conn.execute(
        """
        SELECT DISTINCT ab.id
        FROM annotation_batches ab
        JOIN annotation_batch_items abi ON abi.batch_id = ab.id
        WHERE ab.project_id = ? AND abi.media_asset_id = ?
        """,
        (project_id, media_asset_id),
    ).fetchall()
    batch_ids = [int(row["id"]) for row in batch_rows]
    if not batch_ids:
        return

    placeholders = ",".join("?" for _ in batch_ids)
    conn.execute(
        f"""
        UPDATE annotation_batch_items
        SET status = CASE
            WHEN EXISTS (
                SELECT 1
                FROM annotations a
                WHERE a.project_id = ? AND a.media_asset_id = annotation_batch_items.media_asset_id
            )
            THEN 'reviewed'
            ELSE 'pending'
        END,
        updated_at = CURRENT_TIMESTAMP
        WHERE media_asset_id = ? AND batch_id IN ({placeholders})
        """,
        (project_id, media_asset_id, *batch_ids),
    )
    for batch_id in batch_ids:
        counts = conn.execute(
            """
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'reviewed' THEN 1 ELSE 0 END) AS completed
            FROM annotation_batch_items
            WHERE batch_id = ?
            """,
            (batch_id,),
        ).fetchone()
        total = int(counts["total"])
        completed = int(counts["completed"] or 0)
        status = "completed" if total > 0 and completed >= total else "in_progress" if completed > 0 else "open"
        conn.execute(
            """
            UPDATE annotation_batches
            SET completed_items = ?,
                total_items = ?,
                status = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND project_id = ?
            """,
            (completed, total, status, batch_id, project_id),
        )
