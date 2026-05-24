from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


APP_NAME = "AnimalDetectionWorkbench"


@dataclass(frozen=True)
class AppPaths:
    root: Path
    db_path: Path
    media_dir: Path
    model_dir: Path
    public_data_dir: Path
    runtime_dir: Path
    log_dir: Path


def get_app_root() -> Path:
    override = os.environ.get("ANIMAL_WORKBENCH_HOME")
    if override:
        return Path(override).expanduser().resolve()

    app_data = os.environ.get("APPDATA")
    if app_data:
        return Path(app_data) / APP_NAME

    return Path.home() / f".{APP_NAME}"


def get_paths() -> AppPaths:
    root = get_app_root()
    return AppPaths(
        root=root,
        db_path=root / "workbench.db",
        media_dir=root / "assets" / "media",
        model_dir=root / "assets" / "models",
        public_data_dir=root / "assets" / "public_datasets",
        runtime_dir=root / "runtime",
        log_dir=root / "logs",
    )


def ensure_paths(paths: AppPaths | None = None) -> AppPaths:
    paths = paths or get_paths()
    for directory in (
        paths.root,
        paths.media_dir,
        paths.model_dir,
        paths.public_data_dir,
        paths.runtime_dir,
        paths.log_dir,
    ):
        directory.mkdir(parents=True, exist_ok=True)
    return paths
