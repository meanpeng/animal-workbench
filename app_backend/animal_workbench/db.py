from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Iterable

from .class_colors import DEFAULT_CLASSES, OLD_CLASS_COLORS, class_color_for_index
from .config import ensure_paths, get_paths


class WorkbenchConnection(sqlite3.Connection):
    def __exit__(self, exc_type, exc_value, traceback) -> bool:
        result = super().__exit__(exc_type, exc_value, traceback)
        self.close()
        return result


def connect(db_path: Path | None = None) -> sqlite3.Connection:
    paths = ensure_paths()
    path = db_path or paths.db_path
    conn = sqlite3.connect(path, factory=WorkbenchConnection)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(db_path: Path | None = None) -> None:
    paths = ensure_paths()
    path = db_path or paths.db_path
    schema_path = Path(__file__).with_name("schema.sql")
    conn = sqlite3.connect(path)
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(schema_path.read_text(encoding="utf-8"))
        conn.execute("PRAGMA foreign_keys = ON")
        ensure_default_project(conn)
        migrate_default_class_colors(conn)
    finally:
        conn.close()


def ensure_default_project(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT id FROM projects ORDER BY last_opened_at DESC LIMIT 1").fetchone()
    if row:
        return int(row[0])

    cursor = conn.execute(
        "INSERT INTO projects(name, reserve_name) VALUES(?, ?)",
        ("默认项目", "未命名保护区"),
    )
    project_id = int(cursor.lastrowid)
    conn.executemany(
        """
        INSERT INTO classes(project_id, name, display_name, color, sort_order)
        VALUES(?, ?, ?, ?, ?)
        """,
        [(project_id, name, display, color, index) for index, (name, display, color) in enumerate(DEFAULT_CLASSES)],
    )
    conn.commit()
    return project_id


def migrate_default_class_colors(conn: sqlite3.Connection) -> None:
    placeholders = ", ".join("?" for _ in OLD_CLASS_COLORS)
    rows = conn.execute(
        f"""
        SELECT id, sort_order
        FROM classes
        WHERE lower(color) IN ({placeholders})
        """,
        tuple(sorted(OLD_CLASS_COLORS)),
    ).fetchall()
    if not rows:
        return
    conn.executemany(
        "UPDATE classes SET color = ? WHERE id = ?",
        [(class_color_for_index(int(row[1])), int(row[0])) for row in rows],
    )
    conn.commit()


def rows_to_dicts(rows: Iterable[sqlite3.Row]) -> list[dict]:
    return [dict(row) for row in rows]
