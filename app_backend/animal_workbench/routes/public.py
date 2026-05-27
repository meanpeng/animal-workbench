"""Public catalog, download, and import endpoints."""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from ..db import connect
from ..repository import current_project_id
from ..dependencies import require_dataset
from ..schemas import DatasetFolderImportRequest, PublicDatasetJobRequest
from ..services.dataset_import import import_dataset_folder
from ..services.dataset_jobs import create_dataset_job, get_dataset_job, list_dataset_jobs, start_dataset_job
from ..services.public_catalog import list_public_dataset_statuses, public_spec
from ..services.public_downloads import prepare_public_dataset
from ..services.public_import import import_public_dataset

router = APIRouter()


@router.get("/public-datasets")
def public_datasets() -> list[dict]:
    return list_public_dataset_statuses()


@router.get("/dataset-jobs")
def get_dataset_jobs(limit: int = 20) -> list[dict]:
    with connect() as conn:
        return list_dataset_jobs(conn, current_project_id(conn), limit)


@router.get("/dataset-jobs/{job_id}")
def get_dataset_job_endpoint(job_id: int) -> dict:
    with connect() as conn:
        try:
            return get_dataset_job(conn, job_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Dataset job not found.")


@router.get("/dataset-jobs/{job_id}/events")
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

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/dataset-jobs/import-folder")
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


@router.post("/dataset-jobs/public/{key}/download")
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


@router.post("/dataset-jobs/public/{key}/import")
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
