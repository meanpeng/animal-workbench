from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..api_helpers import require_dataset
from ..class_colors import class_color_for_index
from ..db import connect
from ..repository import current_project_id, list_classes, list_dataset_classes
from ..schemas import ClassCreate, ClassUpdate
from ..services.datasets import bind_class_to_dataset, refresh_dataset_counts


router = APIRouter()


@router.get("/classes")
def get_classes() -> list[dict]:
    with connect() as conn:
        return list_classes(conn, current_project_id(conn))


@router.post("/classes")
def create_class(payload: ClassCreate) -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)
        label_name = payload.name.strip()
        if not label_name:
            raise HTTPException(status_code=422, detail="Class name cannot be blank.")
        existing = conn.execute(
            "SELECT id FROM classes WHERE project_id = ? AND name = ?",
            (project_id, label_name),
        ).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="Class name already exists.")
        row = conn.execute(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM classes WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        sort_order = int(row["next_order"])
        cursor = conn.execute(
            """
            INSERT INTO classes(project_id, name, display_name, color, sort_order)
            VALUES(?, ?, ?, ?, ?)
            """,
            (
                project_id,
                label_name,
                label_name,
                payload.color or class_color_for_index(sort_order),
                sort_order,
            ),
        )
        conn.commit()
        return dict(conn.execute("SELECT * FROM classes WHERE id = ?", (cursor.lastrowid,)).fetchone())


@router.get("/datasets/{dataset_id}/classes")
def get_dataset_classes(dataset_id: int) -> list[dict]:
    with connect() as conn:
        project_id = current_project_id(conn)
        require_dataset(conn, project_id, dataset_id)
        return list_dataset_classes(conn, project_id, dataset_id)


@router.post("/datasets/{dataset_id}/classes")
def create_dataset_class(dataset_id: int, payload: ClassCreate) -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)
        require_dataset(conn, project_id, dataset_id)
        label_name = payload.name.strip()
        if not label_name:
            raise HTTPException(status_code=422, detail="Class name cannot be blank.")
        existing = conn.execute(
            "SELECT * FROM classes WHERE project_id = ? AND name = ?",
            (project_id, label_name),
        ).fetchone()
        if existing:
            bound = conn.execute(
                "SELECT 1 FROM dataset_classes WHERE dataset_id = ? AND class_id = ?",
                (dataset_id, existing["id"]),
            ).fetchone()
            if bound:
                raise HTTPException(status_code=409, detail="Class name already exists in this dataset.")
            bind_class_to_dataset(conn, project_id, dataset_id, int(existing["id"]))
            refresh_dataset_counts(conn, project_id, dataset_id)
            conn.commit()
            return dict(existing)

        row = conn.execute(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM classes WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        sort_order = int(row["next_order"])
        cursor = conn.execute(
            """
            INSERT INTO classes(project_id, name, display_name, color, sort_order)
            VALUES(?, ?, ?, ?, ?)
            """,
            (
                project_id,
                label_name,
                label_name,
                payload.color or class_color_for_index(sort_order),
                sort_order,
            ),
        )
        class_id = int(cursor.lastrowid)
        bind_class_to_dataset(conn, project_id, dataset_id, class_id)
        refresh_dataset_counts(conn, project_id, dataset_id)
        conn.commit()
        return dict(conn.execute("SELECT * FROM classes WHERE id = ?", (class_id,)).fetchone())


@router.put("/datasets/{dataset_id}/classes/{class_id}")
def update_dataset_class(dataset_id: int, class_id: int, payload: ClassUpdate) -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)
        require_dataset(conn, project_id, dataset_id)
        label_name = payload.name.strip()
        if not label_name:
            raise HTTPException(status_code=422, detail="Class name cannot be blank.")
        row = conn.execute(
            """
            SELECT cl.id
            FROM dataset_classes dc
            JOIN classes cl ON cl.id = dc.class_id
            WHERE dc.dataset_id = ? AND dc.class_id = ? AND cl.project_id = ?
            """,
            (dataset_id, class_id, project_id),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Class not found in this dataset.")
        duplicate = conn.execute(
            """
            SELECT id
            FROM classes
            WHERE project_id = ? AND name = ? AND id <> ?
            """,
            (project_id, label_name, class_id),
        ).fetchone()
        if duplicate:
            raise HTTPException(status_code=409, detail="Class name already exists.")
        conn.execute(
            "UPDATE classes SET name = ?, display_name = ? WHERE id = ? AND project_id = ?",
            (label_name, label_name, class_id, project_id),
        )
        refresh_dataset_counts(conn, project_id, dataset_id)
        conn.commit()
        return dict(conn.execute("SELECT * FROM classes WHERE id = ?", (class_id,)).fetchone())


def _dataset_class_delete_preview(conn, project_id: int, dataset_id: int, class_id: int) -> dict:
    require_dataset(conn, project_id, dataset_id)
    class_row = conn.execute(
        """
        SELECT cl.*
        FROM dataset_classes dc
        JOIN classes cl ON cl.id = dc.class_id
        WHERE dc.dataset_id = ? AND dc.class_id = ? AND cl.project_id = ?
        """,
        (dataset_id, class_id, project_id),
    ).fetchone()
    if class_row is None:
        raise HTTPException(status_code=404, detail="Class not found in this dataset.")

    counts = conn.execute(
        """
        SELECT
            COUNT(a.id) AS annotation_count,
            COUNT(DISTINCT a.media_asset_id) AS affected_media_count
        FROM annotations a
        JOIN dataset_assets da
          ON da.dataset_id = ? AND da.media_asset_id = a.media_asset_id
        WHERE a.project_id = ? AND a.class_id = ?
        """,
        (dataset_id, project_id, class_id),
    ).fetchone()
    return {
        "class": dict(class_row),
        "annotation_count": int(counts["annotation_count"]),
        "affected_media_count": int(counts["affected_media_count"]),
    }


@router.get("/datasets/{dataset_id}/classes/{class_id}/delete-preview")
def preview_delete_dataset_class(dataset_id: int, class_id: int) -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)
        return _dataset_class_delete_preview(conn, project_id, dataset_id, class_id)


@router.delete("/datasets/{dataset_id}/classes/{class_id}")
def delete_dataset_class(dataset_id: int, class_id: int) -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)
        preview = _dataset_class_delete_preview(conn, project_id, dataset_id, class_id)
        affected_media_rows = conn.execute(
            """
            SELECT DISTINCT a.media_asset_id
            FROM annotations a
            JOIN dataset_assets da
              ON da.dataset_id = ? AND da.media_asset_id = a.media_asset_id
            WHERE a.project_id = ? AND a.class_id = ?
            """,
            (dataset_id, project_id, class_id),
        ).fetchall()
        affected_media_ids = [int(row["media_asset_id"]) for row in affected_media_rows]
        conn.execute(
            """
            DELETE FROM annotations
            WHERE project_id = ?
              AND class_id = ?
              AND media_asset_id IN (
                SELECT media_asset_id FROM dataset_assets WHERE dataset_id = ?
              )
              AND NOT EXISTS (
                SELECT 1
                FROM dataset_assets da2
                JOIN datasets d2 ON d2.id = da2.dataset_id
                JOIN dataset_classes dc2
                  ON dc2.dataset_id = da2.dataset_id
                 AND dc2.class_id = annotations.class_id
                WHERE d2.project_id = ?
                  AND da2.dataset_id <> ?
                  AND da2.media_asset_id = annotations.media_asset_id
              )
            """,
            (project_id, class_id, dataset_id, project_id, dataset_id),
        )
        conn.execute(
            "DELETE FROM dataset_classes WHERE dataset_id = ? AND class_id = ?",
            (dataset_id, class_id),
        )
        for media_id in affected_media_ids:
            has_remaining = conn.execute(
                """
                SELECT 1
                FROM annotations a
                JOIN dataset_classes dc
                  ON dc.dataset_id = ? AND dc.class_id = a.class_id
                WHERE a.project_id = ? AND a.media_asset_id = ?
                LIMIT 1
                """,
                (dataset_id, project_id, media_id),
            ).fetchone()
            if has_remaining is None:
                conn.execute(
                    """
                    UPDATE dataset_assets
                    SET annotation_status = 'unannotated'
                    WHERE dataset_id = ? AND media_asset_id = ?
                    """,
                    (dataset_id, media_id),
                )
        refresh_dataset_counts(conn, project_id, dataset_id)
        conn.commit()
        return {
            "deleted_class_id": class_id,
            "deleted_annotations": preview["annotation_count"],
            "affected_media_count": preview["affected_media_count"],
        }
