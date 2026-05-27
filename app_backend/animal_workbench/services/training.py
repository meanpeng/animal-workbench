from __future__ import annotations

import csv
import json
import shutil
import sqlite3
import sys
from pathlib import Path
from typing import Any

from ..config import AppPaths, get_paths
from ..repository import json_dumps, json_loads


def create_training_job(
    conn: sqlite3.Connection,
    project_id: int,
    dataset_id: int,
    name: str,
    params: dict[str, Any],
) -> dict[str, Any]:
    cursor = conn.execute(
        """
        INSERT INTO training_jobs(project_id, dataset_id, name, params)
        VALUES(?, ?, ?, ?)
        """,
        (project_id, dataset_id, name, json_dumps(params)),
    )
    conn.commit()
    return dict(conn.execute("SELECT * FROM training_jobs WHERE id = ?", (cursor.lastrowid,)).fetchone())


def export_yolo_dataset(conn: sqlite3.Connection, job_id: int, paths: AppPaths | None = None) -> Path:
    paths = paths or get_paths()
    job = conn.execute("SELECT * FROM training_jobs WHERE id = ?", (job_id,)).fetchone()
    if job is None:
        raise ValueError(f"Training job {job_id} does not exist.")

    export_root = paths.runtime_dir / "yolo_exports" / f"job_{job_id}"
    if export_root.exists():
        shutil.rmtree(export_root)
    for split in ("train", "val", "test"):
        (export_root / "images" / split).mkdir(parents=True, exist_ok=True)
        (export_root / "labels" / split).mkdir(parents=True, exist_ok=True)

    classes = conn.execute(
        """
        SELECT cl.id, cl.display_name
        FROM dataset_classes dc
        JOIN classes cl ON cl.id = dc.class_id
        WHERE dc.dataset_id = ? AND cl.project_id = ?
        ORDER BY dc.sort_order, cl.sort_order, cl.id
        """,
        (job["dataset_id"], job["project_id"]),
    ).fetchall()
    class_index = {int(row["id"]): index for index, row in enumerate(classes)}

    rows = conn.execute(
        """
        SELECT da.split, ma.id AS media_id, ma.internal_path, ma.original_name
        FROM dataset_assets da
        JOIN media_assets ma ON ma.id = da.media_asset_id
        WHERE da.dataset_id = ? AND ma.media_type = 'image'
        ORDER BY ma.id
        """,
        (job["dataset_id"],),
    ).fetchall()

    # Batch-load all annotations for the dataset to avoid N+1 queries
    media_ids = [row["media_id"] for row in rows]
    annotations_by_media: dict[int, list[dict]] = {}
    if media_ids:
        placeholders = ",".join("?" for _ in media_ids)
        ann_rows = conn.execute(
            f"""
            SELECT media_asset_id, class_id, x, y, width, height
            FROM annotations
            WHERE media_asset_id IN ({placeholders}) AND review_status IN ('draft', 'confirmed')
            ORDER BY id
            """,
            media_ids,
        ).fetchall()
        for ann in ann_rows:
            mid = int(ann["media_asset_id"])
            annotations_by_media.setdefault(mid, []).append(dict(ann))

    for row in rows:
        split = row["split"] if row["split"] in {"train", "val", "test"} else "train"
        source = Path(row["internal_path"])
        target_name = f"{row['media_id']}_{source.name}"
        image_target = export_root / "images" / split / target_name
        if source.exists():
            shutil.copy2(source, image_target)

        label_target = export_root / "labels" / split / f"{Path(target_name).stem}.txt"
        with label_target.open("w", encoding="utf-8", newline="\n") as handle:
            for annotation in annotations_by_media.get(row["media_id"], []):
                if int(annotation["class_id"]) not in class_index:
                    continue
                cx = float(annotation["x"]) + float(annotation["width"]) / 2
                cy = float(annotation["y"]) + float(annotation["height"]) / 2
                handle.write(
                    f"{class_index[int(annotation['class_id'])]} {cx:.6f} {cy:.6f} "
                    f"{float(annotation['width']):.6f} {float(annotation['height']):.6f}\n"
                )

    yaml_path = export_root / "dataset.yaml"
    names = [row["display_name"] for row in classes]
    yaml_path.write_text(
        "\n".join(
            [
                f"path: {export_root.as_posix()}",
                "train: images/train",
                "val: images/val",
                "test: images/test",
                f"nc: {len(names)}",
                "names:",
                *[f"  {index}: {json.dumps(name, ensure_ascii=False)}" for index, name in enumerate(names)],
                "",
            ]
        ),
        encoding="utf-8",
    )
    conn.execute(
        """
        UPDATE training_jobs
        SET status = 'exported', runtime_dataset_path = ?, log_path = ?
        WHERE id = ?
        """,
        (str(yaml_path), str(paths.log_dir / f"training_job_{job_id}.log"), job_id),
    )
    conn.commit()
    return yaml_path


def run_training_job(conn: sqlite3.Connection, job_id: int, paths: AppPaths | None = None) -> dict[str, Any]:
    paths = paths or get_paths()
    yaml_path = export_yolo_dataset(conn, job_id, paths)
    job = conn.execute("SELECT * FROM training_jobs WHERE id = ?", (job_id,)).fetchone()
    params = json_loads(job["params"], {})

    if not params.get("run_yolo", False):
        conn.execute(
            """
            UPDATE training_jobs
            SET status = 'exported', ended_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (job_id,),
        )
        conn.commit()
        return {"status": "exported", "dataset_yaml": str(yaml_path)}

    try:
        from ultralytics import YOLO

        conn.execute(
            "UPDATE training_jobs SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ?",
            (job_id,),
        )
        conn.commit()
        model_name = params.get("base_model_path") or "yolo26n.pt"
        model = YOLO(model_name)
        results = model.train(
            data=str(yaml_path),
            epochs=int(params["epochs"]),
            imgsz=int(params["image_size"]),
            batch=int(params["batch_size"]),
            device=params["device"],
            project=str(paths.runtime_dir / "runs"),
            name=f"job_{job_id}",
            exist_ok=True,
        )
        run_dir = Path(getattr(results, "save_dir", paths.runtime_dir / "runs" / f"job_{job_id}"))
        model_id = register_completed_training(conn, job_id, run_dir)
        conn.execute(
            """
            UPDATE training_jobs
            SET status = 'completed', ended_at = CURRENT_TIMESTAMP, output_model_id = ?
            WHERE id = ?
            """,
            (model_id, job_id),
        )
        conn.commit()
        return {"status": "completed", "model_id": model_id}
    except Exception as exc:
        conn.execute(
            """
            UPDATE training_jobs
            SET status = 'failed', ended_at = CURRENT_TIMESTAMP, error_message = ?
            WHERE id = ?
            """,
            (str(exc), job_id),
        )
        conn.commit()
        raise


def register_completed_training(conn: sqlite3.Connection, job_id: int, run_dir: Path) -> int | None:
    job = conn.execute("SELECT * FROM training_jobs WHERE id = ?", (job_id,)).fetchone()
    metrics = parse_results_csv(run_dir / "results.csv")
    best_path = run_dir / "weights" / "best.pt"
    cursor = conn.execute(
        """
        INSERT INTO models(project_id, name, source_experiment_id, metrics_summary, internal_weight_path, is_recommended)
        VALUES(?, ?, NULL, ?, ?, 1)
        """,
        (
            job["project_id"],
            f"{job['name']} best",
            json_dumps(metrics),
            str(best_path) if best_path.exists() else None,
        ),
    )
    model_id = int(cursor.lastrowid)
    exp_cursor = conn.execute(
        """
        INSERT INTO experiments(project_id, training_job_id, name, val_metrics, artifact_refs, best_model_id)
        VALUES(?, ?, ?, ?, ?, ?)
        """,
        (
            job["project_id"],
            job_id,
            job["name"],
            json_dumps(metrics),
            json_dumps({"run_dir": str(run_dir)}),
            model_id,
        ),
    )
    conn.execute("UPDATE models SET source_experiment_id = ? WHERE id = ?", (exp_cursor.lastrowid, model_id))
    return model_id


def parse_results_csv(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    if not rows:
        return {}
    last = rows[-1]
    return {key.strip(): _coerce_metric(value) for key, value in last.items() if key}


def _coerce_metric(value: str) -> float | str:
    try:
        return float(value)
    except (TypeError, ValueError):
        return value
