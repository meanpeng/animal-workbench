from __future__ import annotations

from contextlib import asynccontextmanager
import asyncio
import json
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse

from .config import ensure_paths, get_paths
from .db import connect, init_db, rows_to_dicts
from .repository import current_project, current_project_id, dashboard_summary, json_dumps, list_classes, list_dataset_classes
from .class_colors import class_color_for_index
from .schemas import (
    AnnotationBatchCreate,
    AnnotationBulkSave,
    AnnotationSave,
    AnnotationUpdate,
    ClassCreate,
    DatasetCreate,
    DatasetFusionCreate,
    DatasetFolderImportRequest,
    DatasetMediaAdd,
    MediaImportRequest,
    ModelProfileRequest,
    ProjectCreate,
    PublicDatasetJobRequest,
    TrainingJobCreate,
)
from .services.datasets import add_media_to_dataset, bind_class_to_dataset, create_dataset, create_fusion_dataset, refresh_dataset_counts
from .services.dataset_import import import_dataset_folder
from .services.dataset_jobs import create_dataset_job, get_dataset_job, list_dataset_jobs, start_dataset_job
from .services.media import import_media
from .services.public_catalog import list_public_dataset_statuses, public_spec
from .services.public_downloads import prepare_public_dataset
from .services.public_import import import_public_dataset
from .services.training import create_training_job, device_status, profile_model, run_training_job


@asynccontextmanager
async def lifespan(_: FastAPI):
    ensure_paths()
    init_db()
    _cleanup_stale_jobs()
    yield


def _cleanup_stale_jobs() -> None:
    """Mark any dataset / training jobs that were left in a non-terminal
    state (e.g. because the app was killed) as failed on startup."""
    dataset_non_terminal = ("queued", "running")
    training_non_terminal = ("queued", "exported", "running")
    interrupted_message = "应用意外关闭，任务中断"

    with connect() as conn:
        # Dataset jobs.
        rows = conn.execute(
            f"""
            SELECT id FROM dataset_jobs
            WHERE status IN ({",".join("?" * len(dataset_non_terminal))})
            """,
            dataset_non_terminal,
        ).fetchall()
        for (job_id,) in rows:
            conn.execute(
                """
                UPDATE dataset_jobs
                SET status = 'failed',
                    stage = 'failed',
                    error_message = ?,
                    message = ?,
                    updated_at = CURRENT_TIMESTAMP,
                    ended_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (interrupted_message, interrupted_message, job_id),
            )

        # Training jobs.
        rows = conn.execute(
            f"""
            SELECT id FROM training_jobs
            WHERE status IN ({",".join("?" * len(training_non_terminal))})
            """,
            training_non_terminal,
        ).fetchall()
        for (job_id,) in rows:
            conn.execute(
                """
                UPDATE training_jobs
                SET status = 'failed',
                    error_message = ?,
                    ended_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (interrupted_message, job_id),
            )

        conn.commit()


app = FastAPI(title="Animal Detection Workbench API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "tauri://localhost"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    paths = get_paths()
    return {"ok": True, "workspace": str(paths.root)}


@app.get("/summary")
def summary() -> dict:
    with connect() as conn:
        project = current_project(conn)
        return {
            "project": project,
            "classes": list_classes(conn, project["id"]),
            **dashboard_summary(conn, project["id"]),
        }


@app.get("/projects/current")
def get_current_project() -> dict:
    with connect() as conn:
        return current_project(conn)


@app.post("/projects")
def create_project(payload: ProjectCreate) -> dict:
    with connect() as conn:
        cursor = conn.execute(
            "INSERT INTO projects(name, reserve_name) VALUES(?, ?)",
            (payload.name, payload.reserve_name),
        )
        project_id = int(cursor.lastrowid)
        conn.commit()
        return dict(conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone())


@app.get("/classes")
def get_classes() -> list[dict]:
    with connect() as conn:
        return list_classes(conn, current_project_id(conn))


@app.post("/classes")
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


@app.get("/datasets/{dataset_id}/classes")
def get_dataset_classes(dataset_id: int) -> list[dict]:
    with connect() as conn:
        project_id = current_project_id(conn)
        require_dataset(conn, project_id, dataset_id)
        return list_dataset_classes(conn, project_id, dataset_id)


@app.post("/datasets/{dataset_id}/classes")
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


@app.get("/public-datasets")
def public_datasets() -> list[dict]:
    return list_public_dataset_statuses()


@app.get("/dataset-jobs")
def get_dataset_jobs(limit: int = 20) -> list[dict]:
    with connect() as conn:
        return list_dataset_jobs(conn, current_project_id(conn), limit)


@app.get("/dataset-jobs/{job_id}")
def get_dataset_job_endpoint(job_id: int) -> dict:
    with connect() as conn:
        try:
            return get_dataset_job(conn, job_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Dataset job not found.")


@app.get("/dataset-jobs/{job_id}/events")
async def dataset_job_events(job_id: int) -> StreamingResponse:
    async def event_stream():
        last_payload = ""
        while True:
            with connect() as conn:
                try:
                    job = get_dataset_job(conn, job_id)
                except KeyError:
                    yield "event: error\ndata: {\"detail\":\"Dataset job not found\"}\n\n"
                    return
            payload = json.dumps(job, ensure_ascii=False)
            if payload != last_payload:
                yield f"data: {payload}\n\n"
                last_payload = payload
            if job["status"] in {"completed", "failed"}:
                return
            await asyncio.sleep(1)

    return StreamingResponse(event_stream(), media_type="text/event-stream; charset=utf-8")


@app.post("/dataset-jobs/import-folder")
def start_folder_import(payload: DatasetFolderImportRequest) -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)
        if payload.target_dataset and payload.target_dataset.mode == "existing":
            require_dataset(conn, project_id, payload.target_dataset.dataset_id)
        job = create_dataset_job(
            conn,
            project_id,
            "folder_import",
            payload.model_dump(),
            message="文件夹导入任务已排队",
        )

    def run(reporter):
        with connect() as thread_conn:
            result = import_dataset_folder(
                thread_conn,
                project_id,
                payload.path,
                name=payload.name,
                dataset_kind=payload.dataset_kind,
                batch_name=payload.batch_name,
                create_dataset=payload.create_dataset,
                target_dataset=payload.target_dataset.model_dump() if payload.target_dataset else None,
                reporter=reporter,
                extract_frames=payload.extract_frames,
            )
        reporter.complete(result, "文件夹导入完成")

    start_dataset_job(job["id"], run)
    return job


@app.post("/dataset-jobs/public/{key}/download")
def start_public_download(key: str, payload: PublicDatasetJobRequest) -> dict:
    try:
        spec = public_spec(key)
    except KeyError:
        raise HTTPException(status_code=404, detail="Public dataset preset not found.")
    with connect() as conn:
        project_id = current_project_id(conn)
        job = create_dataset_job(
            conn,
            project_id,
            "public_download",
            {"key": key, **payload.model_dump()},
            message=f"{spec.name} 下载任务已排队",
        )

    def run(reporter):
        result = prepare_public_dataset(spec, sample_limit=payload.sample_limit, force=payload.force, reporter=reporter)
        reporter.complete(result, f"{spec.name} 下载准备完成")

    start_dataset_job(job["id"], run)
    return job


@app.post("/dataset-jobs/public/{key}/import")
def start_public_import(key: str, payload: PublicDatasetJobRequest) -> dict:
    try:
        spec = public_spec(key)
    except KeyError:
        raise HTTPException(status_code=404, detail="Public dataset preset not found.")
    with connect() as conn:
        project_id = current_project_id(conn)
        job = create_dataset_job(
            conn,
            project_id,
            "public_import",
            {"key": key, **payload.model_dump()},
            message=f"{spec.name} 导入任务已排队",
        )

    def run(reporter):
        with connect() as thread_conn:
            result = import_public_dataset(
                thread_conn,
                project_id,
                spec,
                source_path=payload.source_path,
                sample_limit=payload.sample_limit,
                reporter=reporter,
            )
        reporter.complete(result, f"{spec.name} 导入完成")

    start_dataset_job(job["id"], run)
    return job


@app.post("/media/import")
def import_media_endpoint(payload: MediaImportRequest) -> dict:
    with connect() as conn:
        return import_media(
            conn,
            current_project_id(conn),
            payload.paths,
            batch_name=payload.batch_name,
            camera_site=payload.camera_site,
            extract_frames=payload.extract_frames,
        )


@app.get("/media")
def list_media(limit: int = 200, offset: int = 0) -> list[dict]:
    with connect() as conn:
        return rows_to_dicts(
            conn.execute(
                """
                SELECT id, media_type, original_name, camera_site, width, height, created_at
                FROM media_assets
                WHERE project_id = ?
                ORDER BY created_at DESC
                LIMIT ? OFFSET ?
                """,
                (current_project_id(conn), limit, offset),
            )
        )


@app.post("/media/cleanup-orphans")
def cleanup_orphan_media() -> dict:
    """Delete media files and rows that are not referenced by any dataset."""
    import os
    with connect() as conn:
        project_id = current_project_id(conn)
        orphans = conn.execute(
            """
            SELECT m.id, m.internal_path
            FROM media_assets m
            WHERE m.project_id = ?
              AND m.id NOT IN (SELECT DISTINCT media_asset_id FROM dataset_assets)
              AND m.id NOT IN (SELECT DISTINCT media_asset_id FROM annotations)
              AND m.id NOT IN (SELECT DISTINCT media_asset_id FROM annotation_batch_items)
              AND m.id NOT IN (SELECT DISTINCT media_asset_id FROM predictions)
              AND m.id NOT IN (SELECT DISTINCT parent_asset_id FROM media_assets WHERE parent_asset_id IS NOT NULL)
            """,
            (project_id,),
        ).fetchall()

        deleted_files = 0
        deleted_rows = 0
        for row in orphans:
            path = row["internal_path"]
            if path and os.path.isfile(path):
                try:
                    os.remove(path)
                    deleted_files += 1
                except OSError:
                    pass
            conn.execute("DELETE FROM media_assets WHERE id = ?", (row["id"],))
            deleted_rows += 1

        conn.commit()
        return {"deleted_rows": deleted_rows, "deleted_files": deleted_files}


@app.get("/media/{media_asset_id}/content")
def media_content(media_asset_id: int) -> FileResponse:
    with connect() as conn:
        row = conn.execute(
            """
            SELECT internal_path, media_type, original_name
            FROM media_assets
            WHERE id = ? AND project_id = ?
            """,
            (media_asset_id, current_project_id(conn)),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Media asset not found.")

    path = Path(row["internal_path"])
    if not path.exists():
        raise HTTPException(status_code=404, detail="Managed media file is missing.")
    return FileResponse(
        path,
        filename=row["original_name"],
        headers={"Cache-Control": "public, max-age=86400"},
    )


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


@app.post("/datasets")
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


@app.post("/datasets/fusion")
def create_fusion_dataset_endpoint(payload: DatasetFusionCreate) -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)
        try:
            return create_fusion_dataset(conn, project_id, payload.name, payload.source_dataset_ids)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))


@app.get("/datasets")
def list_datasets() -> list[dict]:
    with connect() as conn:
        return rows_to_dicts(
            conn.execute(
                "SELECT * FROM datasets WHERE project_id = ? ORDER BY updated_at DESC",
                (current_project_id(conn),),
            )
        )


@app.delete("/datasets/{dataset_id}")
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


@app.get("/datasets/{dataset_id}/media")
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

        # ── stats ──────────────────────────────────────────────
        stats_row = conn.execute(
            """
            SELECT
                COUNT(DISTINCT da.media_asset_id) AS total_media,
                COUNT(DISTINCT a.id) AS total_annotations,
                COUNT(DISTINCT CASE WHEN a.id IS NOT NULL THEN da.media_asset_id END) AS annotated_media
            FROM dataset_assets da
            LEFT JOIN annotations a
              ON a.media_asset_id = da.media_asset_id
             AND a.project_id = ?
             AND a.class_id IN (SELECT class_id FROM dataset_classes WHERE dataset_id = ?)
            WHERE da.dataset_id = ?
            """,
            (project_id, dataset_id, dataset_id),
        ).fetchone()

        class_rows = conn.execute(
            """
            SELECT cl.name, cl.display_name, COUNT(a.id) AS cnt
            FROM dataset_assets da
            JOIN annotations a ON a.media_asset_id = da.media_asset_id AND a.project_id = ?
            JOIN dataset_classes dc ON dc.dataset_id = ? AND dc.class_id = a.class_id
            JOIN classes cl ON cl.id = a.class_id
            WHERE da.dataset_id = ?
            GROUP BY cl.id
            ORDER BY cnt DESC
            """,
            (project_id, dataset_id, dataset_id),
        ).fetchall()
        class_counts = {row["display_name"]: row["cnt"] for row in class_rows}

        # ── base query ─────────────────────────────────────────
        if class_id is not None:
            require_dataset_class(conn, project_id, dataset_id, class_id)

        conditions = ["da.dataset_id = ?"]
        params: list = [dataset_id]

        if search:
            conditions.append("ma.original_name LIKE ?")
            params.append(f"%{search}%")

        if media_asset_id is not None:
            conditions.append("ma.id = ?")
            params.append(media_asset_id)

        if class_id is not None:
            conditions.append(
                """
                EXISTS (
                    SELECT 1
                    FROM annotations a2
                    JOIN dataset_classes dc2 ON dc2.dataset_id = ? AND dc2.class_id = a2.class_id
                    WHERE a2.media_asset_id = ma.id AND a2.project_id = ? AND a2.class_id = ?
                )
                """
            )
            params.extend([dataset_id, project_id, class_id])

        if annotation_status == "annotated":
            conditions.append(
                """
                EXISTS (
                    SELECT 1
                    FROM annotations a2
                    JOIN dataset_classes dc2 ON dc2.dataset_id = ? AND dc2.class_id = a2.class_id
                    WHERE a2.media_asset_id = ma.id AND a2.project_id = ?
                )
                """
            )
            params.extend([dataset_id, project_id])
        elif annotation_status == "unannotated":
            conditions.append(
                """
                NOT EXISTS (
                    SELECT 1
                    FROM annotations a2
                    JOIN dataset_classes dc2 ON dc2.dataset_id = ? AND dc2.class_id = a2.class_id
                    WHERE a2.media_asset_id = ma.id AND a2.project_id = ?
                )
                """
            )
            params.extend([dataset_id, project_id])

        where_clause = " AND ".join(conditions)

        # Count matching media rows.
        count_row = conn.execute(
            f"""
            SELECT COUNT(*) AS cnt
            FROM dataset_assets da
            JOIN media_assets ma ON ma.id = da.media_asset_id
            WHERE {where_clause} AND ma.project_id = ?
            """,
            [*params, project_id],
        ).fetchone()
        total = int(count_row["cnt"])

        # Fetch the current page.
        rows = rows_to_dicts(
            conn.execute(
                f"""
                SELECT
                    ma.id, ma.media_type, ma.original_name,
                    ma.camera_site, ma.width, ma.height, ma.created_at
                FROM dataset_assets da
                JOIN media_assets ma ON ma.id = da.media_asset_id
                WHERE {where_clause} AND ma.project_id = ?
                ORDER BY ma.id ASC
                LIMIT ? OFFSET ?
                """,
                [*params, project_id, limit, offset],
            )
        )

        # Batch annotation counts and class names.
        media_ids = [row["id"] for row in rows]
        ann_count_map: dict[int, int] = {}
        class_names_map: dict[int, list[str]] = {}
        if media_ids:
            placeholders = ",".join("?" for _ in media_ids)
            ann_rows = conn.execute(
                f"""
                SELECT a.media_asset_id, COUNT(*) AS cnt
                FROM annotations a
                JOIN dataset_classes dc ON dc.dataset_id = ? AND dc.class_id = a.class_id
                WHERE a.media_asset_id IN ({placeholders}) AND a.project_id = ?
                GROUP BY a.media_asset_id
                """,
                [dataset_id, *media_ids, project_id],
            ).fetchall()
            for r in ann_rows:
                ann_count_map[int(r["media_asset_id"])] = int(r["cnt"])

            class_rows_for_media = conn.execute(
                f"""
                SELECT a.media_asset_id, cl.display_name
                FROM annotations a
                JOIN dataset_classes dc ON dc.dataset_id = ? AND dc.class_id = a.class_id
                JOIN classes cl ON cl.id = a.class_id
                WHERE a.media_asset_id IN ({placeholders}) AND a.project_id = ?
                GROUP BY a.media_asset_id, cl.id
                """,
                [dataset_id, *media_ids, project_id],
            ).fetchall()
            for row2 in class_rows_for_media:
                media_id = int(row2["media_asset_id"])
                class_names_map.setdefault(media_id, []).append(row2["display_name"])

        media_list = []
        for row in rows:
            media_list.append({
                "id": row["id"],
                "media_type": row["media_type"],
                "original_name": row["original_name"],
                "camera_site": row["camera_site"],
                "width": row["width"],
                "height": row["height"],
                "annotation_count": ann_count_map.get(row["id"], 0),
                "class_names": class_names_map.get(row["id"], []),
            })

        return {
            "dataset": dict(dataset),
            "classes": list_dataset_classes(conn, project_id, dataset_id),
            "stats": {
                "total_media": int(stats_row["total_media"]),
                "annotated_media": int(stats_row["annotated_media"]),
                "total_annotations": int(stats_row["total_annotations"]),
                "class_counts": class_counts,
            },
            "media": media_list,
            "total": total,
        }


@app.post("/datasets/{dataset_id}/media")
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

@app.post("/annotation-batches")
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


@app.get("/annotation-batches")
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


@app.get("/annotation-batches/{batch_id}")
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


@app.post("/annotations")
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


@app.put("/annotations/{annotation_id}")
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


@app.delete("/annotations/{annotation_id}")
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


@app.get("/media/{media_asset_id}/annotations")
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


@app.post("/media/{media_asset_id}/annotations/bulk")
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


@app.post("/training-jobs")
def create_training_job_endpoint(payload: TrainingJobCreate, background_tasks: BackgroundTasks) -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)
        require_dataset(conn, project_id, payload.dataset_id)
        params = payload.model_dump()
        job = create_training_job(conn, project_id, payload.dataset_id, payload.name, params)
        background_tasks.add_task(run_job_background, job["id"])
        return job


@app.get("/training/device-status")
def training_device_status() -> dict:
    return device_status()


@app.post("/training/model-profile")
def training_model_profile(payload: ModelProfileRequest) -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)
        if payload.model_id:
            model = conn.execute(
                "SELECT id FROM models WHERE id = ? AND project_id = ?",
                (payload.model_id, project_id),
            ).fetchone()
            if not model:
                raise HTTPException(status_code=404, detail="Model not found.")
        return profile_model(conn, model_id=payload.model_id, model_path=payload.model_path)


@app.get("/training-jobs")
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


@app.get("/models")
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


@app.get("/experiments")
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


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("animal_workbench.main:app", host="127.0.0.1", port=8765, reload=False)
