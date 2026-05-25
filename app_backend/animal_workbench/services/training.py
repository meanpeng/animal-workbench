from __future__ import annotations

import csv
from collections import deque
from contextlib import redirect_stderr, redirect_stdout
import os
import platform
import json
import random as _random
import re as _re
import shutil
import sqlite3
import subprocess
import sys
import threading
import traceback
from pathlib import Path
from typing import Any

from ..config import AppPaths, get_paths
from ..repository import json_dumps, json_loads

# --- CSV parse cache: keyed by (path, mtime, size) to avoid re-reading unchanged files ---
_csv_cache: dict[tuple[str, float, int], dict[str, Any]] = {}
_csv_cache_order: list[tuple[str, float, int]] = []

# --- Windows memory status ctypes struct (module-level to avoid re-creation) ---
import ctypes as _ctypes

if sys.platform == "win32":
    class _MemoryStatus(_ctypes.Structure):
        _fields_ = [
            ("dwLength", _ctypes.c_ulong),
            ("dwMemoryLoad", _ctypes.c_ulong),
            ("ullTotalPhys", _ctypes.c_ulonglong),
            ("ullAvailPhys", _ctypes.c_ulonglong),
            ("ullTotalPageFile", _ctypes.c_ulonglong),
            ("ullAvailPageFile", _ctypes.c_ulonglong),
            ("ullTotalVirtual", _ctypes.c_ulonglong),
            ("ullAvailVirtual", _ctypes.c_ulonglong),
            ("sullAvailExtendedVirtual", _ctypes.c_ulonglong),
        ]

_TQDM_RE = _re.compile(r"\d+(?:\.\d+)?(?:it/s|s/it)")

_active_jobs: dict[int, threading.Event] = {}


_MAX_CSV_CACHE = 64


def _register_active_job(job_id: int) -> threading.Event:
    event = threading.Event()
    _active_jobs[job_id] = event
    return event


def _unregister_active_job(job_id: int) -> None:
    _active_jobs.pop(job_id, None)


def _is_cancel_requested(job_id: int) -> bool:
    event = _active_jobs.get(job_id)
    return event is not None and event.is_set()


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
    job_id = int(cursor.lastrowid)
    log_path = get_paths().log_dir / f"training_job_{job_id}.log"
    conn.execute("UPDATE training_jobs SET log_path = ? WHERE id = ?", (str(log_path), job_id))
    conn.commit()
    append_job_log(job_id, f"Created training job {job_id}: {name}")
    return dict(conn.execute("SELECT * FROM training_jobs WHERE id = ?", (job_id,)).fetchone())


def get_training_job(conn: sqlite3.Connection, project_id: int, job_id: int) -> dict[str, Any]:
    row = conn.execute(
        "SELECT * FROM training_jobs WHERE id = ? AND project_id = ?",
        (job_id, project_id),
    ).fetchone()
    if row is None:
        raise KeyError(job_id)
    return enrich_training_job(conn, dict(row))


def list_training_jobs(conn: sqlite3.Connection, project_id: int, status: str | None = None) -> list[dict[str, Any]]:
    if status and status != "all":
        rows = conn.execute(
            """
            SELECT *
            FROM training_jobs
            WHERE project_id = ? AND status = ?
            ORDER BY created_at DESC
            """,
            (project_id, status),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT *
            FROM training_jobs
            WHERE project_id = ?
            ORDER BY created_at DESC
            """,
            (project_id,),
        ).fetchall()
    return [enrich_training_job(conn, dict(row)) for row in rows]


def enrich_training_job(conn: sqlite3.Connection, job: dict[str, Any]) -> dict[str, Any]:
    params = json_loads(job.get("params"), {})
    run_dir = training_run_dir(job["id"])
    metrics = parse_results_csv(run_dir / "results.csv")
    current_epoch = _metric_epoch(metrics)
    total_epochs = int(params.get("epochs") or 0)
    job["params_json"] = params
    job["run_dir"] = str(run_dir) if run_dir.exists() else None
    job["results_csv_path"] = str(run_dir / "results.csv") if (run_dir / "results.csv").exists() else None
    job["metrics"] = summarize_metrics(metrics)
    job["raw_metrics"] = metrics
    job["current_epoch"] = current_epoch
    job["total_epochs"] = total_epochs
    job["progress"] = training_progress(job["status"], current_epoch, total_epochs)
    job["stage"] = training_stage(job["status"], params, current_epoch)
    job["error_summary"] = error_summary(job)
    job["artifact_refs"] = training_artifact_refs(run_dir)
    return job


def training_run_dir(job_id: int, paths: AppPaths | None = None) -> Path:
    paths = paths or get_paths()
    return paths.runtime_dir / "runs" / f"job_{job_id}"


def _filter_progress_lines(text: str) -> str:
    """Collapse consecutive tqdm progress-bar lines, keeping only the last of each run."""
    result: list[str] = []
    buf: list[str] = []
    for line in text.splitlines():
        if _TQDM_RE.search(line):
            buf.append(line)
        else:
            if buf:
                result.append(buf[-1])
                buf = []
            result.append(line)
    if buf:
        result.append(buf[-1])
    return "\n".join(result)


def append_job_log(job_id: int, message: str, paths: AppPaths | None = None) -> Path:
    paths = paths or get_paths()
    paths.log_dir.mkdir(parents=True, exist_ok=True)
    log_path = paths.log_dir / f"training_job_{job_id}.log"
    with log_path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(f"{message.rstrip()}\n")
    return log_path


def read_job_log(conn: sqlite3.Connection, project_id: int, job_id: int, tail: int | None = None) -> dict[str, Any]:
    job = get_training_job(conn, project_id, job_id)
    log_path = Path(job["log_path"] or get_paths().log_dir / f"training_job_{job_id}.log")
    if not log_path.exists():
        return {"job_id": job_id, "log_path": str(log_path), "text": "", "line_count": 0}
    if tail and tail > 0:
        text, line_count = _tail_file(log_path, tail)
    else:
        text = log_path.read_text(encoding="utf-8", errors="replace")
        line_count = text.count("\n") + (0 if text.endswith("\n") else 0) if text else 0
    return {"job_id": job_id, "log_path": str(log_path), "text": _filter_progress_lines(text), "line_count": line_count}


def _tail_file(path: Path, n: int) -> tuple[str, int]:
    """Read the last *n* lines from a file without loading the entire contents."""
    block_size = 8192
    with path.open("rb") as handle:
        handle.seek(0, 2)
        file_size = handle.tell()
        if file_size == 0:
            return "", 0
        chunks: list[bytes] = []
        remaining = file_size
        newline_count = 0
        while remaining > 0 and newline_count < n + 1:
            read_size = min(block_size, remaining)
            remaining -= read_size
            handle.seek(remaining)
            chunk = handle.read(read_size)
            newline_count += chunk.count(b"\n")
            chunks.append(chunk)
        raw = b"".join(reversed(chunks))
    text = raw.decode("utf-8", errors="replace")
    lines = text.splitlines()
    total_approx = newline_count
    return "\n".join(lines[-n:]), total_approx


def cancel_training_job(conn: sqlite3.Connection, project_id: int, job_id: int) -> dict[str, Any]:
    job = get_training_job(conn, project_id, job_id)
    if job["status"] in {"completed", "failed", "cancelled"}:
        return job
    cancel_event = _active_jobs.get(job_id)
    if cancel_event is not None:
        cancel_event.set()
    conn.execute(
        """
        UPDATE training_jobs
        SET status = 'cancelled',
            ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP),
            error_message = COALESCE(error_message, 'Training job was cancelled by the user.')
        WHERE id = ? AND project_id = ?
        """,
        (job_id, project_id),
    )
    conn.commit()
    append_job_log(job_id, "Cancellation requested. Training process will stop after the current epoch.")
    return get_training_job(conn, project_id, job_id)


def clone_training_job(conn: sqlite3.Connection, project_id: int, job_id: int, mode: str = "retry") -> dict[str, Any]:
    job = get_training_job(conn, project_id, job_id)
    params = dict(job["params_json"])
    if mode == "resume":
        last_path = find_last_checkpoint(job)
        if not last_path:
            raise FileNotFoundError("No last.pt checkpoint was found for this training job.")
        params["mode"] = "resume"
        params["resume_job_id"] = job_id
        params["checkpoint_path"] = str(last_path)
    else:
        params["mode"] = "train"
        params.pop("checkpoint_path", None)
        params.pop("resume_job_id", None)
    suffix = "resume" if mode == "resume" else "retry"
    return create_training_job(conn, project_id, int(job["dataset_id"]), f"{job['name']} {suffix}", params)


def find_last_checkpoint(job: dict[str, Any]) -> Path | None:
    refs = job.get("artifact_refs") or {}
    candidates = [
        refs.get("last_pt"),
        (Path(job["run_dir"]) / "weights" / "last.pt") if job.get("run_dir") else None,
    ]
    params = job.get("params_json") or {}
    if params.get("checkpoint_path"):
        candidates.append(params["checkpoint_path"])
    for candidate in candidates:
        if not candidate:
            continue
        path = Path(candidate)
        if path.exists():
            return path
    return None


def export_yolo_dataset(conn: sqlite3.Connection, job_id: int, paths: AppPaths | None = None) -> Path:
    paths = paths or get_paths()
    job = conn.execute("SELECT * FROM training_jobs WHERE id = ?", (job_id,)).fetchone()
    if job is None:
        raise ValueError(f"Training job {job_id} does not exist.")

    append_job_log(job_id, "Exporting dataset to YOLO layout.")
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

    _rng = _random.Random(42)
    unassigned = []
    assigned = []
    for row in rows:
        if row["split"] in {"train", "val", "test"}:
            assigned.append((row, row["split"]))
        else:
            unassigned.append(row)
    for row in unassigned:
        value = _rng.random()
        if value < 0.8:
            split = "train"
        elif value < 0.9:
            split = "val"
        else:
            split = "test"
        assigned.append((row, split))

    for row, split in assigned:
        source = Path(row["internal_path"])
        target_name = f"{row['media_id']}_{source.name}"
        image_target = export_root / "images" / split / target_name
        if source.exists():
            link_or_copy(source, image_target)

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
    append_job_log(job_id, f"Dataset YAML: {yaml_path}")
    return yaml_path


def link_or_copy(source: Path, target: Path) -> str:
    """Place source at target without duplicating bytes when the filesystem allows it."""
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        target.unlink()
    try:
        os.link(source, target)
        return "hardlink"
    except OSError:
        pass
    try:
        target.symlink_to(source)
        return "symlink"
    except OSError:
        pass
    shutil.copy2(source, target)
    return "copy"


def run_training_job(job_id: int, paths: AppPaths | None = None) -> dict[str, Any]:
    paths = paths or get_paths()
    _register_active_job(job_id)
    try:
        return _run_training_impl(job_id, paths)
    finally:
        _unregister_active_job(job_id)


def _run_training_impl(job_id: int, paths: AppPaths) -> dict[str, Any]:
    from ..db import connect as _connect

    with _connect() as conn:
        yaml_path = export_yolo_dataset(conn, job_id, paths)

    with _connect() as conn:
        job = conn.execute("SELECT * FROM training_jobs WHERE id = ?", (job_id,)).fetchone()
        params = json_loads(job["params"], {})

    if _is_cancelled_by_id(job_id):
        append_job_log(job_id, "Job was cancelled before training started.")
        return {"status": "cancelled"}

    if not params.get("run_yolo", False):
        with _connect() as conn:
            conn.execute(
                """
                UPDATE training_jobs
                SET status = 'exported', ended_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (job_id,),
            )
            conn.commit()
        append_job_log(job_id, "Dataset export completed. Real Ultralytics training was disabled.")
        return {"status": "exported", "dataset_yaml": str(yaml_path)}

    try:
        from ultralytics import YOLO

        with _connect() as conn:
            conn.execute(
                "UPDATE training_jobs SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ?",
                (job_id,),
            )
            conn.commit()
            model_name = _training_model_source(conn, params) or "yolo11n.pt"
        append_job_log(job_id, f"Starting Ultralytics training with model: {model_name}")
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
        train_args.update(_advanced_train_args(params.get("advanced", {}), resume=params.get("mode") == "resume"))
        if params.get("mode") == "resume":
            train_args["resume"] = True
        else:
            freeze_layers = int(params.get("advanced", {}).get("freeze_layers") or 0)
            if freeze_layers > 0:
                train_args["freeze"] = freeze_layers
        append_job_log(job_id, f"YOLO.train args: {json.dumps(_safe_log_args(train_args), ensure_ascii=False)}")

        def _on_epoch_end(trainer):
            if _is_cancel_requested(job_id):
                trainer.stop = True

        model.add_callback("on_fit_epoch_end", _on_epoch_end)

        with (paths.log_dir / f"training_job_{job_id}.log").open("a", encoding="utf-8", newline="\n") as log_handle:
            with redirect_stdout(log_handle), redirect_stderr(log_handle):
                results = model.train(**train_args)
        run_dir = Path(getattr(results, "save_dir", paths.runtime_dir / "runs" / f"job_{job_id}"))
        if _is_cancelled_by_id(job_id) or _is_cancel_requested(job_id):
            append_job_log(job_id, "Training stopped after cancellation; skipping model registration.")
            return {"status": "cancelled"}
        with _connect() as conn:
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
        append_job_log(job_id, f"Training completed. Run directory: {run_dir}")
        return {"status": "completed", "model_id": model_id}
    except Exception as exc:
        append_job_log(job_id, traceback.format_exc())
        with _connect() as conn:
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
    summary_metrics = summarize_metrics(metrics)
    best_path = run_dir / "weights" / "best.pt"
    last_path = run_dir / "weights" / "last.pt"
    cursor = conn.execute(
        """
        INSERT INTO models(project_id, name, source_experiment_id, metrics_summary, internal_weight_path, is_recommended)
        VALUES(?, ?, NULL, ?, ?, 1)
        """,
        (
            job["project_id"],
            f"{job['name']} best",
            json_dumps(summary_metrics),
            str(best_path) if best_path.exists() else None,
        ),
    )
    model_id = int(cursor.lastrowid)
    last_model_id = None
    if last_path.exists():
        last_cursor = conn.execute(
            """
            INSERT INTO models(project_id, name, source_experiment_id, metrics_summary, internal_weight_path, is_recommended)
            VALUES(?, ?, NULL, ?, ?, 0)
            """,
            (job["project_id"], f"{job['name']} last", json_dumps(summary_metrics), str(last_path)),
        )
        last_model_id = int(last_cursor.lastrowid)
    exp_cursor = conn.execute(
        """
        INSERT INTO experiments(project_id, training_job_id, name, train_metrics, val_metrics, artifact_refs, best_model_id, last_model_id)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            job["project_id"],
            job_id,
            job["name"],
            json_dumps({key: value for key, value in summary_metrics.items() if "loss" in key}),
            json_dumps(summary_metrics),
            json_dumps(training_artifact_refs(run_dir)),
            model_id,
            last_model_id,
        ),
    )
    conn.execute("UPDATE models SET source_experiment_id = ? WHERE id = ?", (exp_cursor.lastrowid, model_id))
    if last_model_id:
        conn.execute("UPDATE models SET source_experiment_id = ? WHERE id = ?", (exp_cursor.lastrowid, last_model_id))
    return model_id


def parse_results_csv(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    stat = path.stat()
    cache_key = (str(path), stat.st_mtime, stat.st_size)
    cached = _csv_cache.get(cache_key)
    if cached is not None:
        return cached
    # Read only the last non-empty line to parse the latest metrics
    last_line = _read_last_nonempty_line(path)
    if not last_line:
        return {}
    # Read header to get field names
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        header = handle.readline()
    if not header:
        return {}
    fieldnames = [h.strip() for h in header.split(",")]
    values = [v.strip() for v in last_line.split(",")]
    if len(values) < len(fieldnames):
        return {}
    result = {fieldnames[i]: _coerce_metric(values[i]) for i in range(len(fieldnames)) if fieldnames[i]}
    _csv_cache[cache_key] = result
    _csv_cache_order.append(cache_key)
    # LRU eviction
    while len(_csv_cache) > _MAX_CSV_CACHE:
        old_key = _csv_cache_order.pop(0)
        _csv_cache.pop(old_key, None)
    return result


def _read_last_nonempty_line(path: Path) -> str:
    """Read the last non-empty line from a file efficiently."""
    with path.open("rb") as handle:
        handle.seek(0, 2)
        file_size = handle.tell()
        if file_size == 0:
            return ""
        # Read up to 8KB from end — a single CSV row with ~30 metrics fits easily
        read_size = min(8192, file_size)
        handle.seek(file_size - read_size)
        chunk = handle.read(read_size)
    text = chunk.decode("utf-8-sig", errors="replace")
    lines = text.splitlines()
    # Skip trailing empty lines
    for line in reversed(lines):
        stripped = line.strip()
        if stripped:
            return stripped
    return ""


def summarize_metrics(metrics: dict[str, Any]) -> dict[str, Any]:
    aliases = {
        "epoch": ["epoch"],
        "precision": ["metrics/precision(B)", "metrics/precision"],
        "recall": ["metrics/recall(B)", "metrics/recall"],
        "mAP50": ["metrics/mAP50(B)", "metrics/mAP50"],
        "mAP50-95": ["metrics/mAP50-95(B)", "metrics/mAP50-95"],
        "train/box_loss": ["train/box_loss"],
        "train/cls_loss": ["train/cls_loss"],
        "train/dfl_loss": ["train/dfl_loss"],
        "val/box_loss": ["val/box_loss"],
        "val/cls_loss": ["val/cls_loss"],
        "val/dfl_loss": ["val/dfl_loss"],
    }
    summary: dict[str, Any] = {}
    for target, candidates in aliases.items():
        for key in candidates:
            if key in metrics:
                summary[target] = metrics[key]
                break
    train_losses = [summary[key] for key in ("train/box_loss", "train/cls_loss", "train/dfl_loss") if isinstance(summary.get(key), (int, float))]
    val_losses = [summary[key] for key in ("val/box_loss", "val/cls_loss", "val/dfl_loss") if isinstance(summary.get(key), (int, float))]
    if train_losses:
        summary["train_loss"] = round(float(sum(train_losses)), 6)
    if val_losses:
        summary["val_loss"] = round(float(sum(val_losses)), 6)
    return summary


def training_artifact_refs(run_dir: Path) -> dict[str, Any]:
    weights = run_dir / "weights"
    refs = {
        "run_dir": str(run_dir),
        "best_pt": str(weights / "best.pt"),
        "last_pt": str(weights / "last.pt"),
        "results_csv": str(run_dir / "results.csv"),
    }
    return {
        **refs,
        "best_exists": Path(refs["best_pt"]).exists(),
        "last_exists": Path(refs["last_pt"]).exists(),
        "results_exists": Path(refs["results_csv"]).exists(),
    }


def dataset_training_summary(conn: sqlite3.Connection, project_id: int, dataset_id: int) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT da.split, ma.id AS media_id
        FROM dataset_assets da
        JOIN media_assets ma ON ma.id = da.media_asset_id
        WHERE da.dataset_id = ? AND ma.project_id = ? AND ma.media_type = 'image'
        """,
        (dataset_id, project_id),
    ).fetchall()
    media_ids = [int(row["media_id"]) for row in rows]
    split_counts = {"train": 0, "val": 0, "test": 0, "unassigned": 0}
    for row in rows:
        split = row["split"] if row["split"] in split_counts else "unassigned"
        split_counts[split] += 1

    class_count = conn.execute(
        "SELECT COUNT(*) FROM dataset_classes WHERE dataset_id = ?",
        (dataset_id,),
    ).fetchone()[0]
    annotation_count = 0
    empty_label_images = len(media_ids)
    _CHUNK = 500
    if media_ids:
        for ci in range(0, len(media_ids), _CHUNK):
            chunk = media_ids[ci : ci + _CHUNK]
            placeholders = ",".join("?" for _ in chunk)
            annotation_count += conn.execute(
                f"""
                SELECT COUNT(*)
                FROM annotations
                WHERE project_id = ? AND media_asset_id IN ({placeholders})
                  AND review_status IN ('draft', 'confirmed')
                """,
                (project_id, *chunk),
            ).fetchone()[0]
            annotated_rows = conn.execute(
                f"""
                SELECT media_asset_id, COUNT(*) AS count
                FROM annotations
                WHERE project_id = ? AND media_asset_id IN ({placeholders})
                  AND review_status IN ('draft', 'confirmed')
                GROUP BY media_asset_id
                """,
                (project_id, *chunk),
            ).fetchall()
            empty_label_images -= len(annotated_rows)

    blockers = []
    warnings = []
    if not media_ids:
        blockers.append("Dataset has no trainable images.")
    if class_count <= 0:
        blockers.append("Dataset has no classes.")
    if annotation_count <= 0:
        blockers.append("Dataset has no annotation boxes.")
    if split_counts["val"] <= 0:
        warnings.append("Validation split is missing; validation metrics may be unavailable.")
    return {
        "dataset_id": dataset_id,
        "image_count": len(media_ids),
        "annotation_count": int(annotation_count),
        "class_count": int(class_count),
        "splits": split_counts,
        "empty_label_images": int(empty_label_images),
        "missing_val": split_counts["val"] <= 0,
        "ready": not blockers,
        "blockers": blockers,
        "warnings": warnings,
    }


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


def _metric_epoch(metrics: dict[str, Any]) -> int | None:
    epoch = metrics.get("epoch")
    if isinstance(epoch, (int, float)):
        return int(epoch) + 1
    return None


def training_progress(status: str, current_epoch: int | None, total_epochs: int) -> float:
    if status in {"completed", "failed", "cancelled", "exported"}:
        return 100
    if status == "queued":
        return 0
    if total_epochs > 0 and current_epoch:
        return round(min(99, max(1, current_epoch / total_epochs * 100)), 1)
    return 5 if status == "running" else 0


def training_stage(status: str, params: dict[str, Any], current_epoch: int | None) -> str:
    if status == "queued":
        return "queued"
    if status == "exported":
        return "dataset_exported" if not params.get("run_yolo") else "exported"
    if status == "running":
        return f"epoch_{current_epoch}" if current_epoch else "training"
    return status


def error_summary(job: dict[str, Any]) -> str | None:
    if job.get("error_message"):
        return str(job["error_message"]).splitlines()[0][:500]
    return None


def _is_cancelled(conn: sqlite3.Connection, job_id: int) -> bool:
    row = conn.execute("SELECT status FROM training_jobs WHERE id = ?", (job_id,)).fetchone()
    return bool(row and row["status"] == "cancelled")


def _is_cancelled_by_id(job_id: int) -> bool:
    from ..db import connect as _connect

    with _connect() as conn:
        return _is_cancelled(conn, job_id)


def _advanced_train_args(advanced: dict[str, Any], resume: bool) -> dict[str, Any]:
    allowed = {
        "lr0": float,
        "patience": int,
        "workers": int,
        "seed": int,
        "cache": bool,
        "augment": bool,
        "optimizer": str,
    }
    if resume:
        allowed = {"workers": int, "cache": bool}
    args: dict[str, Any] = {}
    for key, caster in allowed.items():
        if key not in advanced or advanced[key] in (None, ""):
            continue
        try:
            value = caster(advanced[key])
        except (TypeError, ValueError):
            continue
        if key in {"patience", "workers"} and value < 0:
            continue
        args[key] = value
    return args


def _safe_log_args(args: dict[str, Any]) -> dict[str, Any]:
    return {key: str(value) if isinstance(value, Path) else value for key, value in args.items()}


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
    source_path = Path(str(source))

    base: dict[str, Any] = {
        "name": model_name or str(source),
        "source": str(source),
        "weight_file_size": source_path.stat().st_size if source_path.exists() else None,
        "best_exists": (source_path.parent / "best.pt").exists() if source_path.parent else False,
        "last_exists": (source_path.parent / "last.pt").exists() if source_path.parent else False,
    }

    try:
        from ultralytics import YOLO

        yolo = YOLO(str(source))
        module = yolo.model
        layers = getattr(module, "model", None)
        layer_count = len(layers) if layers is not None else len(list(module.modules()))
        total_params = sum(parameter.numel() for parameter in module.parameters())
        trainable_params = sum(parameter.numel() for parameter in module.parameters() if parameter.requires_grad)
        stride = getattr(module, "stride", None)
        stride_value = None
        if hasattr(stride, "max"):
            try:
                stride_value = int(stride.max().item())
            except Exception:
                pass
        return {
            **base,
            "ok": True,
            "model_type": yolo.task or "detect",
            "task": yolo.task or "detect",
            "stride": stride_value,
            "layer_count": int(layer_count),
            "parameters": int(total_params),
            "trainable_parameters": int(trainable_params),
            "error": None,
        }
    except Exception as exc:
        return {
            **base,
            "ok": False,
            "model_type": "unknown",
            "task": "unknown",
            "stride": None,
            "layer_count": None,
            "parameters": None,
            "trainable_parameters": None,
            "error": str(exc),
        }


def _system_memory() -> dict[str, int | None]:
    try:
        if sys.platform == "win32":
            stat = _MemoryStatus()
            stat.dwLength = _ctypes.sizeof(_MemoryStatus)
            _ctypes.windll.kernel32.GlobalMemoryStatusEx(_ctypes.byref(stat))
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
