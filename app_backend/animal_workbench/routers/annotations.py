from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..api_helpers import (
    require_dataset,
    require_dataset_class,
    require_dataset_classes,
    require_media_asset,
    require_media_assets,
    require_media_in_dataset,
    sync_annotation_dependents,
)
from ..db import connect, rows_to_dicts
from ..repository import current_project_id
from ..schemas import AnnotationBatchCreate, AnnotationBulkSave, AnnotationSave, AnnotationUpdate


router = APIRouter()


@router.post("/annotation-batches")
def create_annotation_batch(payload: AnnotationBatchCreate) -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)
        require_media_assets(conn, project_id, payload.media_asset_ids)
        if payload.source_model_id is not None:
            model = conn.execute(
                "SELECT id FROM models WHERE id = ? AND project_id = ?",
                (payload.source_model_id, project_id),
            ).fetchone()
            if model is None:
                raise HTTPException(status_code=422, detail="Source model does not belong to the current project.")
        cursor = conn.execute(
            """
            INSERT INTO annotation_batches(project_id, name, source_model_id, total_items)
            VALUES(?, ?, ?, ?)
            """,
            (project_id, payload.name, payload.source_model_id, len(payload.media_asset_ids)),
        )
        batch_id = int(cursor.lastrowid)
        conn.executemany(
            "INSERT OR IGNORE INTO annotation_batch_items(batch_id, media_asset_id) VALUES(?, ?)",
            [(batch_id, media_id) for media_id in payload.media_asset_ids],
        )
        conn.commit()
        return dict(conn.execute("SELECT * FROM annotation_batches WHERE id = ?", (batch_id,)).fetchone())


@router.get("/annotation-batches")
def list_annotation_batches() -> list[dict]:
    with connect() as conn:
        return rows_to_dicts(
            conn.execute(
                """
                SELECT *
                FROM annotation_batches
                WHERE project_id = ?
                ORDER BY updated_at DESC
                """,
                (current_project_id(conn),),
            )
        )


@router.get("/annotation-batches/{batch_id}")
def get_annotation_batch(batch_id: int) -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)
        batch = conn.execute(
            "SELECT * FROM annotation_batches WHERE id = ? AND project_id = ?",
            (batch_id, project_id),
        ).fetchone()
        if not batch:
            raise HTTPException(status_code=404, detail="Annotation batch not found.")
        items = rows_to_dicts(
            conn.execute(
                """
                SELECT abi.status, ma.id, ma.media_type, ma.original_name, ma.width, ma.height
                FROM annotation_batch_items abi
                JOIN media_assets ma ON ma.id = abi.media_asset_id
                WHERE abi.batch_id = ? AND ma.project_id = ?
                ORDER BY ma.id
                """,
                (batch_id, project_id),
            )
        )
        return {"batch": dict(batch), "items": items}


@router.post("/annotations")
def save_annotation(payload: AnnotationSave) -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)
        require_dataset(conn, project_id, payload.dataset_id)
        require_media_asset(conn, project_id, payload.media_asset_id)
        require_media_in_dataset(conn, project_id, payload.dataset_id, payload.media_asset_id)
        require_dataset_class(conn, project_id, payload.dataset_id, payload.class_id)
        if payload.source_prediction_id is not None:
            prediction = conn.execute(
                """
                SELECT id FROM predictions
                WHERE id = ? AND project_id = ? AND media_asset_id = ?
                """,
                (payload.source_prediction_id, project_id, payload.media_asset_id),
            ).fetchone()
            if prediction is None:
                raise HTTPException(status_code=422, detail="Prediction does not belong to the current project/media.")
        cursor = conn.execute(
            """
            INSERT INTO annotations(
              project_id, media_asset_id, class_id, x, y, width, height,
              review_status, source_prediction_id
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                project_id,
                payload.media_asset_id,
                payload.class_id,
                payload.x,
                payload.y,
                payload.width,
                payload.height,
                payload.review_status,
                payload.source_prediction_id,
            ),
        )
        sync_annotation_dependents(conn, project_id, payload.media_asset_id)
        conn.commit()
        return dict(conn.execute("SELECT * FROM annotations WHERE id = ?", (cursor.lastrowid,)).fetchone())


@router.put("/annotations/{annotation_id}")
def update_annotation(annotation_id: int, payload: AnnotationUpdate) -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)
        existing = conn.execute(
            "SELECT * FROM annotations WHERE id = ? AND project_id = ?",
            (annotation_id, project_id),
        ).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="Annotation not found.")
        require_dataset(conn, project_id, payload.dataset_id)
        require_media_asset(conn, project_id, int(existing["media_asset_id"]))
        require_media_in_dataset(conn, project_id, payload.dataset_id, int(existing["media_asset_id"]))
        require_dataset_class(conn, project_id, payload.dataset_id, payload.class_id)
        cursor = conn.execute(
            """
            UPDATE annotations
            SET class_id = ?,
                x = ?,
                y = ?,
                width = ?,
                height = ?,
                review_status = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND project_id = ?
            """,
            (
                payload.class_id,
                payload.x,
                payload.y,
                payload.width,
                payload.height,
                payload.review_status,
                annotation_id,
                project_id,
            ),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Annotation not found.")
        sync_annotation_dependents(conn, project_id, int(existing["media_asset_id"]))
        conn.commit()
        return dict(conn.execute("SELECT * FROM annotations WHERE id = ?", (annotation_id,)).fetchone())


@router.delete("/annotations/{annotation_id}")
def delete_annotation(annotation_id: int) -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)
        existing = conn.execute(
            "SELECT media_asset_id FROM annotations WHERE id = ? AND project_id = ?",
            (annotation_id, project_id),
        ).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="Annotation not found.")
        media_asset_id = int(existing["media_asset_id"])
        cursor = conn.execute(
            "DELETE FROM annotations WHERE id = ? AND project_id = ?",
            (annotation_id, project_id),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Annotation not found.")
        sync_annotation_dependents(conn, project_id, media_asset_id)
        conn.commit()
        return {"deleted": annotation_id}


@router.get("/media/{media_asset_id}/annotations")
def get_media_annotations(media_asset_id: int, dataset_id: int | None = None) -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)
        require_media_asset(conn, project_id, media_asset_id)
        class_filter = ""
        params: list = [media_asset_id, project_id]
        if dataset_id is not None:
            require_dataset(conn, project_id, dataset_id)
            require_media_in_dataset(conn, project_id, dataset_id, media_asset_id)
            class_filter = "AND class_id IN (SELECT class_id FROM dataset_classes WHERE dataset_id = ?)"
            params.append(dataset_id)
        return {
            "annotations": rows_to_dicts(
                conn.execute(
                    f"""
                    SELECT *
                    FROM annotations
                    WHERE media_asset_id = ? AND project_id = ?
                    {class_filter}
                    ORDER BY updated_at DESC
                    """,
                    params,
                )
            ),
            "predictions": rows_to_dicts(
                conn.execute(
                    """
                    SELECT *
                    FROM predictions
                    WHERE media_asset_id = ? AND project_id = ?
                    ORDER BY confidence DESC
                    """,
                    (media_asset_id, project_id),
                )
            ),
        }


@router.post("/media/{media_asset_id}/annotations/bulk")
def bulk_save_media_annotations(media_asset_id: int, payload: AnnotationBulkSave, dataset_id: int) -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)
        require_media_asset(conn, project_id, media_asset_id)
        require_dataset(conn, project_id, dataset_id)
        require_media_in_dataset(conn, project_id, dataset_id, media_asset_id)
        require_dataset_classes(conn, project_id, dataset_id, [item.class_id for item in payload.upserts])
        delete_ids = list(dict.fromkeys(payload.delete_ids))
        upsert_ids = [item.id for item in payload.upserts if item.id is not None]
        all_existing_ids = list(dict.fromkeys([*delete_ids, *upsert_ids]))
        if all_existing_ids:
            placeholders = ",".join("?" for _ in all_existing_ids)
            rows = conn.execute(
                f"""
                SELECT id
                FROM annotations
                WHERE project_id = ? AND media_asset_id = ? AND id IN ({placeholders})
                """,
                (project_id, media_asset_id, *all_existing_ids),
            ).fetchall()
            owned = {int(row["id"]) for row in rows}
            missing = [annotation_id for annotation_id in all_existing_ids if annotation_id not in owned]
            if missing:
                raise HTTPException(status_code=404, detail=f"Annotations not found: {missing}")

        try:
            if delete_ids:
                placeholders = ",".join("?" for _ in delete_ids)
                conn.execute(
                    f"""
                    DELETE FROM annotations
                    WHERE project_id = ? AND media_asset_id = ? AND id IN ({placeholders})
                    """,
                    (project_id, media_asset_id, *delete_ids),
                )
            for item in payload.upserts:
                if item.id is None:
                    conn.execute(
                        """
                        INSERT INTO annotations(
                          project_id, media_asset_id, class_id, x, y, width, height, review_status
                        )
                        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            project_id,
                            media_asset_id,
                            item.class_id,
                            item.x,
                            item.y,
                            item.width,
                            item.height,
                            item.review_status,
                        ),
                    )
                else:
                    conn.execute(
                        """
                        UPDATE annotations
                        SET class_id = ?,
                            x = ?,
                            y = ?,
                            width = ?,
                            height = ?,
                            review_status = ?,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = ? AND project_id = ? AND media_asset_id = ?
                        """,
                        (
                            item.class_id,
                            item.x,
                            item.y,
                            item.width,
                            item.height,
                            item.review_status,
                            item.id,
                            project_id,
                            media_asset_id,
                        ),
                    )
            remaining_row = conn.execute(
                """
                SELECT COUNT(*) AS cnt
                FROM annotations
                WHERE project_id = ? AND media_asset_id = ?
                  AND class_id IN (SELECT class_id FROM dataset_classes WHERE dataset_id = ?)
                """,
                (project_id, media_asset_id, dataset_id),
            ).fetchone()
            annotation_status = "annotated" if int(remaining_row["cnt"]) > 0 else "unannotated"
            conn.execute(
                """
                UPDATE dataset_assets
                SET annotation_status = ?
                WHERE dataset_id = ? AND media_asset_id = ?
                """,
                (annotation_status, dataset_id, media_asset_id),
            )
            sync_annotation_dependents(conn, project_id, media_asset_id)
            conn.commit()
        except Exception:
            conn.rollback()
            raise

        return {
            "annotations": rows_to_dicts(
                conn.execute(
                    """
                    SELECT *
                    FROM annotations
                    WHERE media_asset_id = ? AND project_id = ?
                      AND class_id IN (SELECT class_id FROM dataset_classes WHERE dataset_id = ?)
                    ORDER BY updated_at DESC
                    """,
                    (media_asset_id, project_id, dataset_id),
                )
            )
        }


@router.put("/datasets/{dataset_id}/media/{media_asset_id}/annotation-status")
def mark_media_annotation_status(dataset_id: int, media_asset_id: int, status: str = "annotated") -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)
        require_media_asset(conn, project_id, media_asset_id)
        require_media_in_dataset(conn, project_id, dataset_id, media_asset_id)
        conn.execute(
            """
            UPDATE dataset_assets
            SET annotation_status = ?
            WHERE dataset_id = ? AND media_asset_id = ?
            """,
            (status, dataset_id, media_asset_id),
        )
        conn.commit()
        return {"ok": True}
