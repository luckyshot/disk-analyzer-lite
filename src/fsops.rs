//! File system operations used by the UI: disk usage, moving to the Trash, revealing files.

use serde::Serialize;
use std::ffi::CString;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Serialize)]
pub struct DiskUsage {
    pub total: u64,
    pub available: u64,
}

/// Size and free space of the volume containing `path`.
#[allow(clippy::unnecessary_cast)] // field types differ between macOS and Linux
pub fn disk_usage(path: &Path) -> io::Result<DiskUsage> {
    let c = CString::new(path.as_os_str().as_bytes()).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let frsize = s.f_frsize as u64;
    Ok(DiskUsage {
        total: s.f_blocks as u64 * frsize,
        available: s.f_bavail as u64 * frsize,
    })
}

/// Refuse paths that must never be trashed: relative paths, paths containing `..`,
/// the filesystem root, and the user's home folder.
pub fn check_trashable(path: &Path, home: Option<&Path>) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!("Refusing to trash a relative path: {}", path.display()));
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("Refusing to trash a path containing '..': {}", path.display()));
    }
    if path.parent().is_none() {
        return Err("Refusing to trash the filesystem root".into());
    }
    if home.is_some_and(|h| h == path) {
        return Err("Refusing to trash your home folder".into());
    }
    Ok(())
}

fn validate(path: &Path, home: Option<&Path>) -> Result<(), String> {
    check_trashable(path, home)?;
    if std::fs::symlink_metadata(path).is_err() {
        return Err(format!("{} no longer exists", path.display()));
    }
    Ok(())
}

/// Move several items to the Trash, returning one result per path, in order.
/// Valid paths are trashed in a single batch (one Finder round-trip on macOS);
/// if the batch fails, each item is retried on its own so the errors are per item.
pub fn move_to_trash(paths: &[PathBuf]) -> Vec<Result<(), String>> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut results: Vec<Result<(), String>> = paths.iter().map(|p| validate(p, home.as_deref())).collect();
    let valid: Vec<&PathBuf> = paths
        .iter()
        .zip(&results)
        .filter(|(_, r)| r.is_ok())
        .map(|(p, _)| p)
        .collect();
    if valid.is_empty() || trash::delete_all(&valid).is_ok() {
        return results;
    }
    for (path, result) in paths.iter().zip(results.iter_mut()) {
        if result.is_ok() && std::fs::symlink_metadata(path).is_ok() {
            *result = trash::delete(path).map_err(|e| e.to_string());
        }
    }
    results
}

/// Percent-encode a path as a `file://` URI (RFC 3986 unreserved characters and `/` kept as-is).
#[cfg_attr(target_os = "macos", allow(dead_code))] // only used on Linux
pub fn file_uri(path: &Path) -> String {
    let mut uri = String::from("file://");
    for &b in path.as_os_str().as_bytes() {
        if b.is_ascii_alphanumeric() || b"-._~/".contains(&b) {
            uri.push(b as char);
        } else {
            uri.push_str(&format!("%{b:02X}"));
        }
    }
    uri
}

/// Run a helper program in the background and reap it when it exits (so it never lingers as a zombie).
/// If it fails, `on_failure` is run instead.
fn run_detached(mut cmd: std::process::Command, on_failure: Option<std::process::Command>) -> io::Result<()> {
    let mut child = cmd.spawn()?;
    std::thread::spawn(move || {
        let ok = child.wait().is_ok_and(|s| s.success());
        if let (false, Some(mut fallback)) = (ok, on_failure) {
            if let Ok(mut c) = fallback.spawn() {
                let _ = c.wait();
            }
        }
    });
    Ok(())
}

/// Show the item selected in Finder (macOS) or the file manager (Linux).
pub fn reveal(path: &Path) -> io::Result<()> {
    use std::process::Command;
    #[cfg(target_os = "macos")]
    {
        let mut c = Command::new("open");
        c.arg("-R").arg(path);
        run_detached(c, None)
    }
    #[cfg(not(target_os = "macos"))]
    {
        // The FileManager1 D-Bus interface (Nautilus, Dolphin, Nemo, Caja, Thunar…) selects the item itself;
        // if no file manager implements it, fall back to opening the containing folder.
        let mut c = Command::new("dbus-send");
        c.args([
            "--session",
            "--print-reply",
            "--dest=org.freedesktop.FileManager1",
            "--type=method_call",
            "/org/freedesktop/FileManager1",
            "org.freedesktop.FileManager1.ShowItems",
        ])
        .arg(format!("array:string:{}", file_uri(path)))
        .arg("string:");
        let dir = if path.is_dir() {
            path
        } else {
            path.parent().unwrap_or(path)
        };
        let open_folder = || {
            let mut c = Command::new("xdg-open");
            c.arg(dir);
            c
        };
        // dbus-send may be missing on minimal systems: then open the folder directly
        run_detached(c, Some(open_folder())).or_else(|_| run_detached(open_folder(), None))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disk_usage_reports_a_real_volume() {
        let dir = tempfile::tempdir().unwrap();
        let u = disk_usage(dir.path()).unwrap();
        assert!(u.total > 0);
        assert!(u.available <= u.total);
    }

    #[test]
    fn disk_usage_fails_for_missing_path() {
        assert!(disk_usage(Path::new("/definitely/not/here")).is_err());
    }

    #[test]
    fn file_uri_escapes_special_characters() {
        assert_eq!(
            file_uri(Path::new("/home/me/My Files/a#1.txt")),
            "file:///home/me/My%20Files/a%231.txt"
        );
        assert_eq!(file_uri(Path::new("/tmp/café,x")), "file:///tmp/caf%C3%A9%2Cx");
    }

    #[test]
    fn trash_guard_rejects_dangerous_paths() {
        let home = Path::new("/Users/someone");
        assert!(check_trashable(Path::new("/"), Some(home)).is_err());
        assert!(check_trashable(Path::new("relative/file"), Some(home)).is_err());
        assert!(check_trashable(Path::new("/Users/someone/../other"), Some(home)).is_err());
        assert!(check_trashable(home, Some(home)).is_err());
        assert!(check_trashable(Path::new("/Users/someone/Downloads/big.dmg"), Some(home)).is_ok());
    }

    #[test]
    fn move_to_trash_reports_errors_per_item() {
        let dir = tempfile::tempdir().unwrap();
        let results = move_to_trash(&[
            dir.path().join("gone.txt"),
            PathBuf::from("/"),
            PathBuf::from("relative"),
        ]);
        assert_eq!(results.len(), 3);
        assert!(results[0].as_ref().unwrap_err().contains("no longer exists"));
        assert!(results[1].as_ref().unwrap_err().contains("root"));
        assert!(results[2].as_ref().unwrap_err().contains("relative"));
    }
}
