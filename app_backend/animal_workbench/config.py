from __future__ import annotations

import os
import json
from dataclasses import dataclass
from pathlib import Path


APP_NAME = "AnimalDetectionWorkbench"


@dataclass(frozen=True)
class AppPaths:
    root: Path
    data_root: Path
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


def get_storage_config_path() -> Path:
    return get_app_root() / "storage.json"


def default_data_root() -> Path:
    override = os.environ.get("ANIMAL_WORKBENCH_DATA_DIR")
    if override:
        return Path(override).expanduser().resolve()

    if os.environ.get("ANIMAL_WORKBENCH_HOME"):
        return get_app_root() / "data"

    if os.name == "nt":
        for drive in ("D:", "E:", "F:"):
            candidate = Path(f"{drive}\\")
            if candidate.exists():
                return candidate / f"{APP_NAME}Data"

    return get_app_root() / "data"


def get_data_root() -> Path:
    config_path = get_storage_config_path()
    if config_path.exists():
        try:
            data = json.loads(config_path.read_text(encoding="utf-8"))
            configured = data.get("data_root")
            if configured:
                return Path(str(configured)).expanduser().resolve()
        except Exception:
            pass
    return default_data_root()


def set_data_root(path: str | Path) -> Path:
    data_root = Path(path).expanduser().resolve()
    config_path = get_storage_config_path()
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps({"data_root": str(data_root)}, ensure_ascii=False, indent=2), encoding="utf-8")
    return data_root


def get_paths() -> AppPaths:
    root = get_app_root()
    data_root = get_data_root()
    return AppPaths(
        root=root,
        data_root=data_root,
        db_path=root / "workbench.db",
        media_dir=data_root / "assets" / "media",
        model_dir=data_root / "assets" / "models",
        public_data_dir=data_root / "assets" / "public_datasets",
        runtime_dir=data_root / "runtime",
        log_dir=root / "logs",
    )


def ensure_paths(paths: AppPaths | None = None) -> AppPaths:
    paths = paths or get_paths()
    for directory in (
        paths.root,
        paths.data_root,
        paths.media_dir,
        paths.model_dir,
        paths.public_data_dir,
        paths.runtime_dir,
        paths.log_dir,
    ):
        directory.mkdir(parents=True, exist_ok=True)
    return paths
