# Development Progress

Date: 2026-05-22

## Current Goal

Build a standalone Windows desktop workbench for animal detection training and
annotation. The new app lives under `workbench_app/` and does not reuse old
project file paths except when the user explicitly imports data through the
desktop file picker.

## Full Plan

### Summary

Develop a Windows desktop application for ordinary users using:

- Tauri v2
- React/TypeScript
- Rust
- Python FastAPI worker
- SQLite

Core principle: users should not understand or operate `dataset.yaml`, training
configuration files, Label Studio JSON paths, model paths, result paths, or
similar low-level concepts. SQLite persists all training configuration, dataset
definitions, annotation tasks, model versions, experiment results, prediction
results, and user settings. Large files remain in the application-managed
workspace, while the UI only shows business objects such as datasets, tasks,
models, experiments, and annotation batches.

### Key Changes

- Add a new desktop app:
  - `desktop/`: Tauri + React frontend and Rust main process.
  - `app_backend/`: Python API/task service wrapping YOLO training, prediction,
    and data conversion logic.
  - `%APPDATA%\AnimalDetectionWorkbench\`: default app data directory containing
    SQLite database, managed assets, task cache, logs, and temporary exported
    YOLO files.
- Use SQLite as the only business state source:
  - Store training parameters, dataset metadata, class tables, annotations,
    predictions, task status, experiment metrics, model versions, and user
    preferences.
  - Do not store business configuration in config files.
  - Do not show `dataset.yaml`, `.json`, `.pt`, or other low-level paths in the
    frontend.
  - When YOLO requires `dataset.yaml`, the backend generates it temporarily from
    SQLite and writes task results back into SQLite afterward.
- Simplify user interaction:
  - User workflow is: import images/videos, start annotation, train model, view
    results, continue improvement.
  - Training page exposes only common parameters: epochs, image size, batch
    size, device, training mode.
  - Advanced parameters are collapsed by default and include recommended
    settings.
  - Model selection shows names such as "Baseline model", "latest multi-class
    model", or "best model from experiment", not paths.

### SQLite Data Model

- `projects`
  - Current project, reserve name, default class table, created time, last opened
    time.
- `media_assets`
  - Image/video/frame records, source, camera site, dimensions, checksum, and
    managed storage location. Storage location is internal only.
- `datasets`
  - Dataset name and type: public data, local labeled set, fine-tuning mix,
    single-class animal dataset.
  - Store dataset composition rule, class table, sample statistics, version.
- `annotation_batches`
  - Annotation batches such as first review round or low-confidence review
    batch.
  - Link images, prediction source, status, and review progress.
- `annotations`
  - Human boxes with image ID, class ID, coordinates, review status, and update
    time.
- `predictions`
  - Model prediction boxes with model version, confidence, coordinates, and
    source task.
- `models`
  - Model version, source experiment, metric summary, and current recommendation
    flag. Weight files are managed by the app; users see only model names and
    metrics.
- `training_jobs`
  - Training task parameters, status, log index, start/end time, and output
    model ID.
- `experiments`
  - Experiment name, training metrics, validation metrics, curve references,
    confusion matrix references, best/last model references.
- `app_settings`
  - Default device, default training parameters, window state, recent projects,
    and other user preferences.

### Implementation Changes

- Rust/Tauri:
  - Start the Python worker.
  - Manage window, tray, file import dialogs, and Windows installer.
  - Provide controlled file selection; users do not type paths.
  - Pass imported files to the backend to register as `media_assets`.
- Python backend:
  - Use SQLite for all business object reads/writes.
  - Provide REST/WebSocket APIs for media import, annotation batch creation,
    annotation save, prediction start, training start, and result querying.
  - Before running YOLO, generate temporary `dataset.yaml` and file lists from
    SQLite.
  - After tasks finish, parse `results.csv`, curves, and model weights, then
    write metrics and model versions back to SQLite.
- Frontend:
  - Home page shows datasets, annotation progress, recent model, and recent
    training results.
  - Built-in annotator uses React + `react-konva`, supporting box drawing,
    dragging, zooming, class selection, prediction confirmation, undo/redo, and
    autosave.
  - Training page uses a wizard: select dataset, select training target,
    recommended parameters, start training.
  - Result page displays experiment cards with metrics, curves, model versions,
    and next actions.

### Workflow

- Import data:
  - User chooses an image/video folder.
  - Backend extracts frames, registers media, and creates annotation batches.
  - SQLite saves media and batch information.
- Prediction-assisted annotation:
  - User selects a model and clicks generate pre-annotations.
  - Backend executes prediction and writes prediction boxes to SQLite.
  - Annotator loads prediction boxes; user confirms or edits them.
- Annotation:
  - User completes review in the built-in annotator.
  - Each box is saved to SQLite in real time.
  - User does not export JSON or manage files.
- Training:
  - User selects a completed or partially completed dataset.
  - Backend generates a temporary YOLO dataset structure from SQLite.
  - After training, metrics, curves, and model versions are written back to
    SQLite.
- Result reuse:
  - User chooses "use this model for prediction" or "fine-tune from this model".
  - System uses model IDs; user does not choose `.pt` paths.

### Test Plan

- SQLite:
  - Test CRUD for datasets, annotations, predictions, training jobs, and model
    versions.
  - Test recoverability of task history, annotation progress, and model results
    after app restart.
- Backend:
  - Test generating temporary YOLO datasets from SQLite.
  - Test parsing and writing back experiment metrics after training.
  - Test task cancellation, failed jobs, and log recovery.
- Frontend:
  - Test annotation autosave, undo/redo, prediction confirmation, and class
    switching.
  - Test the full workflow without users entering config file paths.
  - Test ordinary-user mode showing only simplified parameters and hiding
    advanced parameters by default.
- Integration:
  - Import media, predict, annotate, train, view result, and use new model for
    prediction.
  - Test Windows Chinese paths, paths with spaces, restart recovery, and CUDA
    unavailable prompts.

### Assumptions

- SQLite is the only business state source; config files are allowed only as
  runtime temporary artifacts.
- Large images, videos, and model weights are not stored directly in SQLite.
  They are saved in app-managed storage and referenced by internal asset IDs and
  metadata.
- UI does not show low-level paths, YAML, JSON, or weight file paths.
- Version 1 is single-machine software, without multi-user collaboration.
- Existing Python/YOLO script logic may be reused internally, but the outer
  interaction is database-driven and desktop-UI-driven.

## Completed

### Project Structure

- Created `workbench_app/` as a standalone app folder.
- Created `workbench_app/app_backend/` for the Python FastAPI worker.
- Created `workbench_app/desktop/` for Tauri v2 + React/TypeScript.
- Added local ignore rules for virtualenvs, build outputs, databases, and
  runtime artifacts.

### Backend

- Implemented SQLite as the business state source.
- Added schema for:
  - `projects`
  - `classes`
  - `media_assets`
  - `datasets`
  - `dataset_assets`
  - `annotation_batches`
  - `annotation_batch_items`
  - `annotations`
  - `predictions`
  - `models`
  - `training_jobs`
  - `experiments`
  - `app_settings`
- Added default project and default classes on first startup.
- Added app workspace handling:
  - default: `%APPDATA%\AnimalDetectionWorkbench\`
  - override: `ANIMAL_WORKBENCH_HOME`
- Added REST endpoints for:
  - health check
  - dashboard summary
  - current project
  - classes
  - media import by desktop-selected paths
  - media list
  - internal media content by media ID
  - dataset creation/listing
  - annotation batch creation/listing/detail
  - annotation save/listing
  - training job creation/listing
  - model listing
  - experiment listing
- Added media import service:
  - accepts local paths from Tauri file picker
  - scans folders for supported image/video files
  - copies files into app-managed storage
  - records internal paths only in SQLite
  - creates annotation batches when requested
- Added YOLO dataset export:
  - generates temporary `dataset.yaml` from SQLite
  - writes temporary YOLO image/label folder structure under app runtime
  - keeps YAML as runtime output, not user-facing config
- Added training job service:
  - creates queued jobs in SQLite
  - exports YOLO dataset for a job
  - optional Ultralytics training path is wired behind `run_yolo`
  - parses `results.csv` and registers model/experiment records after training

### Desktop UI

- Added Vite + React + TypeScript frontend.
- Added Tauri v2 Rust shell.
- Added Tauri commands:
  - `pick_media_files`
  - `pick_media_folder`
  - `backend_base_url`
- Added Python worker startup from the Tauri shell.
- Added backend process cleanup on window close.
- Added screens:
  - dashboard
  - datasets
  - annotation
  - training
  - results
- Dataset page:
  - imports files/folders through Tauri commands only
  - creates local labeled datasets from imported media
  - shows managed media and datasets as business objects
- Annotation page:
  - lists imported images
  - loads managed image content by media ID
  - supports drawing normalized bounding boxes on the image
  - saves new annotation boxes to SQLite
  - shows a clear placeholder message when no model exists for pre-annotation
- Training page:
  - exposes simplified parameters: epochs, image size, batch size, device
  - advanced section is folded by default
  - creates training jobs and triggers backend export
- Results page:
  - lists experiments and model versions when available

### Browser Fallback Decision

- Browser upload fallback was added briefly, then removed.
- The desktop file picker path is now the only supported import path.
- Browser/Vite preview is only for layout inspection. Real file import must run
  inside Tauri.

### Rust/Tauri Environment

- Installed Rust using `winget install --id Rustlang.Rustup`.
- Verified toolchain:
  - `rustup 1.29.0`
  - `rustc 1.95.0`
  - `cargo 1.95.0`
  - default host: `x86_64-pc-windows-msvc`
- Fixed Tauri manifest issue by removing the unused library target.
- Added a temporary Windows icon at `desktop/src-tauri/icons/icon.ico`.
- Fixed Rust lifetime issue in backend process cleanup.
- `cargo check` passes for `desktop/src-tauri`.

### Developer Utilities

- Added `npm run dev:stop` in `desktop/package.json`.
- Added `desktop/scripts/stop-dev-ports.ps1` to clear stale `5173` and `8765`
  listeners before running Tauri dev.
- Added `desktop/scripts/tauri-dev.ps1` so `npm run tauri:dev` and
  `npm run tauri:build` automatically add the Rustup Cargo bin directory to
  `PATH` in clean terminals.
- Extended `dev:stop` to close stale Tauri desktop and Cargo watcher processes
  that can lock `target\debug\animal-detection-workbench.exe`.

### Current Session

- Made `npm run tauri:dev` start successfully from a clean PowerShell session.
- Made the Tauri backend launcher prefer:
  - `ANIMAL_WORKBENCH_PYTHON`
  - `app_backend\.venv\Scripts\python.exe`
  - `workbench_app\.venv\Scripts\python.exe`
  - repository `.env\Scripts\python.exe`
  - fallback `python`
- Replaced the garbled Tauri file picker filter label with `Media files`.
- Added annotation update/delete REST endpoints:
  - `PUT /annotations/{annotation_id}`
  - `DELETE /annotations/{annotation_id}`
- Added backend coverage for annotation create, update, delete, and reload.
- Enhanced the annotation canvas:
  - select existing boxes
  - move boxes
  - resize boxes with corner/side handles
  - delete selected boxes
  - undo/redo local annotation edits
  - change class on the selected box
  - save new, edited, and deleted annotations back to SQLite
- Verified the browser preview annotation page can draw a box, delete it, and
  undo the deletion without console errors.

## Verification

Backend:

```text
python -m pytest
5 passed
```

Frontend:

```text
npm run build
passed
```

Rust/Tauri:

```text
cargo check
passed
```

Runtime checks performed:

- FastAPI `/health` returns OK.
- Tauri path import flow test copies a local image into managed storage.
- Imported media can be served back by internal media ID.
- Annotation save endpoint writes boxes to SQLite.
- Annotation update/delete endpoints persist edits and removals.
- `npm run tauri:dev` starts Vite, the Rust shell, the Tauri window process,
  and the Python backend from a clean terminal environment.
- Browser preview of the annotation page shows the canvas and edit controls;
  drawing, delete, and undo were smoke-tested.

## Current Commands

Clear old dev processes:

```powershell
cd D:\Code\animal_detection\workbench_app\desktop
npm run dev:stop
```

Run desktop app:

```powershell
cd D:\Code\animal_detection\workbench_app\desktop
npm run tauri:dev
```

Run backend tests:

```powershell
cd D:\Code\animal_detection\workbench_app\app_backend
..\..\.env\Scripts\python.exe -m pytest
```

Run frontend build:

```powershell
cd D:\Code\animal_detection\workbench_app\desktop
npm run build
```

Run Rust check:

```powershell
cd D:\Code\animal_detection\workbench_app\desktop\src-tauri
cargo check
```

## Known Limitations

- The Tauri worker currently starts `python -m animal_workbench.main`; this
  assumes the active system Python can import backend dependencies. A packaged
  app should bundle or locate a known Python environment.
- The icon is a temporary generated asset.
- Video import is registered, but frame extraction is not implemented yet.
- Annotation editing supports adding, selecting, dragging, resizing, deleting,
  undo/redo, class switching, and saving edits. Prediction confirmation still
  needs work.
- Pre-annotation task execution is not implemented yet.
- Training is wired through job creation and YOLO export; full long-running
  process management, cancellation, logs, and progress streaming still need work.
- The result page currently lists records but does not render curves/confusion
  matrices.
- Windows installer/package verification has not been run yet.

## Next Priorities

1. Run an interactive Tauri folder-picker smoke test on a fresh sample folder.
2. Add task status/log endpoints and frontend polling for training jobs.
3. Add prediction job skeleton and prediction-to-annotation confirmation flow.
4. Add video frame extraction during import.
5. Add model registry actions: recommend model, use for prediction, fine-tune
   from selected model.
6. Add export/import migration tests for app restart recovery.
