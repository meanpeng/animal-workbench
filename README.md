# Animal Detection Workbench

This folder contains a new standalone desktop application. It is intentionally
separate from the existing scripts, models, runs, and data preparation outputs in
the repository.

## Layout

```text
workbench_app/
  app_backend/   FastAPI worker, SQLite state, media import, YOLO export/training orchestration
  desktop/       Tauri v2 + React/TypeScript desktop shell
```

The application stores runtime state in:

```text
%APPDATA%\AnimalDetectionWorkbench\
```

Set `ANIMAL_WORKBENCH_HOME` while developing or testing to point the app at a
temporary workspace.

## First Development Milestone

- SQLite schema for projects, assets, datasets, annotation batches,
  annotations, predictions, models, training jobs, experiments, and settings.
- FastAPI endpoints for dashboard state, media import, annotation persistence,
  dataset creation, and training job orchestration.
- Runtime YOLO dataset export generated from SQLite. No business configuration
  is saved as YAML.
- React desktop UI with dashboard, datasets, annotation, training, and results
  work surfaces.
- Tauri shell commands for controlled file selection and Python worker startup.

See [DEVELOPMENT_PROGRESS.md](DEVELOPMENT_PROGRESS.md) for the current
implementation status, verification results, and next priorities.

## Backend

```powershell
cd workbench_app\app_backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
python -m animal_workbench.main
```

The API listens on `http://127.0.0.1:8765` by default.

## Desktop

```powershell
cd workbench_app\desktop
npm install
npm run dev
```

Rust is required for the Tauri shell:

```powershell
npm run tauri:dev
```
