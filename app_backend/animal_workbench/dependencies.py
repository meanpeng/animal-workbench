"""Validation guard functions used across route handlers."""

from __future__ import annotations

from fastapi import HTTPException

from .db import connect


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
    placeholders = ",".join("?" for _ in unique_ids)
    rows = conn.execute(
        f"SELECT id FROM media_assets WHERE project_id = ? AND id IN ({placeholders})",
        (project_id, *unique_ids),
    ).fetchall()
    owned = {int(row["id"]) for row in rows}
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
