from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException

from ..config import ensure_paths, get_paths, set_data_root
from ..db import connect
from ..repository import current_project, current_project_id, dashboard_summary, list_classes
from ..schemas import AssistedAnnotationSettingsUpdate, ProjectCreate, StorageSettingsUpdate
from ..services.assisted_annotation import (
    assisted_annotation_settings,
    save_assisted_annotation_settings,
)


router = APIRouter()


@router.get("/health")
def health() -> dict:
    paths = get_paths()
    return {"ok": True, "workspace": str(paths.root)}


@router.get("/settings/storage")
def get_storage_settings() -> dict:
    paths = ensure_paths()
    return {
        "app_root": str(paths.root),
        "data_root": str(paths.data_root),
        "db_path": str(paths.db_path),
        "media_dir": str(paths.media_dir),
        "public_data_dir": str(paths.public_data_dir),
        "runtime_dir": str(paths.runtime_dir),
        "log_dir": str(paths.log_dir),
    }


@router.get("/settings/assisted-annotation")
def get_assisted_annotation_settings() -> dict:
    with connect() as conn:
        return assisted_annotation_settings(conn)


@router.put("/settings/storage")
def update_storage_settings(payload: StorageSettingsUpdate) -> dict:
    data_root = Path(payload.data_root).expanduser().resolve()
    if data_root.drive and data_root.drive.upper().startswith("C:"):
        raise HTTPException(status_code=422, detail="请选择 C 盘以外的数据目录。")
    set_data_root(data_root)
    ensure_paths()
    return get_storage_settings()


@router.put("/settings/assisted-annotation")
def update_assisted_annotation_settings(payload: AssistedAnnotationSettingsUpdate) -> dict:
    with connect() as conn:
        return save_assisted_annotation_settings(conn, payload.model_dump())


@router.get("/summary")
def summary() -> dict:
    with connect() as conn:
        project = current_project(conn)
        return {
            "project": project,
            "classes": list_classes(conn, project["id"]),
            **dashboard_summary(conn, project["id"]),
        }


@router.get("/projects/current")
def get_current_project() -> dict:
    with connect() as conn:
        return current_project(conn)


@router.post("/projects")
def create_project(payload: ProjectCreate) -> dict:
    with connect() as conn:
        cursor = conn.execute(
            "INSERT INTO projects(name, reserve_name) VALUES(?, ?)",
            (payload.name, payload.reserve_name),
        )
        project_id = int(cursor.lastrowid)
        conn.commit()
        return dict(conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone())
