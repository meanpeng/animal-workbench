from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from ..api_helpers import _cleanup_orphan_media, _cleanup_public_dataset_cache, require_dataset, require_dataset_class, require_media_assets
from ..class_colors import class_color_for_index
from ..db import connect, rows_to_dicts
from ..repository import current_project_id, list_dataset_classes
from ..schemas import AnnotationImportRequest, DatasetCreate, DatasetFusionCreate, DatasetMediaAdd
from ..services.datasets import add_media_to_dataset, create_dataset, create_fusion_dataset
from ..services.dataset_jobs import create_dataset_job, start_dataset_job


router = APIRouter()


@router.post("/datasets")
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


@router.post("/datasets/fusion")
def create_fusion_dataset_endpoint(payload: DatasetFusionCreate) -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)
        try:
            return create_fusion_dataset(conn, project_id, payload.name, payload.source_dataset_ids)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))


@router.post("/dataset-jobs/fusion")
def start_fusion_dataset_job(payload: DatasetFusionCreate) -> dict:
    with connect() as conn:
        project_id = current_project_id(conn)
        job = create_dataset_job(
            conn,
            project_id,
            "fusion_build",
            payload.model_dump(),
            message="融合数据集构建任务已排队",
        )

    def run(reporter):
        reporter.update(stage="building", percent=10, message="正在从已选数据集构建融合数据集")
        with connect() as thread_conn:
            result = create_fusion_dataset(
                thread_conn,
                project_id,
                payload.name,
                payload.source_dataset_ids,
            )
        reporter.complete(result, f"融合数据集「{result['name']}」已构建")

    start_dataset_job(job["id"], run)
    return job


@router.get("/datasets")
def list_datasets() -> list[dict]:
    with connect() as conn:
        return rows_to_dicts(
            conn.execute(
                "SELECT * FROM datasets WHERE project_id = ? ORDER BY updated_at DESC",
                (current_project_id(conn),),
            )
        )


@router.delete("/datasets/{dataset_id}")
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

        dataset_for_cleanup = dict(dataset)

        # delete the dataset (cascade deletes dataset_assets)
        conn.execute("DELETE FROM datasets WHERE id = ?", (dataset_id,))

        # clean up orphaned media assets and their files
        _cleanup_orphan_media(conn, project_id)
        _cleanup_public_dataset_cache(dataset_for_cleanup)

        conn.commit()
        return {"deleted": dataset_id}


@router.get("/datasets/{dataset_id}/annotations/export")
def export_annotations(dataset_id: int) -> StreamingResponse:
    import io
    import yaml as _yaml
    import zipfile

    with connect() as conn:
        project_id = current_project_id(conn)
        dataset = conn.execute(
            "SELECT * FROM datasets WHERE id = ? AND project_id = ?",
            (dataset_id, project_id),
        ).fetchone()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found.")

        class_rows = conn.execute(
            """
            SELECT cl.id, cl.name
            FROM dataset_classes dc
            JOIN classes cl ON cl.id = dc.class_id
            WHERE dc.dataset_id = ?
            ORDER BY dc.sort_order, cl.sort_order, cl.id
            """,
            (dataset_id,),
        ).fetchall()
        class_list = [row["name"] for row in class_rows]
        class_id_to_index = {row["id"]: idx for idx, row in enumerate(class_rows)}

        media_rows = conn.execute(
            """
            SELECT ma.id, ma.original_name
            FROM dataset_assets da
            JOIN media_assets ma ON ma.id = da.media_asset_id
            WHERE da.dataset_id = ? AND ma.project_id = ?
            ORDER BY ma.id
            """,
            (dataset_id, project_id),
        ).fetchall()

        media_ids = [row["id"] for row in media_rows]
        annotations_by_media: dict[int, list] = {}
        if media_ids and class_id_to_index:
            placeholders = ",".join("?" for _ in media_ids)
            class_placeholders = ",".join("?" for _ in class_id_to_index)
            ann_rows = conn.execute(
                f"""
                SELECT a.media_asset_id, a.class_id, a.x, a.y, a.width, a.height
                FROM annotations a
                WHERE a.project_id = ?
                  AND a.media_asset_id IN ({placeholders})
                  AND a.class_id IN ({class_placeholders})
                ORDER BY a.id
                """,
                (project_id, *media_ids, *class_id_to_index.keys()),
            ).fetchall()
            for row in ann_rows:
                annotations_by_media.setdefault(row["media_asset_id"], []).append(row)

        # Collision-safe stem tracking
        seen: dict[str, int] = {}
        label_entries: list[tuple[str, str]] = []

        for media in media_rows:
            stem = Path(media["original_name"]).stem
            count = seen.get(stem, 0)
            seen[stem] = count + 1
            key = f"{stem}_{count}" if count > 0 else stem

            anns = annotations_by_media.get(media["id"], [])
            lines = []
            for ann in anns:
                class_idx = class_id_to_index.get(ann["class_id"])
                if class_idx is None:
                    continue
                cx = ann["x"] + ann["width"] / 2
                cy = ann["y"] + ann["height"] / 2
                lines.append(f"{class_idx} {cx:.6f} {cy:.6f} {ann['width']:.6f} {ann['height']:.6f}")
            label_entries.append((f"{key}.txt", "\n".join(lines)))

        yaml_content = _yaml.dump(
            {"names": class_list, "nc": len(class_list)},
            allow_unicode=True,
            default_flow_style=False,
        )

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("dataset.yaml", yaml_content)
            for name, content in label_entries:
                zf.writestr(f"labels/{name}", content)
        buf.seek(0)

        safe_name = dataset["name"].replace("/", "_").replace("\\", "_")
        return StreamingResponse(
            buf,
            media_type="application/zip",
            headers={
                "Content-Disposition": f'attachment; filename="{safe_name}_annotations.zip"',
            },
        )


@router.post("/datasets/{dataset_id}/annotations/import")
def import_annotations(dataset_id: int, payload: AnnotationImportRequest) -> dict:
    from pathlib import Path as _Path
    from ..services.annotation_parsers import parse_dataset_folder

    folder_path = _Path(payload.folder_path).expanduser().resolve()
    if not folder_path.exists() or not folder_path.is_dir():
        raise HTTPException(status_code=422, detail="所选文件夹不存在。")

    parsed = parse_dataset_folder(folder_path)
    if parsed is None:
        raise HTTPException(status_code=422, detail="未能从所选文件夹解析出标注数据。")

    with connect() as conn:
        project_id = current_project_id(conn)
        dataset = conn.execute(
            "SELECT * FROM datasets WHERE id = ? AND project_id = ?",
            (dataset_id, project_id),
        ).fetchone()
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset not found.")

        # Build media stem -> id mapping for media in this dataset
        media_rows = conn.execute(
            """
            SELECT ma.id, ma.original_name
            FROM dataset_assets da
            JOIN media_assets ma ON ma.id = da.media_asset_id
            WHERE da.dataset_id = ? AND ma.project_id = ?
            """,
            (dataset_id, project_id),
        ).fetchall()
        stem_to_media: dict[str, list[int]] = {}
        for row in media_rows:
            stem = _Path(row["original_name"]).stem
            stem_to_media.setdefault(stem, []).append(row["id"])

        # Resolve class ids: map class_name -> class_id (create if needed)
        existing_classes = {
            row["name"]: row["id"]
            for row in conn.execute(
                "SELECT id, name FROM classes WHERE project_id = ?",
                (project_id,),
            ).fetchall()
        }
        class_name_to_id: dict[str, int] = {}
        class_ids_to_bind: list[int] = []
        for name in parsed.classes:
            if name in existing_classes:
                cid = existing_classes[name]
            else:
                row = conn.execute(
                    "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM classes WHERE project_id = ?",
                    (project_id,),
                ).fetchone()
                sort_order = int(row["next_order"])
                cursor = conn.execute(
                    "INSERT INTO classes(project_id, name, display_name, color, sort_order) VALUES(?, ?, ?, ?, ?)",
                    (project_id, name, name, class_color_for_index(sort_order), sort_order),
                )
                cid = int(cursor.lastrowid)
                existing_classes[name] = cid
            class_name_to_id[name] = cid
            class_ids_to_bind.append(cid)

        # Bind any new classes to the dataset
        from ..services.datasets import bind_classes_to_dataset
        bind_classes_to_dataset(conn, project_id, dataset_id, class_ids_to_bind)

        # Match samples to media and import annotations
        matched = 0
        total_boxes = 0
        for sample in parsed.samples:
            stem = sample.image_path.stem
            candidates = stem_to_media.get(stem, [])
            if not candidates:
                continue
            # Use the first match; delete old annotations only for dataset classes
            media_id = candidates[0]
            matched += 1

            # Remove existing annotations for this media that belong to this dataset's classes
            conn.execute(
                """
                DELETE FROM annotations
                WHERE media_asset_id = ? AND project_id = ?
                  AND class_id IN (SELECT class_id FROM dataset_classes WHERE dataset_id = ?)
                """,
                (media_id, project_id, dataset_id),
            )

            # Insert new boxes
            for box in sample.boxes:
                cid = class_name_to_id.get(box.class_name)
                if cid is None:
                    continue
                conn.execute(
                    """
                    INSERT INTO annotations(project_id, media_asset_id, class_id, x, y, width, height, review_status)
                    VALUES(?, ?, ?, ?, ?, ?, ?, 'draft')
                    """,
                    (project_id, media_id, cid, box.x, box.y, box.width, box.height),
                )
                total_boxes += 1

        # Refresh counts
        from ..services.datasets import refresh_dataset_counts
        refresh_dataset_counts(conn, project_id, dataset_id)
        conn.commit()

        return {
            "ok": True,
            "matched_media": matched,
            "imported_boxes": total_boxes,
            "classes": parsed.classes,
            "format": parsed.format,
        }


@router.get("/datasets/{dataset_id}/media")
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
                COUNT(DISTINCT CASE
                    WHEN da.annotation_status = 'annotated' THEN da.media_asset_id
                    WHEN a.id IS NOT NULL THEN da.media_asset_id
                END) AS annotated_media
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
                (da.annotation_status = 'annotated' OR EXISTS (
                    SELECT 1
                    FROM annotations a2
                    JOIN dataset_classes dc2 ON dc2.dataset_id = ? AND dc2.class_id = a2.class_id
                    WHERE a2.media_asset_id = ma.id AND a2.project_id = ?
                ))
                """
            )
            params.extend([dataset_id, project_id])
        elif annotation_status == "unannotated":
            conditions.append(
                """
                da.annotation_status = 'unannotated' AND NOT EXISTS (
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
                    ma.camera_site, ma.width, ma.height, ma.created_at,
                    da.annotation_status
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
        _CHUNK = 500
        if media_ids:
            for ci in range(0, len(media_ids), _CHUNK):
                chunk = media_ids[ci : ci + _CHUNK]
                placeholders = ",".join("?" for _ in chunk)
                ann_rows = conn.execute(
                    f"""
                    SELECT a.media_asset_id, COUNT(*) AS cnt
                    FROM annotations a
                    JOIN dataset_classes dc ON dc.dataset_id = ? AND dc.class_id = a.class_id
                    WHERE a.media_asset_id IN ({placeholders}) AND a.project_id = ?
                    GROUP BY a.media_asset_id
                    """,
                    [dataset_id, *chunk, project_id],
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
                    [dataset_id, *chunk, project_id],
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
                "annotation_status": row["annotation_status"],
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


@router.post("/datasets/{dataset_id}/media")
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
