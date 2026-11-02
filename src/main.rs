#[cfg(not(unix))]
compile_error!("Disk Analyzer Lite currently supports macOS and Linux only");

mod fsops;
mod scanner;

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::menu::{AboutMetadata, IsMenuItem, Menu, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, State};

/// Shared app state: the cancel flag of the scan in progress, if any.
#[derive(Default)]
struct AppState {
    cancel: std::sync::Mutex<Option<Arc<AtomicBool>>>,
}

/// Items smaller than total / PRUNE_DIVISOR are merged into "small items" buckets
/// so the UI receives at most a few hundred thousand nodes.
const PRUNE_DIVISOR: u64 = 150_000;

#[derive(Serialize)]
struct ScanResult {
    path: String,
    root: scanner::Out,
    kinds: Vec<scanner::Kind>,
    errors: u64,
    millis: u64,
}

#[derive(Serialize, Clone)]
struct Progress {
    files: u64,
    bytes: u64,
}

fn run_scan(app: AppHandle, path: PathBuf, cancel: Arc<AtomicBool>) -> Result<ScanResult, String> {
    let root = std::fs::canonicalize(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let counters = Arc::new(scanner::Counters::default());
    let done = Arc::new(AtomicBool::new(false));
    let ticker = {
        let (counters, done) = (counters.clone(), done.clone());
        std::thread::spawn(move || {
            while !done.load(Ordering::Relaxed) {
                let p = Progress {
                    files: counters.files.load(Ordering::Relaxed),
                    bytes: counters.bytes.load(Ordering::Relaxed),
                };
                let _ = app.emit("scan-progress", p);
                std::thread::sleep(Duration::from_millis(150));
            }
        })
    };
    let start = Instant::now();
    let result = scanner::scan(&root, &cancel, &counters);
    done.store(true, Ordering::Relaxed);
    let _ = ticker.join();

    let scan = result
        .map_err(|e| format!("{}: {e}", root.display()))?
        .ok_or("Scan cancelled")?;
    let min = (scan.tree.size / PRUNE_DIVISOR).max(1);
    Ok(ScanResult {
        path: root.to_string_lossy().into_owned(),
        root: scanner::prune(scan.tree, min),
        kinds: scan.kinds,
        errors: scan.errors,
        millis: start.elapsed().as_millis() as u64,
    })
}

#[tauri::command]
async fn scan(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<ScanResult, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    // Starting a new scan cancels any scan still running
    if let Some(prev) = state.cancel.lock().unwrap().replace(cancel.clone()) {
        prev.store(true, Ordering::Relaxed);
    }
    tauri::async_runtime::spawn_blocking(move || run_scan(app, PathBuf::from(path), cancel))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_scan(state: State<'_, AppState>) {
    if let Some(c) = state.cancel.lock().unwrap().as_ref() {
        c.store(true, Ordering::Relaxed);
    }
}

/// Trash several items at once; returns `null` per success or an error message per failure.
/// Async so the slow Finder round-trip on macOS never blocks the UI thread.
#[tauri::command]
async fn move_to_trash(paths: Vec<String>) -> Result<Vec<Option<String>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
        fsops::move_to_trash(&paths).into_iter().map(Result::err).collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    fsops::reveal(Path::new(&path)).map_err(|e| e.to_string())
}

#[tauri::command]
fn disk_usage(path: String) -> Result<fsops::DiskUsage, String> {
    fsops::disk_usage(Path::new(&path)).map_err(|e| e.to_string())
}

#[tauri::command]
fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".into())
}

/// Folder passed on the command line, if any: `disk-analyzer-lite ~/Downloads`
#[tauri::command]
fn initial_path() -> Option<String> {
    std::env::args().nth(1).filter(|a| !a.starts_with('-'))
}

const APP_NAME: &str = "Disk Analyzer Lite";
const AUTHOR: &str = "Xavi Esteve";
const AUTHOR_URL: &str = "https://xaviesteve.com";

/// App menu with an About panel crediting the author, plus the standard Edit and Window menus.
/// Items that GTK doesn't support (hide/show all, undo/redo) are only added on macOS.
fn build_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let about = AboutMetadata {
        name: Some(APP_NAME.into()),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        authors: Some(vec![AUTHOR.into()]),
        comments: Some("See what is filling up your disk.".into()),
        copyright: Some(format!("© 2026 {AUTHOR}. MIT License.")),
        license: Some("MIT".into()),
        website: Some(AUTHOR_URL.into()),
        website_label: Some("xaviesteve.com".into()),
        credits: Some(format!("Created by {AUTHOR}\n{AUTHOR_URL}")),
        ..Default::default()
    };
    let sep = || PredefinedMenuItem::separator(app);
    let about = PredefinedMenuItem::about(app, Some(&format!("About {APP_NAME}")), Some(about))?;
    let (sep1, sep2) = (sep()?, sep()?);
    let quit = PredefinedMenuItem::quit(app, None)?;
    let (cut, copy, paste) = (
        PredefinedMenuItem::cut(app, None)?,
        PredefinedMenuItem::copy(app, None)?,
        PredefinedMenuItem::paste(app, None)?,
    );
    let select_all = PredefinedMenuItem::select_all(app, None)?;
    let (minimize, maximize) = (
        PredefinedMenuItem::minimize(app, None)?,
        PredefinedMenuItem::maximize(app, None)?,
    );
    let close = PredefinedMenuItem::close_window(app, None)?;

    let mut app_items: Vec<&dyn IsMenuItem<R>> = vec![&about, &sep1];
    let mut edit_items: Vec<&dyn IsMenuItem<R>> = Vec::new();
    #[cfg(target_os = "macos")]
    let mac = (
        PredefinedMenuItem::hide(app, None)?,
        PredefinedMenuItem::hide_others(app, None)?,
        PredefinedMenuItem::show_all(app, None)?,
        PredefinedMenuItem::undo(app, None)?,
        PredefinedMenuItem::redo(app, None)?,
        sep()?,
        sep()?,
    );
    #[cfg(target_os = "macos")]
    {
        app_items.extend([&mac.0 as &dyn IsMenuItem<R>, &mac.1, &mac.2, &mac.5]);
        edit_items.extend([&mac.3 as &dyn IsMenuItem<R>, &mac.4, &mac.6]);
    }
    app_items.push(&quit);
    edit_items.extend([&cut as &dyn IsMenuItem<R>, &copy, &paste, &select_all]);

    Menu::with_items(
        app,
        &[
            &Submenu::with_items(app, APP_NAME, true, &app_items)?,
            &Submenu::with_items(app, "Edit", true, &edit_items)?,
            &Submenu::with_items(app, "Window", true, &[&minimize, &maximize, &sep2, &close])?,
        ],
    )
}

fn main() {
    // WebKitGTK's DMA-BUF renderer shows a blank window on many NVIDIA and some Wayland setups.
    // The canvas UI doesn't need it, so turn it off unless the user chose otherwise.
    // Safe here: no other threads exist yet.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tauri::Builder::default()
        .menu(build_menu)
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            scan,
            cancel_scan,
            move_to_trash,
            reveal,
            disk_usage,
            home_dir,
            initial_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
