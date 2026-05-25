from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import ensure_paths
from .db import connect, init_db
from .routers.annotations import router as annotations_router
from .routers.assisted_annotation import router as assisted_annotation_router
from .routers.classes import router as classes_router
from .routers.core import router as core_router
from .routers.dataset_jobs import router as dataset_jobs_router
from .routers.datasets import router as datasets_router
from .routers.media import router as media_router
from .routers.models import router as models_router
from .routers.training import router as training_router
from .services.assisted_annotation import runtime as assisted_annotation_runtime


@asynccontextmanager
async def lifespan(_: FastAPI):
    ensure_paths()
    init_db()
    _cleanup_stale_jobs()
    yield
    assisted_annotation_runtime.stop()


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

app.include_router(core_router)
app.include_router(classes_router)
app.include_router(dataset_jobs_router)
app.include_router(media_router)
app.include_router(datasets_router)
app.include_router(annotations_router)
app.include_router(assisted_annotation_router)
app.include_router(training_router)
app.include_router(models_router)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("animal_workbench.main:app", host="127.0.0.1", port=8765, reload=False)
