from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from ..api_helpers import _cleanup_orphan_media
from ..db import connect, rows_to_dicts
from ..repository import current_project_id
from ..schemas import MediaImportRequest
from ..services.media import import_media


router = APIRouter()


@router.post("/media/import")
def import_media_endpoint(payload: MediaImportRequest) -> dict:
    with connect() as conn:
        return import_media(
            conn,
            current_project_id(conn),
            payload.paths,
            batch_name=payload.batch_name,
            camera_site=payload.camera_site,
            extract_frames=payload.extract_frames,
            skip_copy=not payload.copy_files,
        )


@router.get("/media")
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

@router.post("/media/cleanup-orphans")
def cleanup_orphan_media() -> dict:
    """Delete media files and rows that are not referenced by any dataset."""
    with connect() as conn:
        project_id = current_project_id(conn)
        deleted_rows, deleted_files = _cleanup_orphan_media(conn, project_id)
        conn.commit()
        return {"deleted_rows": deleted_rows, "deleted_files": deleted_files}


@router.get("/media/{media_asset_id}/content")
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
