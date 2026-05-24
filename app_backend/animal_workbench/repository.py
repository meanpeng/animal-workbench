from __future__ import annotations

import json
import sqlite3
from typing import Any

from .db import rows_to_dicts


def current_project_id(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT id FROM projects ORDER BY last_opened_at DESC LIMIT 1").fetchone()
    if row is None:
        raise RuntimeError("Database has no project. Did init_db run?")
    return int(row["id"])


def current_project(conn: sqlite3.Connection) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM projects ORDER BY last_opened_at DESC LIMIT 1").fetchone()
    if row is None:
        raise RuntimeError("Database has no project. Did init_db run?")
    return dict(row)


def list_classes(conn: sqlite3.Connection, project_id: int) -> list[dict[str, Any]]:
    return rows_to_dicts(
        conn.execute(
            "SELECT * FROM classes WHERE project_id = ? ORDER BY sort_order, id",
            (project_id,),
        )
    )


def list_dataset_classes(conn: sqlite3.Connection, project_id: int, dataset_id: int) -> list[dict[str, Any]]:
    return rows_to_dicts(
        conn.execute(
            """
            SELECT cl.*
            FROM dataset_classes dc
            JOIN datasets d ON d.id = dc.dataset_id
            JOIN classes cl ON cl.id = dc.class_id
            WHERE dc.dataset_id = ? AND d.project_id = ? AND cl.project_id = ?
            ORDER BY dc.sort_order, cl.sort_order, cl.id
            """,
            (dataset_id, project_id, project_id),
        )
    )


def dashboard_summary(conn: sqlite3.Connection, project_id: int) -> dict[str, Any]:
    tables = [
        ("media_assets", "media_assets"),
        ("datasets", "datasets"),
        ("annotation_batches", "annotation_batches"),
        ("annotations", "annotations"),
        ("models", "models"),
        ("training_jobs", "training_jobs"),
        ("experiments", "experiments"),
        ("dataset_jobs", "dataset_jobs"),
    ]
    union_parts = " UNION ALL ".join(
        f"SELECT ? AS key, COUNT(*) AS cnt FROM {tbl} WHERE project_id = ?"
        for _, tbl in tables
    )
    params = []
    for key, _ in tables:
        params.extend([key, project_id])
    count_rows = conn.execute(union_parts, params).fetchall()
    counts = {row["key"]: int(row["cnt"]) for row in count_rows}

    recent_jobs = rows_to_dicts(
        conn.execute(
            """
            SELECT id, name, status, params, created_at, started_at, ended_at, error_message
            FROM training_jobs
            WHERE project_id = ?
            ORDER BY created_at DESC
            LIMIT 5
            """,
            (project_id,),
        )
    )
    recent_models = rows_to_dicts(
        conn.execute(
            """
            SELECT id, name, metrics_summary, is_recommended, created_at
            FROM models
            WHERE project_id = ?
            ORDER BY created_at DESC
            LIMIT 5
            """,
            (project_id,),
        )
    )
    return {"counts": counts, "recent_jobs": recent_jobs, "recent_models": recent_models}


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def json_loads(value: str | None, default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default
