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
from .video_utils import cleanup_temp_dirs, extract_video_frames

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


def _register_image_asset(
    conn: sqlite3.Connection,
    project_id: int,
    source_path: Path,
    *,
    original_name: str | None = None,
    camera_site: str | None = None,
    source_kind: str = "imported",
    paths: AppPaths | None = None,
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
    storage_dir = paths.media_dir / checksum[:2] / checksum[2:4]
    storage_dir.mkdir(parents=True, exist_ok=True)
    internal_path = storage_dir / f"{uuid.uuid4().hex}{source_path.suffix.lower()}"
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
) -> tuple[list[dict[str, Any]], list[str]]:
    """并行计算哈希 + 复制文件，顺序写入数据库。返回 (imported, skipped)。"""
    if not items:
        return [], []
    # Adapt (path, kind, orig_name) tuples to (path, kind) for the common function.
    # original_name is handled via the path.name default in the DB insert.
    simple_items = [(path, kind) for path, kind, _ in items]
    from .common import register_media_assets_batch
    imported, skipped, _checksum_map, _path_map = register_media_assets_batch(conn, project_id, simple_items, paths)
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
) -> dict[str, Any]:
    paths = paths or get_paths()
    skipped: list[str] = []
    files = iter_importable_files(raw_paths)

    image_files = [f for f in files if f.suffix.lower() in IMAGE_EXTENSIONS]
    video_files = [f for f in files if f.suffix.lower() in VIDEO_EXTENSIONS]

    # 并行抽帧
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

    # 构建批量导入列表
    items: list[tuple[Path, str, str | None]] = []
    for path in image_files:
        items.append((path, "imported", None))
    for path in frame_paths:
        items.append((path, "frame", path.name))

    imported, batch_skipped = _batch_import_media_assets(conn, project_id, items, paths)
    skipped.extend(batch_skipped)

    cleanup_temp_dirs()

    from .common import create_annotation_batch
    batch = create_annotation_batch(conn, project_id, batch_name, [item["id"] for item in imported]) if batch_name else None

    conn.commit()
    return {"imported": imported, "skipped": skipped, "batch": batch}
