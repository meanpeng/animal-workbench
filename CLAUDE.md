# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Windows desktop application for animal detection training and annotation. Users import images/videos, annotate with bounding boxes, train YOLO models, and view results — all through a GUI without touching config files or command-line tools.

## Architecture

Two-process architecture: a **Tauri v2 desktop shell** (Rust + React/TypeScript) and a **Python FastAPI backend worker**. The Tauri Rust process starts and manages the Python backend lifecycle.

```
workbench_app/
  app_backend/          Python FastAPI worker, SQLite state, media import, YOLO orchestration
    animal_workbench/   Main Python package
      main.py           FastAPI app with all route definitions
      config.py         Path management (workspace root, media, model, runtime dirs)
      db.py             SQLite connection, schema init, migrations
      repository.py     Data access layer (SQL queries)
      schemas.py        Pydantic request/response models
      class_colors.py   Default class-to-color mapping
      schema.sql        Raw DDL
      services/         Business logic modules
        datasets.py, dataset_import.py, dataset_jobs.py
        media.py, training.py, video_utils.py
        annotation_parsers.py, public_catalog.py, public_downloads.py, public_import.py
    tests/              pytest integration tests (test_api_smoke, test_database, test_dataset_jobs)
    pyproject.toml      Package config, dependencies, pytest settings
  desktop/              Tauri v2 + React/TypeScript frontend
    src/                React application
      App.tsx           Main app with sidebar navigation and 5 views
      api.ts            REST client for all backend endpoints
      types.ts          TypeScript type definitions
      styles.css        Application styles
      features/         Feature modules (datasets/DatasetsPanel, annotation/Annotate)
      components/       Shared components (DataTable, Select)
    src-tauri/          Rust main process
      src/main.rs       Tauri commands (file pickers, backend process management)
      tauri.conf.json   Tauri window/build configuration
    scripts/            Dev helper scripts (tauri-dev.ps1, stop-dev-ports.ps1)
```

### Key Design Decisions

- **SQLite is the sole business state source.** No user-facing YAML/JSON config files. When YOLO requires `dataset.yaml`, the backend generates it temporarily from SQLite and writes results back afterward.
- **UI hides low-level paths.** Users see model names and metrics, not `.pt` file paths. File selection goes through Tauri native dialogs only.
- **Chinese UI.** All interface labels are in Chinese.
- **Managed storage.** Imported media is copied into app-managed directories. Internal paths never appear in the UI.
- **Backend default port:** `http://127.0.0.1:8765`. Frontend dev server: `http://127.0.0.1:5173`.

### Data Flow

Backend routes are defined in `main.py` which delegates to `services/` modules and `repository.py` for SQL. The frontend `api.ts` client calls these REST endpoints. SSE is used for long-running task progress (dataset imports, training jobs).

## Development Commands

### Backend

```bash
cd app_backend
python -m venv .venv
.venv/Scripts/activate          # Windows
pip install -e ".[dev]"
python -m animal_workbench.main  # Start API on :8765
```

Run tests:
```bash
python -m pytest                 # All tests (configured in pyproject.toml, runs tests/)
python -m pytest tests/test_api_smoke.py  # Single test file
```

### Frontend (Vite dev server only, no Tauri)

```bash
cd desktop
npm install
npm run dev                      # Vite on :5173
npm run build                    # TypeScript check + Vite build
```

### Full desktop app (Tauri + backend)

```bash
cd desktop
npm run tauri:dev                # Starts Vite, Rust shell, and Python backend
npm run tauri:build              # Production build
```

Requires Rust toolchain (`rustup`, `cargo`) on PATH. The `tauri-dev.ps1` script adds the Cargo bin directory automatically.

### Stop stale dev processes

```bash
cd desktop
npm run dev:stop                 # Kills processes on ports 5173 and 8765
```

### Rust check

```bash
cd desktop/src-tauri
cargo check
```

## Environment Variables

- `ANIMAL_WORKBENCH_HOME` — Override app data directory (default: `%APPDATA%\AnimalDetectionWorkbench\`). Use during development to point at a temporary workspace.
- `ANIMAL_WORKBENCH_PYTHON` — Override Python interpreter path for the backend worker. The Tauri launcher searches multiple locations before falling back to system `python`.

## Dependencies

- **Backend runtime:** FastAPI, uvicorn, Pydantic, Pillow, OpenCV (headless), PyYAML, gdown, HuggingFace Hub, PyArrow
- **Backend training (optional):** ultralytics (install with `pip install -e ".[train]"`)
- **Backend dev:** pytest, httpx
- **Frontend:** React 18, TypeScript, Vite, react-konva (canvas annotation), Lucide icons
- **Desktop:** Tauri v2, Rust

Python >=3.11 required. Node and Rust toolchains required for the desktop shell.
