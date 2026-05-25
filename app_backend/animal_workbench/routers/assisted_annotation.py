from __future__ import annotations

from fastapi import APIRouter

from ..api_helpers import require_dataset, require_media_in_dataset
from ..db import connect
from ..repository import current_project_id
from ..schemas import AssistedAnnotationPredictRequest, AssistedAnnotationStart
from ..services.assisted_annotation import assisted_annotation_settings, runtime


router = APIRouter()


@router.post("/assisted-annotation/start")
def start_assisted_annotation(payload: AssistedAnnotationStart) -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)
        require_dataset(conn, project_id, payload.dataset_id)
        settings = assisted_annotation_settings(conn)
    return {"settings": settings, **runtime.start(settings)}


@router.post("/assisted-annotation/stop")
def stop_assisted_annotation() -> dict:
    return runtime.stop()


@router.get("/assisted-annotation/status")
def assisted_annotation_status() -> dict:
    return runtime.status()


@router.post("/assisted-annotation/predict")
def predict_assisted_annotation(payload: AssistedAnnotationPredictRequest) -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)
        require_dataset(conn, project_id, payload.dataset_id)
        for media_id in payload.media_asset_ids:
            require_media_in_dataset(conn, project_id, payload.dataset_id, media_id)
        settings = assisted_annotation_settings(conn)
        if not settings.get("enabled"):
            return {"settings": settings, "loaded": False, "results": []}
        return runtime.predict(conn, project_id, payload.dataset_id, payload.media_asset_ids, settings)
