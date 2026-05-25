from __future__ import annotations

import asyncio
import json
import threading

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import StreamingResponse

from ..api_helpers import require_dataset
from ..db import connect
from ..repository import current_project_id
from ..schemas import ModelProfileRequest, TrainingJobCreate
from ..services.training import (
    cancel_training_job,
    clone_training_job,
    create_training_job,
    dataset_training_summary,
    device_status,
    get_training_job,
    list_training_jobs as list_training_jobs_service,
    profile_model,
    read_job_log,
    run_training_job,
)


router = APIRouter()


@router.post("/training-jobs")
def create_training_job_endpoint(payload: TrainingJobCreate, background_tasks: BackgroundTasks) -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)
        require_dataset(conn, project_id, payload.dataset_id)
        summary = dataset_training_summary(conn, project_id, payload.dataset_id)
        if not summary["ready"]:
            raise HTTPException(status_code=422, detail={"message": "Dataset is not ready for training.", "summary": summary})
        if payload.run_yolo and payload.device not in {"auto", "cpu"}:
            status = device_status()
            if not status.get("cuda_available"):
                raise HTTPException(status_code=422, detail="CUDA is not available; choose CPU or auto before starting GPU training.")
        params = payload.model_dump()
        job = create_training_job(conn, project_id, payload.dataset_id, payload.name, params)
        background_tasks.add_task(run_job_background, job["id"])
        return job


@router.get("/training-jobs/{job_id}")
def get_training_job_endpoint(job_id: int) -> dict:
    with connect() as conn:
        try:
            return get_training_job(conn, current_project_id(conn), job_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Training job not found.")


@router.get("/training-jobs/{job_id}/events")
async def training_job_events(job_id: int) -> StreamingResponse:
    async def event_stream():
        last_payload = ""
        while True:
            with connect() as conn:
                try:
                    job = get_training_job(conn, current_project_id(conn), job_id)
                except KeyError:
                    yield "event: error\ndata: {\"detail\":\"Training job not found\"}\n\n"
                    return
            payload = json.dumps(job, ensure_ascii=False)
            if payload != last_payload:
                yield f"data: {payload}\n\n"
                last_payload = payload
            if job["status"] in {"completed", "failed", "cancelled"}:
                return
            await asyncio.sleep(2)

    return StreamingResponse(event_stream(), media_type="text/event-stream; charset=utf-8")


@router.get("/training-jobs/{job_id}/log")
def get_training_job_log(job_id: int, tail: int | None = 200) -> dict:
    with connect() as conn:
        try:
            return read_job_log(conn, current_project_id(conn), job_id, tail)
        except KeyError:
            raise HTTPException(status_code=404, detail="Training job not found.")


@router.post("/training-jobs/{job_id}/cancel")
def cancel_training_job_endpoint(job_id: int) -> dict:
    with connect() as conn:
        try:
            return cancel_training_job(conn, current_project_id(conn), job_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Training job not found.")


@router.post("/training-jobs/{job_id}/retry")
def retry_training_job_endpoint(job_id: int, background_tasks: BackgroundTasks) -> dict:
    with connect() as conn:
        try:
            job = clone_training_job(conn, current_project_id(conn), job_id, mode="retry")
        except KeyError:
            raise HTTPException(status_code=404, detail="Training job not found.")
        background_tasks.add_task(run_job_background, job["id"])
        return job


@router.post("/training-jobs/{job_id}/resume")
def resume_training_job_endpoint(job_id: int, background_tasks: BackgroundTasks) -> dict:
    with connect() as conn:
        try:
            job = clone_training_job(conn, current_project_id(conn), job_id, mode="resume")
        except KeyError:
            raise HTTPException(status_code=404, detail="Training job not found.")
        except FileNotFoundError as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        background_tasks.add_task(run_job_background, job["id"])
        return job


@router.get("/training/device-status")
def training_device_status() -> dict:
    return device_status()


@router.post("/training/model-profile")
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


@router.get("/training-jobs")
def list_training_jobs(status: str | None = None) -> list[dict]:
    with connect() as conn:
        return list_training_jobs_service(conn, current_project_id(conn), status)


@router.get("/datasets/{dataset_id}/training-summary")
def get_dataset_training_summary(dataset_id: int) -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)
        require_dataset(conn, project_id, dataset_id)
        return dataset_training_summary(conn, project_id, dataset_id)

def run_job_background(job_id: int) -> None:
    thread = threading.Thread(target=run_training_job, args=(job_id,), daemon=True)
    thread.start()
