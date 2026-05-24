use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
};

use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

struct BackendProcess(Mutex<Option<Child>>);

#[tauri::command]
fn backend_base_url() -> &'static str {
    "http://127.0.0.1:8765"
}

#[tauri::command]
fn pick_media_files(app: AppHandle) -> Result<Vec<String>, String> {
    let files = app
        .dialog()
        .file()
        .add_filter(
            "Media files",
            &[
                "jpg", "jpeg", "png", "bmp", "webp", "tif", "tiff", "mp4", "mov", "avi", "mkv",
            ],
        )
        .blocking_pick_files();

    Ok(files
        .unwrap_or_default()
        .into_iter()
        .filter_map(|path| {
            path.as_path()
                .map(|item| item.to_string_lossy().to_string())
        })
        .collect())
}

#[tauri::command]
fn pick_media_folder(app: AppHandle) -> Result<Vec<String>, String> {
    let folder = app.dialog().file().blocking_pick_folder();
    Ok(folder
        .and_then(|path| {
            path.as_path()
                .map(|item| vec![item.to_string_lossy().to_string()])
        })
        .unwrap_or_default())
}

fn backend_dir() -> Result<PathBuf, String> {
    let current = std::env::current_dir().map_err(|error| error.to_string())?;
    let candidates = [
        current.join("../app_backend"),
        current.join("../../app_backend"),
        current.join("workbench_app/app_backend"),
    ];
    candidates
        .into_iter()
        .find(|path| path.join("animal_workbench").exists())
        .ok_or_else(|| "Could not locate app_backend directory.".to_string())
}

fn python_executable(backend: &Path) -> PathBuf {
    if let Ok(value) = std::env::var("ANIMAL_WORKBENCH_PYTHON") {
        return PathBuf::from(value);
    }

    let candidates = [
        backend.join(".venv/Scripts/python.exe"),
        backend.join("../.venv/Scripts/python.exe"),
        backend.join("../../.env/Scripts/python.exe"),
    ];

    candidates
        .into_iter()
        .find(|path| path.exists())
        .unwrap_or_else(|| PathBuf::from("python"))
}

fn start_backend(state: State<BackendProcess>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "Backend process lock failed.")?;
    if guard.is_some() {
        return Ok(());
    }

    let backend = backend_dir()?;
    let child = Command::new(python_executable(&backend))
        .arg("-m")
        .arg("animal_workbench.main")
        .current_dir(backend)
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Failed to start Python worker: {error}"))?;
    *guard = Some(child);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(BackendProcess(Mutex::new(None)))
        .setup(|app| {
            let state = app.state::<BackendProcess>();
            if let Err(error) = start_backend(state) {
                eprintln!("{error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backend_base_url,
            pick_media_files,
            pick_media_folder,
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let state = window.state::<BackendProcess>();
                let lock_result = state.0.lock();
                if let Ok(mut guard) = lock_result {
                    if let Some(child) = guard.as_mut() {
                        let _ = child.kill();
                    }
                    *guard = None;
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
