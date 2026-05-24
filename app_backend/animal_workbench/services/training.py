from __future__ import annotations

import csv
import os
import platform
import json
import shutil
import sqlite3
import subprocess
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

    for row in rows:
        split = row["split"] if row["split"] in {"train", "val", "test"} else "train"
        source = Path(row["internal_path"])
        target_name = f"{row['media_id']}_{source.name}"
        image_target = export_root / "images" / split / target_name
        if source.exists():
            shutil.copy2(source, image_target)

        annotations = conn.execute(
            """
            SELECT class_id, x, y, width, height
            FROM annotations
            WHERE media_asset_id = ? AND review_status IN ('draft', 'confirmed')
            ORDER BY id
            """,
            (row["media_id"],),
        ).fetchall()
        label_target = export_root / "labels" / split / f"{Path(target_name).stem}.txt"
        with label_target.open("w", encoding="utf-8", newline="\n") as handle:
            for annotation in annotations:
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
        model_name = _training_model_source(conn, params) or "yolo11n.pt"
        model = YOLO(model_name)
        train_args: dict[str, Any] = {
            "data": str(yaml_path),
            "epochs": int(params["epochs"]),
            "imgsz": int(params["image_size"]),
            "batch": int(params["batch_size"]),
            "device": params["device"],
            "project": str(paths.runtime_dir / "runs"),
            "name": f"job_{job_id}",
            "exist_ok": True,
        }
        if params.get("mode") == "resume":
            train_args["resume"] = True
        else:
            freeze_layers = int(params.get("advanced", {}).get("freeze_layers") or 0)
            if freeze_layers > 0:
                train_args["freeze"] = freeze_layers
        results = model.train(**train_args)
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


def _training_model_source(conn: sqlite3.Connection, params: dict[str, Any]) -> str | None:
    if params.get("mode") == "resume":
        checkpoint_path = params.get("checkpoint_path")
        if checkpoint_path:
            return str(checkpoint_path)
        resume_job_id = params.get("resume_job_id")
        if resume_job_id:
            row = conn.execute(
                """
                SELECT artifact_refs
                FROM experiments
                WHERE training_job_id = ?
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (int(resume_job_id),),
            ).fetchone()
            refs = json_loads(row["artifact_refs"], {}) if row else {}
            run_dir = Path(refs.get("run_dir", ""))
            last_path = run_dir / "weights" / "last.pt"
            if last_path.exists():
                return str(last_path)

    base_model_path = params.get("base_model_path")
    if base_model_path:
        return str(base_model_path)
    base_model_id = params.get("base_model_id")
    if base_model_id:
        row = conn.execute(
            "SELECT internal_weight_path FROM models WHERE id = ?",
            (int(base_model_id),),
        ).fetchone()
        if row and row["internal_weight_path"]:
            return str(row["internal_weight_path"])
    return None


def device_status() -> dict[str, Any]:
    memory = _system_memory()
    status: dict[str, Any] = {
        "cpu": {
            "name": platform.processor() or platform.machine() or "CPU",
            "cores": os.cpu_count() or 0,
        },
        "memory": memory,
        "python": sys.version.split()[0],
        "cuda_available": False,
        "torch_available": False,
        "ultralytics_available": False,
        "gpus": [],
    }

    try:
        import torch

        status["torch_available"] = True
        status["cuda_available"] = bool(torch.cuda.is_available())
        if torch.cuda.is_available():
            gpus = []
            for index in range(torch.cuda.device_count()):
                props = torch.cuda.get_device_properties(index)
                allocated = int(torch.cuda.memory_allocated(index))
                reserved = int(torch.cuda.memory_reserved(index))
                gpus.append(
                    {
                        "index": index,
                        "name": props.name,
                        "total_memory": int(props.total_memory),
                        "allocated_memory": allocated,
                        "reserved_memory": reserved,
                    }
                )
            status["gpus"] = gpus
    except Exception as exc:
        status["torch_error"] = str(exc)

    try:
        import ultralytics  # noqa: F401

        status["ultralytics_available"] = True
    except Exception as exc:
        status["ultralytics_error"] = str(exc)

    if not status["gpus"]:
        status["gpus"] = _nvidia_smi_gpus()
    return status


def profile_model(conn: sqlite3.Connection, model_id: int | None = None, model_path: str | None = None) -> dict[str, Any]:
    source = model_path
    model_name = model_path
    if model_id:
        row = conn.execute("SELECT name, internal_weight_path FROM models WHERE id = ?", (model_id,)).fetchone()
        if row:
            model_name = row["name"]
            source = row["internal_weight_path"]
    source = source or "yolo11n.pt"

    try:
        from ultralytics import YOLO

        yolo = YOLO(str(source))
        module = yolo.model
        layers = getattr(module, "model", None)
        layer_count = len(layers) if layers is not None else len(list(module.modules()))
        total_params = sum(parameter.numel() for parameter in module.parameters())
        trainable_params = sum(parameter.numel() for parameter in module.parameters() if parameter.requires_grad)
        return {
            "ok": True,
            "name": model_name or str(source),
            "source": str(source),
            "model_type": yolo.task or "detect",
            "layer_count": int(layer_count),
            "parameters": int(total_params),
            "trainable_parameters": int(trainable_params),
            "error": None,
        }
    except Exception as exc:
        return {
            "ok": False,
            "name": model_name or str(source),
            "source": str(source),
            "model_type": "unknown",
            "layer_count": None,
            "parameters": None,
            "trainable_parameters": None,
            "error": str(exc),
        }


def _system_memory() -> dict[str, int | None]:
    try:
        if sys.platform == "win32":
            import ctypes

            class MemoryStatus(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("sullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            stat = MemoryStatus()
            stat.dwLength = ctypes.sizeof(MemoryStatus)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
            return {
                "total": int(stat.ullTotalPhys),
                "available": int(stat.ullAvailPhys),
                "used": int(stat.ullTotalPhys - stat.ullAvailPhys),
                "percent": int(stat.dwMemoryLoad),
            }
        pages = os.sysconf("SC_PHYS_PAGES")
        page_size = os.sysconf("SC_PAGE_SIZE")
        total = int(pages * page_size)
        return {"total": total, "available": None, "used": None, "percent": None}
    except Exception:
        return {"total": None, "available": None, "used": None, "percent": None}


def _nvidia_smi_gpus() -> list[dict[str, Any]]:
    try:
        output = subprocess.check_output(
            [
                "nvidia-smi",
                "--query-gpu=index,name,memory.total,memory.used,memory.free",
                "--format=csv,noheader,nounits",
            ],
            text=True,
            timeout=3,
        )
    except Exception:
        return []

    gpus = []
    for line in output.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) != 5:
            continue
        index, name, total, used, free = parts
        gpus.append(
            {
                "index": int(index),
                "name": name,
                "total_memory": int(total) * 1024 * 1024,
                "used_memory": int(used) * 1024 * 1024,
                "free_memory": int(free) * 1024 * 1024,
            }
        )
    return gpus
