from __future__ import annotations

from fastapi import APIRouter

from ..db import connect, rows_to_dicts
from ..repository import current_project_id


router = APIRouter()


@router.get("/models")
def list_models() -> list[dict]:
    with connect() as conn:
        return rows_to_dicts(
            conn.execute(
                """
                SELECT m.id,
                       m.name,
                       m.metrics_summary,
                       m.internal_weight_path,
                       m.is_recommended,
                       m.created_at,
                       e.id AS source_experiment_id,
                       e.name AS source_experiment_name,
                       e.training_job_id
                FROM models m
                LEFT JOIN experiments e ON e.id = m.source_experiment_id
                WHERE m.project_id = ?
                ORDER BY m.is_recommended DESC, m.created_at DESC
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
