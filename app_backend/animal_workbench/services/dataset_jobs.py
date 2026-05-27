from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Callable
from typing import Any

from ..db import connect
from ..repository import json_dumps


TERMINAL_STATUSES = {"completed", "failed"}


def create_dataset_job(
    conn: sqlite3.Connection,
    project_id: int,
    job_type: str,
    params: dict[str, Any],
    message: str = "",
) -> dict[str, Any]:
    cursor = conn.execute(
        """
        INSERT INTO dataset_jobs(project_id, job_type, params, message)
        VALUES(?, ?, ?, ?)
        """,
        (project_id, job_type, json_dumps(params), message),
    )
    conn.commit()
    return get_dataset_job(conn, int(cursor.lastrowid))


def get_dataset_job(conn: sqlite3.Connection, job_id: int) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM dataset_jobs WHERE id = ?", (job_id,)).fetchone()
    if row is None:
        raise KeyError(job_id)
    return dict(row)


def list_dataset_jobs(conn: sqlite3.Connection, project_id: int, limit: int = 20) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT *
        FROM dataset_jobs
        WHERE project_id = ?
        ORDER BY created_at DESC
        LIMIT ?
        """,
        (project_id, limit),
    ).fetchall()
    return [dict(row) for row in rows]


def update_dataset_job(
    conn: sqlite3.Connection,
    job_id: int,
    *,
    status: str | None = None,
    stage: str | None = None,
    percent: float | None = None,
    current: int | None = None,
    total: int | None = None,
    message: str | None = None,
    error_message: str | None = None,
    result_summary: dict[str, Any] | None = None,
    append_log: str | None = None,
) -> dict[str, Any]:
    current_row = get_dataset_job(conn, job_id)
    log_items = json.loads(current_row.get("log") or "[]")
    if append_log:
        log_items = [*log_items, append_log][-80:]

    values = {
        "status": status if status is not None else current_row["status"],
        "stage": stage if stage is not None else current_row["stage"],
        "percent": percent if percent is not None else current_row["percent"],
        "current": current if current is not None else current_row["current"],
        "total": total if total is not None else current_row["total"],
        "message": message if message is not None else current_row["message"],
        "log": json_dumps(log_items),
        "error_message": error_message if error_message is not None else current_row["error_message"],
        "result_summary": json_dumps(result_summary) if result_summary is not None else current_row["result_summary"],
    }
    started_clause = ", started_at = COALESCE(started_at, CURRENT_TIMESTAMP)" if values["status"] == "running" else ""
    ended_clause = ", ended_at = CURRENT_TIMESTAMP" if values["status"] in TERMINAL_STATUSES else ""
    conn.execute(
        f"""
        UPDATE dataset_jobs
        SET status = ?,
            stage = ?,
            percent = ?,
            current = ?,
            total = ?,
            message = ?,
            log = ?,
            error_message = ?,
            result_summary = ?,
            updated_at = CURRENT_TIMESTAMP
            {started_clause}
            {ended_clause}
        WHERE id = ?
        """,
        (
            values["status"],
            values["stage"],
            values["percent"],
            values["current"],
            values["total"],
            values["message"],
            values["log"],
            values["error_message"],
            values["result_summary"],
            job_id,
        ),
    )
    conn.commit()
    return get_dataset_job(conn, job_id)


class JobReporter:
    def __init__(self, job_id: int, conn: sqlite3.Connection | None = None):
        self.job_id = job_id
        self._conn = conn

    def update(
        self,
        *,
        stage: str,
        percent: float,
        current: int = 0,
        total: int = 0,
        message: str = "",
        log: str | None = None,
    ) -> None:
        if self._conn is not None:
            self.update_on(
                self._conn,
                stage=stage,
                percent=percent,
                current=current,
                total=total,
                message=message,
                log=log,
            )
            return
        conn = connect()
        try:
            update_dataset_job(
                conn,
                self.job_id,
                status="running",
                stage=stage,
                percent=max(0.0, min(float(percent), 100.0)),
                current=current,
                total=total,
                message=message,
                append_log=log or message,
            )
        finally:
            conn.close()

    def update_on(
        self,
        conn: sqlite3.Connection,
        *,
        stage: str,
        percent: float,
        current: int = 0,
        total: int = 0,
        message: str = "",
        log: str | None = None,
    ) -> None:
        update_dataset_job(
            conn,
            self.job_id,
            status="running",
            stage=stage,
            percent=max(0.0, min(float(percent), 100.0)),
            current=current,
            total=total,
            message=message,
            append_log=log or message,
        )

    def complete(self, summary: dict[str, Any], message: str = "任务完成") -> None:
        if self._conn is not None:
            update_dataset_job(
                self._conn,
                self.job_id,
                status="completed",
                stage="completed",
                percent=100,
                message=message,
                result_summary=summary,
                append_log=message,
            )
            return
        conn = connect()
        try:
            update_dataset_job(
                conn,
                self.job_id,
                status="completed",
                stage="completed",
                percent=100,
                message=message,
                result_summary=summary,
                append_log=message,
            )
        finally:
            conn.close()

    def fail(self, error: Exception) -> None:
        message = str(error)
        if self._conn is not None:
            update_dataset_job(
                self._conn,
                self.job_id,
                status="failed",
                stage="failed",
                message=message,
                error_message=message,
                append_log=message,
            )
            return
        conn = connect()
        try:
            update_dataset_job(
                conn,
                self.job_id,
                status="failed",
                stage="failed",
                message=message,
                error_message=message,
                append_log=message,
            )
        finally:
            conn.close()


def start_dataset_job(job_id: int, target: Callable[[JobReporter], None]) -> None:
    def runner() -> None:
        reporter = JobReporter(job_id)
        try:
            reporter.update(stage="queued", percent=0, message="任务已启动")
            target(reporter)
        except Exception as exc:
            reporter.fail(exc)

    thread = threading.Thread(target=runner, name=f"dataset-job-{job_id}", daemon=True)
    thread.start()
