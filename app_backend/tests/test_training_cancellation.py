from __future__ import annotations

from animal_workbench.db import connect, init_db
from animal_workbench.repository import current_project_id
from animal_workbench.services.datasets import create_dataset
from animal_workbench.services.training import create_training_job, export_yolo_dataset, run_training_job


def _cancelled_training_job(tmp_path, monkeypatch, *, run_yolo: bool = True) -> int:
    monkeypatch.setenv("ANIMAL_WORKBENCH_HOME", str(tmp_path / "app-home"))
    init_db()
    with connect() as conn:
        project_id = current_project_id(conn)
        dataset = create_dataset(conn, project_id, "cancel-dataset", "user", [], {"source": "test"})
        job = create_training_job(
            conn,
            project_id,
            int(dataset["id"]),
            "cancel-job",
            {"run_yolo": run_yolo, "epochs": 1, "image_size": 640, "batch_size": 1, "device": "cpu"},
        )
        conn.execute("UPDATE training_jobs SET status = 'cancelled' WHERE id = ?", (job["id"],))
        conn.commit()
        return int(job["id"])


def test_export_yolo_dataset_does_not_overwrite_cancelled_job(tmp_path, monkeypatch):
    job_id = _cancelled_training_job(tmp_path, monkeypatch)

    with connect() as conn:
        export_yolo_dataset(conn, job_id)
        status = conn.execute("SELECT status FROM training_jobs WHERE id = ?", (job_id,)).fetchone()["status"]

    assert status == "cancelled"


def test_run_training_job_stops_when_job_was_cancelled_before_export(tmp_path, monkeypatch):
    job_id = _cancelled_training_job(tmp_path, monkeypatch, run_yolo=True)

    result = run_training_job(job_id)

    with connect() as conn:
        row = conn.execute("SELECT status, runtime_dataset_path FROM training_jobs WHERE id = ?", (job_id,)).fetchone()

    assert result["status"] == "cancelled"
    assert row["status"] == "cancelled"
    assert row["runtime_dataset_path"] is None
