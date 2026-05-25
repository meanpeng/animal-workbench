from __future__ import annotations

import hashlib
import shutil
import sqlite3
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from PIL import Image

from ..config import AppPaths, get_paths
from .video_utils import extract_video_frames

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".wmv"}


def iter_importable_files(paths: list[str]) -> list[Path]:
    files: list[Path] = []
    for raw_path in paths:
        path = Path(raw_path).expanduser()
        if path.is_dir():
            for child in path.rglob("*"):
                if child.is_file() and child.suffix.lower() in IMAGE_EXTENSIONS | VIDEO_EXTENSIONS:
                    files.append(child)
        elif path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS | VIDEO_EXTENSIONS:
            files.append(path)
    return sorted(set(files), key=lambda item: str(item).lower())


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def image_dimensions(path: Path) -> tuple[int | None, int | None]:
    if path.suffix.lower() not in IMAGE_EXTENSIONS:
        return None, None
    try:
        with Image.open(path) as image:
            return image.width, image.height
    except Exception:
        return None, None


def create_annotation_batch_for_assets(
    conn: sqlite3.Connection,
    project_id: int,
    batch_name: str | None,
    imported: list[dict[str, Any]],
) -> dict[str, Any] | None:
    if not batch_name or not imported:
        return None

    batch_cursor = conn.execute(
        """
        INSERT INTO annotation_batches(project_id, name, status, total_items)
        VALUES(?, ?, 'open', ?)
        """,
        (project_id, batch_name, len(imported)),
    )
    batch_id = int(batch_cursor.lastrowid)
    conn.executemany(
        "INSERT OR IGNORE INTO annotation_batch_items(batch_id, media_asset_id) VALUES(?, ?)",
        [(batch_id, item["id"]) for item in imported],
    )
    return dict(conn.execute("SELECT * FROM annotation_batches WHERE id = ?", (batch_id,)).fetchone())


def _register_image_asset(
    conn: sqlite3.Connection,
    project_id: int,
    source_path: Path,
    *,
    original_name: str | None = None,
    camera_site: str | None = None,
    source_kind: str = "imported",
    paths: AppPaths | None = None,
    skip_copy: bool = False,
) -> dict[str, Any] | None:
    """Register a single image file as a media_asset. Returns the row or None on failure."""
    paths = paths or get_paths()
    checksum = sha256_file(source_path)

    existing = conn.execute(
        "SELECT * FROM media_assets WHERE project_id = ? AND checksum_sha256 = ?",
        (project_id, checksum),
    ).fetchone()
    if existing:
        return dict(existing)

    width, height = image_dimensions(source_path)
    if skip_copy:
        internal_path = str(source_path.resolve())
    else:
        storage_dir = paths.media_dir / checksum[:2] / checksum[2:4]
        storage_dir.mkdir(parents=True, exist_ok=True)
        internal_path = str((storage_dir / f"{uuid.uuid4().hex}{source_path.suffix.lower()}").resolve())
        try:
            shutil.copy2(source_path, internal_path)
        except OSError:
            return None

    cursor = conn.execute(
        """
        INSERT INTO media_assets(
          project_id, media_type, original_name, source_kind, camera_site,
          width, height, checksum_sha256, internal_path
        )
        VALUES(?, 'image', ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            project_id,
            original_name or source_path.name,
            source_kind,
            camera_site,
            width,
            height,
            checksum,
            str(internal_path),
        ),
    )
    return dict(conn.execute("SELECT * FROM media_assets WHERE id = ?", (cursor.lastrowid,)).fetchone())


def _batch_import_media_assets(
    conn: sqlite3.Connection,
    project_id: int,
    items: list[tuple[Path, str, str | None]],
    paths: AppPaths,
    *,
    skip_copy: bool = False,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Hash and copy files in parallel, then write database rows sequentially."""
    if not items:
        return [], []

    workers = max(1, min(8, len(items)))

    # Phase 1: Compute SHA256 hashes in parallel.
    def _hash(item: tuple[Path, str, str | None]) -> tuple[Path, str, str | None, str | None]:
        path, kind, orig = item
        try:
            return path, kind, orig, sha256_file(path)
        except Exception:
            return path, kind, orig, None

    hashed: list[tuple[Path, str, str | None, str | None]] = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        hashed = list(pool.map(_hash, items))

    # Phase 2: Check the database for duplicates.
    imported: list[dict[str, Any]] = []
    skipped: list[str] = []
    checksum_to_asset: dict[str, dict[str, Any]] = {}
    to_prepare: list[tuple[Path, str, str | None, str]] = []

    for path, kind, orig_name, checksum in hashed:
        if checksum is None:
            skipped.append(str(path))
            continue
        if checksum in checksum_to_asset:
            imported.append(checksum_to_asset[checksum])
            continue
        existing = conn.execute(
            "SELECT * FROM media_assets WHERE project_id = ? AND checksum_sha256 = ?",
            (project_id, checksum),
        ).fetchone()
        if existing:
            asset = dict(existing)
            checksum_to_asset[checksum] = asset
            imported.append(asset)
        else:
            to_prepare.append((path, kind, orig_name, checksum))

    # Phase 3: Copy (or reference) files and read dimensions in parallel.
    def _prepare(item: tuple[Path, str, str | None, str]) -> tuple[Path, str, str | None, str, str, int | None, int | None, str] | None:
        path, kind, orig_name, checksum = item
        try:
            suffix = path.suffix.lower()
            width, height = image_dimensions(path)
            if skip_copy:
                internal_path = str(path.resolve())
            else:
                storage_dir = paths.media_dir / checksum[:2] / checksum[2:4]
                storage_dir.mkdir(parents=True, exist_ok=True)
                internal_path = str((storage_dir / f"{uuid.uuid4().hex}{suffix}").resolve())
                shutil.copy2(path, internal_path)
            return path, kind, orig_name, checksum, suffix, width, height, internal_path
        except Exception:
            return None

    prepared: list[tuple[Path, str, str | None, str, str, int | None, int | None, str]] = []
    if to_prepare:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for item, result in zip(to_prepare, pool.map(_prepare, to_prepare)):
                if result is not None:
                    prepared.append(result)
                else:
                    skipped.append(str(item[0]))

    # Phase 4: Write database rows sequentially.
    for path, kind, orig_name, checksum, suffix, width, height, internal_path in prepared:
        cursor = conn.execute(
            """
            INSERT INTO media_assets(
              project_id, media_type, original_name, source_kind, camera_site,
              width, height, checksum_sha256, internal_path
            )
            VALUES(?, 'image', ?, ?, ?, ?, ?, ?, ?)
            """,
            (project_id, orig_name or path.name, kind, None, width, height, checksum, internal_path),
        )
        asset = dict(conn.execute("SELECT * FROM media_assets WHERE id = ?", (cursor.lastrowid,)).fetchone())
        checksum_to_asset[checksum] = asset
        imported.append(asset)

    return imported, skipped


def import_media(
    conn: sqlite3.Connection,
    project_id: int,
    raw_paths: list[str],
    batch_name: str | None = None,
    camera_site: str | None = None,
    paths: AppPaths | None = None,
    *,
    extract_frames: bool = False,
    skip_copy: bool = False,
) -> dict[str, Any]:
    paths = paths or get_paths()
    skipped: list[str] = []
    files = iter_importable_files(raw_paths)

    image_files = [f for f in files if f.suffix.lower() in IMAGE_EXTENSIONS]
    video_files = [f for f in files if f.suffix.lower() in VIDEO_EXTENSIONS]

    # Extract frames in parallel.
    frame_paths: list[Path] = []
    if extract_frames and video_files:
        all_frames: dict[Path, list[Path]] = {}
        with ThreadPoolExecutor(max_workers=max(1, min(4, len(video_files)))) as pool:
            future_to_video = {pool.submit(extract_video_frames, vf): vf for vf in video_files}
            for future in as_completed(future_to_video):
                vf = future_to_video[future]
                try:
                    all_frames[vf] = future.result()
                except Exception:
                    all_frames[vf] = []
        for vf in video_files:
            frames = all_frames.get(vf, [])
            if frames:
                frame_paths.extend(frames)
            else:
                skipped.append(f"{vf} (无法抽帧)")
    elif not extract_frames:
        for vf in video_files:
            skipped.append(str(vf))

    # Build the bulk import list.
    items: list[tuple[Path, str, str | None]] = []
    for path in image_files:
        items.append((path, "imported", None))
    for path in frame_paths:
        items.append((path, "frame", path.name))

    imported, batch_skipped = _batch_import_media_assets(conn, project_id, items, paths, skip_copy=skip_copy)
    skipped.extend(batch_skipped)

    batch = create_annotation_batch_for_assets(conn, project_id, batch_name, imported)

    conn.commit()
    return {"imported": imported, "skipped": skipped, "batch": batch}
