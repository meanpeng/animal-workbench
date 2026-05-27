"""Dataset CRUD and media-in-dataset endpoints."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..db import connect, rows_to_dicts
from ..repository import current_project_id, list_dataset_classes
from ..dependencies import require_dataset, require_media_assets, require_dataset_class
from ..schemas import DatasetCreate, DatasetFusionCreate, DatasetMediaAdd
from ..services.datasets import add_media_to_dataset, create_dataset, create_fusion_dataset
from ..services.datasets import query_dataset_media

router = APIRouter()


@router.post("/datasets")
def create_dataset_endpoint(payload: DatasetCreate) -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)
        require_media_assets(conn, project_id, payload.media_asset_ids)
        try:
            return create_dataset(
                conn,
                project_id,
                payload.name,
                payload.dataset_type,
                payload.media_asset_ids,
                payload.composition_rule,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))


@router.post("/datasets/fusion")
def create_fusion_dataset_endpoint(payload: DatasetFusionCreate) -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)
        try:
            return create_fusion_dataset(conn, project_id, payload.name, payload.source_dataset_ids)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))


@router.get("/datasets")
def list_datasets() -> list[dict]:
    with connect() as conn:
        return rows_to_dicts(
            conn.execute(
                "SELECT * FROM datasets WHERE project_id = ? ORDER BY updated_at DESC",
                (current_project_id(conn),),
            )
        )


@router.delete("/datasets/{dataset_id}")
def delete_dataset_endpoint(dataset_id: int) -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)

        # verify dataset exists and belongs to project
        dataset = conn.execute(
            "SELECT * FROM datasets WHERE id = ? AND project_id = ?",
            (dataset_id, project_id),
        ).fetchone()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found.")

        # nullify default_dataset_id in projects if pointing to this dataset
        conn.execute(
            "UPDATE projects SET default_dataset_id = NULL WHERE default_dataset_id = ?",
            (dataset_id,),
        )

        # nullify experiment references to training jobs that reference this dataset
        job_ids = [
            row["id"]
            for row in conn.execute(
                "SELECT id FROM training_jobs WHERE dataset_id = ?", (dataset_id,)
            ).fetchall()
        ]
        for job_id in job_ids:
            conn.execute(
                "UPDATE experiments SET training_job_id = NULL WHERE training_job_id = ?",
                (job_id,),
            )

        # delete training jobs that reference this dataset
        conn.execute(
            "DELETE FROM training_jobs WHERE dataset_id = ?", (dataset_id,)
        )

        # delete the dataset (cascade deletes dataset_assets)
        conn.execute("DELETE FROM datasets WHERE id = ?", (dataset_id,))
        conn.commit()
        return {"deleted": dataset_id}


@router.get("/datasets/{dataset_id}/media")
def dataset_media(
    dataset_id: int,
    limit: int = 50,
    offset: int = 0,
    search: str | None = None,
    class_id: int | None = None,
    annotation_status: str | None = None,
    media_asset_id: int | None = None,
) -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)

        # verify dataset belongs to project
        dataset = conn.execute(
            "SELECT * FROM datasets WHERE id = ? AND project_id = ?",
            (dataset_id, project_id),
        ).fetchone()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found.")

        if class_id is not None:
            require_dataset_class(conn, project_id, dataset_id, class_id)

        return query_dataset_media(
            conn,
            project_id,
            dataset_id,
            dataset,
            limit=limit,
            offset=offset,
            search=search,
            class_id=class_id,
            annotation_status=annotation_status,
            media_asset_id=media_asset_id,
        )


@router.post("/datasets/{dataset_id}/media")
def add_media_to_dataset_endpoint(dataset_id: int, payload: DatasetMediaAdd) -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)
        dataset = conn.execute(
            "SELECT * FROM datasets WHERE id = ? AND project_id = ?",
            (dataset_id, project_id),
        ).fetchone()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found.")
        require_media_assets(conn, project_id, payload.media_asset_ids)
        try:
            return add_media_to_dataset(conn, project_id, dataset_id, payload.media_asset_ids)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
