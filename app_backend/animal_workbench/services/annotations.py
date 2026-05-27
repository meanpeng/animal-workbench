"""Annotation-related business logic."""

from __future__ import annotations

from ..dependencies import dataset_ids_for_media
from .datasets import refresh_dataset_counts


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
