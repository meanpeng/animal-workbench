from __future__ import annotations

from contextlib import asynccontextmanager
import logging
import traceback

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import ensure_paths, get_paths
from .db import connect, init_db
from .repository import current_project, dashboard_summary, list_classes
from .routes import annotations, classes, datasets, media, public, training
from .schemas import ProjectCreate


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
        # ── dataset_jobs ──
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

        # ── training_jobs ──
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


@app.middleware("http")
async def catch_exceptions_middleware(request: Request, call_next):
    try:
        return await call_next(request)
    except Exception:
        logging.error("Unhandled exception on %s %s:\n%s", request.method, request.url.path, traceback.format_exc())
        return JSONResponse(status_code=500, content={"detail": "服务器内部错误，请查看日志了解详情"})


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


# Register route modules
app.include_router(datasets.router)
app.include_router(media.router)
app.include_router(training.router)
app.include_router(annotations.router)
app.include_router(classes.router)
app.include_router(public.router)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("animal_workbench.main:app", host="127.0.0.1", port=8765, reload=False)
