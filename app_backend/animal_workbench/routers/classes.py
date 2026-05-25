from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..api_helpers import require_dataset
from ..class_colors import class_color_for_index
from ..db import connect
from ..repository import current_project_id, list_classes, list_dataset_classes
from ..schemas import ClassCreate
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
        existing = conn.execute(
            "SELECT id FROM classes WHERE project_id = ? AND name = ?",
            (project_id, payload.name),
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
                payload.name,
                payload.display_name,
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
        existing = conn.execute(
            "SELECT * FROM classes WHERE project_id = ? AND name = ?",
            (project_id, payload.name),
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
                payload.name,
                payload.display_name,
                payload.color or class_color_for_index(sort_order),
                sort_order,
            ),
        )
        class_id = int(cursor.lastrowid)
        bind_class_to_dataset(conn, project_id, dataset_id, class_id)
        refresh_dataset_counts(conn, project_id, dataset_id)
        conn.commit()
        return dict(conn.execute("SELECT * FROM classes WHERE id = ?", (class_id,)).fetchone())
