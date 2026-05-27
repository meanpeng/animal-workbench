"""Training job and model/experiment listing endpoints."""

from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks

from ..db import connect, rows_to_dicts
from ..repository import current_project_id
from ..dependencies import require_dataset
from ..schemas import TrainingJobCreate
from ..services.training import create_training_job, run_training_job

router = APIRouter()


@router.post("/training-jobs")
def create_training_job_endpoint(payload: TrainingJobCreate, background_tasks: BackgroundTasks) -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)
        require_dataset(conn, project_id, payload.dataset_id)
        params = payload.model_dump()
        job = create_training_job(conn, project_id, payload.dataset_id, payload.name, params)
        background_tasks.add_task(run_job_background, job["id"])
        return job


@router.get("/training-jobs")
def list_training_jobs() -> list[dict]:
    with connect() as conn:
        return rows_to_dicts(
            conn.execute(
                """
                SELECT *
                FROM training_jobs
                WHERE project_id = ?
                ORDER BY created_at DESC
                """,
                (current_project_id(conn),),
            )
        )


@router.get("/models")
def list_models() -> list[dict]:
    with connect() as conn:
        return rows_to_dicts(
            conn.execute(
                """
                SELECT id, name, metrics_summary, is_recommended, created_at
                FROM models
                WHERE project_id = ?
                ORDER BY is_recommended DESC, created_at DESC
                """,
                (current_project_id(conn),),
            )
        )


@router.get("/experiments")
def list_experiments() -> list[dict]:
    with connect() as conn:
        return rows_to_dicts(
            conn.execute(
                "SELECT * FROM experiments WHERE project_id = ? ORDER BY created_at DESC",
                (current_project_id(conn),),
            )
        )


def run_job_background(job_id: int) -> None:
    with connect() as conn:
        run_training_job(conn, job_id)
