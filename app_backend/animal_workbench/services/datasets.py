from __future__ import annotations

import sqlite3
from typing import Any

from ..repository import json_dumps, json_loads

_CHUNK_SIZE = 500


def _chunked_in(conn: sqlite3.Connection, sql_template: str, ids: list[int], prefix_params: tuple = (), suffix_params: tuple = ()) -> list[sqlite3.Row]:
    """Execute *sql_template* with ``IN (?)`` replaced by chunked placeholders.

    sql_template must contain exactly one ``{ph}`` marker where the
    ``?, ?, …`` placeholders should go. Returns combined rows.
    """
    if not ids:
        return []
    all_rows: list[sqlite3.Row] = []
    for i in range(0, len(ids), _CHUNK_SIZE):
        chunk = ids[i : i + _CHUNK_SIZE]
        placeholders = ",".join("?" for _ in chunk)
        sql = sql_template.format(ph=placeholders)
        all_rows.extend(conn.execute(sql, (*prefix_params, *chunk, *suffix_params)).fetchall())
    return all_rows


def create_dataset(
    conn: sqlite3.Connection,
    project_id: int,
    name: str,
    dataset_type: str,
    media_asset_ids: list[int],
    composition_rule: dict[str, Any],
) -> dict[str, Any]:
    media_asset_ids = owned_media_ids(conn, project_id, media_asset_ids)
    sample_stats = {"media_count": 0, "annotation_count": 0, "class_count": 0}
    cursor = conn.execute(
        """
        INSERT INTO datasets(project_id, name, dataset_type, composition_rule, sample_stats)
        VALUES(?, ?, ?, ?, ?)
        """,
        (project_id, name, dataset_type, json_dumps(composition_rule), json_dumps(sample_stats)),
    )
    dataset_id = int(cursor.lastrowid)
    if media_asset_ids:
        conn.executemany(
            "INSERT OR IGNORE INTO dataset_assets(dataset_id, media_asset_id, split) VALUES(?, ?, ?)",
            [(dataset_id, media_id, split_for_index(index, len(media_asset_ids))) for index, media_id in enumerate(media_asset_ids)],
        )
        bind_annotated_media_classes(conn, project_id, dataset_id, media_asset_ids)
    refresh_dataset_counts(conn, project_id, dataset_id)
    conn.commit()
    return dict(conn.execute("SELECT * FROM datasets WHERE id = ?", (dataset_id,)).fetchone())


def create_fusion_dataset(
    conn: sqlite3.Connection,
    project_id: int,
    name: str,
    source_dataset_ids: list[int],
) -> dict[str, Any]:
    unique_source_ids = list(dict.fromkeys(source_dataset_ids))
    rows = _chunked_in(conn, "SELECT id FROM datasets WHERE project_id = ? AND id IN ({ph})", unique_source_ids, prefix_params=(project_id,))
    owned = {int(row["id"]) for row in rows}
    missing = [ds_id for ds_id in unique_source_ids if ds_id not in owned]
    if missing:
        raise ValueError(f"Datasets do not belong to the current project: {missing}")

    cursor = conn.execute(
        """
        INSERT INTO datasets(project_id, name, dataset_type, composition_rule, sample_stats)
        VALUES(?, ?, 'fusion', ?, ?)
        """,
        (
            project_id,
            name,
            json_dumps({"source": "datasets", "source_dataset_ids": unique_source_ids}),
            json_dumps({"media_count": 0, "annotation_count": 0, "class_count": 0}),
        ),
    )
    dataset_id = int(cursor.lastrowid)
    placeholders = ",".join("?" for _ in unique_source_ids)
    conn.execute(
        f"""
        INSERT OR IGNORE INTO dataset_assets(dataset_id, media_asset_id, split)
        SELECT ?, media_asset_id, 'unassigned'
        FROM dataset_assets
        WHERE dataset_id IN ({placeholders})
        """,
        (dataset_id, *unique_source_ids),
    )
    bind_annotated_media_classes(conn, project_id, dataset_id)
    refresh_dataset_counts(conn, project_id, dataset_id)
    conn.commit()
    return dict(conn.execute("SELECT * FROM datasets WHERE id = ?", (dataset_id,)).fetchone())


def split_for_index(index: int, total: int) -> str:
    if total < 5:
        return "train"
    return "val" if index % 5 == 0 else "train"


def add_media_to_dataset(
    conn: sqlite3.Connection,
    project_id: int,
    dataset_id: int,
    media_asset_ids: list[int],
    *,
    commit: bool = True,
) -> dict[str, Any]:
    """Add media assets to an existing dataset."""
    dataset = conn.execute(
        "SELECT * FROM datasets WHERE id = ? AND project_id = ?",
        (dataset_id, project_id),
    ).fetchone()
    if not dataset:
        raise ValueError("Dataset not found.")

    if not media_asset_ids:
        return dict(conn.execute("SELECT * FROM datasets WHERE id = ?", (dataset_id,)).fetchone())

    media_asset_ids = owned_media_ids(conn, project_id, media_asset_ids)
    conn.executemany(
        "INSERT OR IGNORE INTO dataset_assets(dataset_id, media_asset_id, split) VALUES(?, ?, 'unassigned')",
        [(dataset_id, media_id) for media_id in media_asset_ids],
    )
    bind_annotated_media_classes(conn, project_id, dataset_id, media_asset_ids)
    refresh_dataset_counts(conn, project_id, dataset_id)
    if commit:
        conn.commit()
    return dict(conn.execute("SELECT * FROM datasets WHERE id = ?", (dataset_id,)).fetchone())


def bind_class_to_dataset(
    conn: sqlite3.Connection,
    project_id: int,
    dataset_id: int,
    class_id: int,
    sort_order: int | None = None,
) -> None:
    row = conn.execute(
        """
        SELECT cl.id
        FROM classes cl
        JOIN datasets d ON d.project_id = cl.project_id
        WHERE cl.id = ? AND cl.project_id = ? AND d.id = ?
        """,
        (class_id, project_id, dataset_id),
    ).fetchone()
    if row is None:
        raise ValueError("Class or dataset does not belong to the current project.")
    if sort_order is None:
        next_order = conn.execute(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM dataset_classes WHERE dataset_id = ?",
            (dataset_id,),
        ).fetchone()["next_order"]
        sort_order = int(next_order)
    conn.execute(
        "INSERT OR IGNORE INTO dataset_classes(dataset_id, class_id, sort_order) VALUES(?, ?, ?)",
        (dataset_id, class_id, sort_order),
    )


def bind_classes_to_dataset(
    conn: sqlite3.Connection,
    project_id: int,
    dataset_id: int,
    class_ids: list[int],
) -> None:
    for index, class_id in enumerate(list(dict.fromkeys(class_ids))):
        bind_class_to_dataset(conn, project_id, dataset_id, class_id, index)


def bind_annotated_media_classes(
    conn: sqlite3.Connection,
    project_id: int,
    dataset_id: int,
    media_asset_ids: list[int] | None = None,
) -> None:
    """Bind classes that appear in annotations for this dataset's media assets.

    If *media_asset_ids* is provided, only those assets are considered.
    Otherwise all media in the dataset is checked (avoids passing large ID
    lists through Python — the database joins directly).
    """
    if media_asset_ids is None:
        rows = conn.execute(
            """
            SELECT DISTINCT a.class_id
            FROM annotations a
            JOIN classes cl ON cl.id = a.class_id
            WHERE a.project_id = ? AND cl.project_id = ?
              AND a.media_asset_id IN (
                SELECT media_asset_id FROM dataset_assets WHERE dataset_id = ?
              )
            ORDER BY cl.sort_order, cl.id
            """,
            (project_id, project_id, dataset_id),
        ).fetchall()
    elif media_asset_ids:
        rows = _chunked_in(
            conn,
            """
            SELECT DISTINCT a.class_id
            FROM annotations a
            JOIN classes cl ON cl.id = a.class_id
            WHERE a.project_id = ? AND cl.project_id = ? AND a.media_asset_id IN ({ph})
            ORDER BY cl.sort_order, cl.id
            """,
            media_asset_ids,
            prefix_params=(project_id, project_id),
        )
    else:
        return
    bind_classes_to_dataset(conn, project_id, dataset_id, [int(row["class_id"]) for row in rows])


def refresh_dataset_counts(conn: sqlite3.Connection, project_id: int, dataset_id: int) -> None:
    row = conn.execute(
        """
        SELECT sample_stats FROM datasets WHERE id = ? AND project_id = ?
        """,
        (dataset_id, project_id),
    ).fetchone()
    if row is None:
        return
    stats = json_loads(row["sample_stats"], {})
    counts = conn.execute(
        """
        SELECT
            COUNT(DISTINCT da.media_asset_id) AS media_count,
            COUNT(a.id) AS annotation_count,
            COUNT(DISTINCT CASE WHEN a.id IS NOT NULL THEN da.media_asset_id END) AS annotated_media
        FROM dataset_assets da
        JOIN media_assets ma ON ma.id = da.media_asset_id AND ma.project_id = ?
        LEFT JOIN annotations a
          ON a.media_asset_id = da.media_asset_id
         AND a.project_id = ?
         AND a.class_id IN (SELECT class_id FROM dataset_classes WHERE dataset_id = ?)
        WHERE da.dataset_id = ?
        """,
        (project_id, project_id, dataset_id, dataset_id),
    ).fetchone()
    media_count = int(counts["media_count"])
    annotated_media = int(counts["annotated_media"])
    stats["media_count"] = media_count
    stats["annotation_count"] = int(counts["annotation_count"])
    stats["annotated_media"] = annotated_media
    stats["annotation_status"] = (
        "unlabeled"
        if annotated_media == 0
        else "labeled"
        if annotated_media == media_count
        else "partial"
    )
    stats["class_count"] = conn.execute(
        "SELECT COUNT(*) AS cnt FROM dataset_classes WHERE dataset_id = ?",
        (dataset_id,),
    ).fetchone()["cnt"]
    conn.execute(
        "UPDATE datasets SET sample_stats = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND project_id = ?",
        (json_dumps(stats), dataset_id, project_id),
    )


def owned_media_ids(conn: sqlite3.Connection, project_id: int, media_asset_ids: list[int]) -> list[int]:
    unique_ids = list(dict.fromkeys(media_asset_ids))
    if not unique_ids:
        return []
    rows = _chunked_in(conn, "SELECT id FROM media_assets WHERE project_id = ? AND id IN ({ph})", unique_ids, prefix_params=(project_id,))
    owned = {int(row["id"]) for row in rows}
    missing = [media_id for media_id in unique_ids if media_id not in owned]
    if missing:
        raise ValueError(f"Media assets do not belong to the current project: {missing}")
    return unique_ids
