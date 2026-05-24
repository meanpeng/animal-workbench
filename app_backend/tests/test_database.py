from __future__ import annotations

import sqlite3

from animal_workbench.db import init_db, connect
from animal_workbench.repository import current_project_id
from animal_workbench.services.datasets import create_dataset


def test_init_db_creates_default_project(tmp_path, monkeypatch):
    monkeypatch.setenv("ANIMAL_WORKBENCH_HOME", str(tmp_path))
    init_db()
    with connect() as conn:
        project_id = current_project_id(conn)
        assert project_id > 0
        classes = conn.execute("SELECT COUNT(*) AS count FROM classes WHERE project_id = ?", (project_id,)).fetchone()
        assert classes["count"] >= 1


def test_create_dataset_is_persisted(tmp_path, monkeypatch):
    monkeypatch.setenv("ANIMAL_WORKBENCH_HOME", str(tmp_path))
    init_db()
    with connect() as conn:
        project_id = current_project_id(conn)
        dataset = create_dataset(conn, project_id, "第一轮本地标注集", "user", [], {"source": "test"})
        assert dataset["id"] > 0

    with connect() as conn:
        row = conn.execute("SELECT name FROM datasets WHERE id = ?", (dataset["id"],)).fetchone()
        assert row["name"] == "第一轮本地标注集"
