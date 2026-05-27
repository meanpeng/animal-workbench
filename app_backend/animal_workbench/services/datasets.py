from __future__ import annotations

import sqlite3
from typing import Any

from ..repository import json_dumps, json_loads


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
    placeholders = ",".join("?" for _ in unique_source_ids)
    rows = conn.execute(
        f"SELECT id FROM datasets WHERE project_id = ? AND id IN ({placeholders})",
        (project_id, *unique_source_ids),
    ).fetchall()
    owned = {int(row["id"]) for row in rows}
    missing = [dataset_id for dataset_id in unique_source_ids if dataset_id not in owned]
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
    conn.execute(
        f"""
        INSERT OR IGNORE INTO dataset_assets(dataset_id, media_asset_id, split)
        SELECT ?, media_asset_id, 'unassigned'
        FROM dataset_assets
        WHERE dataset_id IN ({placeholders})
        """,
        (dataset_id, *unique_source_ids),
    )
    media_rows = conn.execute(
        "SELECT media_asset_id FROM dataset_assets WHERE dataset_id = ?",
        (dataset_id,),
    ).fetchall()
    bind_annotated_media_classes(conn, project_id, dataset_id, [int(row["media_asset_id"]) for row in media_rows])
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
    media_asset_ids: list[int],
) -> None:
    if not media_asset_ids:
        return
    placeholders = ",".join("?" for _ in media_asset_ids)
    rows = conn.execute(
        f"""
        SELECT DISTINCT a.class_id
        FROM annotations a
        JOIN classes cl ON cl.id = a.class_id
        WHERE a.project_id = ? AND cl.project_id = ? AND a.media_asset_id IN ({placeholders})
        ORDER BY cl.sort_order, cl.id
        """,
        (project_id, project_id, *media_asset_ids),
    ).fetchall()
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


def query_dataset_media(
    conn: sqlite3.Connection,
    project_id: int,
    dataset_id: int,
    dataset: dict,
    *,
    limit: int = 50,
    offset: int = 0,
    search: str | None = None,
    class_id: int | None = None,
    annotation_status: str | None = None,
    media_asset_id: int | None = None,
) -> dict[str, Any]:
    from ..repository import list_dataset_classes, rows_to_dicts

    # -- stats --
    stats_row = conn.execute(
        """
        SELECT
            COUNT(DISTINCT da.media_asset_id) AS total_media,
            COUNT(DISTINCT a.id) AS total_annotations,
            COUNT(DISTINCT CASE WHEN a.id IS NOT NULL THEN da.media_asset_id END) AS annotated_media
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

    # -- base query --
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
            EXISTS (
                SELECT 1
                FROM annotations a2
                JOIN dataset_classes dc2 ON dc2.dataset_id = ? AND dc2.class_id = a2.class_id
                WHERE a2.media_asset_id = ma.id AND a2.project_id = ?
            )
            """
        )
        params.extend([dataset_id, project_id])
    elif annotation_status == "unannotated":
        conditions.append(
            """
            NOT EXISTS (
                SELECT 1
                FROM annotations a2
                JOIN dataset_classes dc2 ON dc2.dataset_id = ? AND dc2.class_id = a2.class_id
                WHERE a2.media_asset_id = ma.id AND a2.project_id = ?
            )
            """
        )
        params.extend([dataset_id, project_id])

    where_clause = " AND ".join(conditions)

    # -- count --
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

    # -- paginated rows --
    rows = rows_to_dicts(
        conn.execute(
            f"""
            SELECT
                ma.id, ma.media_type, ma.original_name,
                ma.camera_site, ma.width, ma.height, ma.created_at
            FROM dataset_assets da
            JOIN media_assets ma ON ma.id = da.media_asset_id
            WHERE {where_clause} AND ma.project_id = ?
            ORDER BY ma.id ASC
            LIMIT ? OFFSET ?
            """,
            [*params, project_id, limit, offset],
        )
    )

    # -- batch queries for annotation counts and class names --
    media_ids = [row["id"] for row in rows]
    ann_count_map: dict[int, int] = {}
    class_names_map: dict[int, list[str]] = {}
    if media_ids:
        placeholders = ",".join("?" for _ in media_ids)
        ann_rows = conn.execute(
            f"""
            SELECT a.media_asset_id, COUNT(*) AS cnt
            FROM annotations a
            JOIN dataset_classes dc ON dc.dataset_id = ? AND dc.class_id = a.class_id
            WHERE a.media_asset_id IN ({placeholders}) AND a.project_id = ?
            GROUP BY a.media_asset_id
            """,
            [dataset_id, *media_ids, project_id],
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
            [dataset_id, *media_ids, project_id],
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


def owned_media_ids(conn: sqlite3.Connection, project_id: int, media_asset_ids: list[int]) -> list[int]:
    unique_ids = list(dict.fromkeys(media_asset_ids))
    if not unique_ids:
        return []
    placeholders = ",".join("?" for _ in unique_ids)
    rows = conn.execute(
        f"SELECT id FROM media_assets WHERE project_id = ? AND id IN ({placeholders})",
        (project_id, *unique_ids),
    ).fetchall()
    owned = {int(row["id"]) for row in rows}
    missing = [media_id for media_id in unique_ids if media_id not in owned]
    if missing:
        raise ValueError(f"Media assets do not belong to the current project: {missing}")
    return unique_ids
