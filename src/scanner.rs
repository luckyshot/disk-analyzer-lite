//! Parallel directory scanner that measures real on-disk usage.
//!
//! The scanner walks a directory tree on a single filesystem, measures each file by
//! the blocks it actually occupies (so sparse and compressed files are not overstated),
//! counts hardlinked files only once, and never follows symlinks.

use rayon::prelude::*;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

/// A file or directory in the full scanned tree.
#[derive(Debug)]
pub struct Node {
    pub name: String,
    /// Bytes on disk (for directories, the sum of everything below).
    pub size: u64,
    /// Number of files (for a file, 1).
    pub files: u64,
    pub is_dir: bool,
    /// Children sorted by size, largest first.
    pub children: Vec<Node>,
}

/// Totals for one file extension.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Kind {
    pub ext: String,
    pub size: u64,
    pub count: u64,
}

/// Live counters, readable from another thread while a scan runs.
#[derive(Default)]
pub struct Counters {
    pub files: AtomicU64,
    pub bytes: AtomicU64,
    pub errors: AtomicU64,
}

pub struct Scan {
    pub tree: Node,
    /// Per-extension totals, largest first.
    pub kinds: Vec<Kind>,
    /// Entries that could not be read (usually permissions).
    pub errors: u64,
}

struct Ctx<'a> {
    dev: u64,
    cancel: &'a AtomicBool,
    counters: &'a Counters,
    hardlinks: Mutex<HashSet<(u64, u64)>>,
    kinds: Mutex<HashMap<String, (u64, u64)>>,
}

/// Lowercase extension of a file name, or "" when it has none.
/// Dotfiles such as `.bashrc` have no extension; overly long suffixes are not treated as one.
pub fn ext_of(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && ext.len() <= 10 => ext.to_lowercase(),
        _ => String::new(),
    }
}

/// Scan `root`. Returns `Ok(None)` if `cancel` was set before the scan completed.
pub fn scan(root: &Path, cancel: &AtomicBool, counters: &Counters) -> io::Result<Option<Scan>> {
    let md = fs::metadata(root)?;
    if !md.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} is not a folder", root.display()),
        ));
    }
    let ctx = Ctx {
        dev: md.dev(),
        cancel,
        counters,
        hardlinks: Mutex::new(HashSet::new()),
        kinds: Mutex::new(HashMap::new()),
    };
    let tree = scan_dir(root, root.to_string_lossy().into_owned(), &ctx);
    if cancel.load(Ordering::Relaxed) {
        return Ok(None);
    }
    let mut kinds: Vec<Kind> = ctx
        .kinds
        .into_inner()
        .unwrap()
        .into_iter()
        .map(|(ext, (size, count))| Kind { ext, size, count })
        .collect();
    kinds.sort_unstable_by(|a, b| b.size.cmp(&a.size).then_with(|| a.ext.cmp(&b.ext)));
    Ok(Some(Scan {
        tree,
        kinds,
        errors: counters.errors.load(Ordering::Relaxed),
    }))
}

fn scan_dir(path: &Path, name: String, ctx: &Ctx) -> Node {
    let mut node = Node {
        name,
        size: 0,
        files: 0,
        is_dir: true,
        children: Vec::new(),
    };
    if ctx.cancel.load(Ordering::Relaxed) {
        return node;
    }
    let entries = match fs::read_dir(path) {
        Ok(e) => e,
        Err(_) => {
            ctx.counters.errors.fetch_add(1, Ordering::Relaxed);
            return node;
        }
    };
    let mut subdirs: Vec<(PathBuf, String)> = Vec::new();
    let mut local_kinds: HashMap<String, (u64, u64)> = HashMap::new();
    for entry in entries {
        let Ok(entry) = entry else {
            ctx.counters.errors.fetch_add(1, Ordering::Relaxed);
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        // DirEntry::metadata does not follow symlinks
        let Ok(md) = entry.metadata() else {
            ctx.counters.errors.fetch_add(1, Ordering::Relaxed);
            continue;
        };
        if md.is_dir() {
            // Stay on one filesystem (skips mounts like /proc, network shares, other volumes)
            if md.dev() == ctx.dev {
                subdirs.push((entry.path(), name));
            }
            continue;
        }
        let mut size = md.blocks() * 512;
        if md.nlink() > 1 && !md.file_type().is_symlink() && !ctx.hardlinks.lock().unwrap().insert((md.dev(), md.ino()))
        {
            size = 0; // another link to this inode was already counted
        }
        let k = local_kinds.entry(ext_of(&name)).or_default();
        k.0 += size;
        k.1 += 1;
        node.size += size;
        node.files += 1;
        node.children.push(Node {
            name,
            size,
            files: 1,
            is_dir: false,
            children: Vec::new(),
        });
    }
    ctx.counters.files.fetch_add(node.files, Ordering::Relaxed);
    ctx.counters.bytes.fetch_add(node.size, Ordering::Relaxed);
    if !local_kinds.is_empty() {
        let mut kinds = ctx.kinds.lock().unwrap();
        for (ext, (s, c)) in local_kinds {
            let k = kinds.entry(ext).or_default();
            k.0 += s;
            k.1 += c;
        }
    }
    let dirs: Vec<Node> = subdirs.into_par_iter().map(|(p, n)| scan_dir(&p, n, ctx)).collect();
    for d in dirs {
        node.size += d.size;
        node.files += d.files;
        node.children.push(d);
    }
    node.children
        .sort_unstable_by(|a, b| b.size.cmp(&a.size).then_with(|| a.name.cmp(&b.name)));
    node
}

/// Compact tree sent to the UI. Field names are short to keep the JSON small.
#[derive(Debug, Serialize)]
pub struct Out {
    /// name
    pub n: String,
    /// size in bytes
    pub s: u64,
    /// file count
    pub f: u64,
    /// children (directories only)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub c: Option<Vec<Out>>,
    /// true for a bucket that aggregates items too small to draw
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub g: bool,
}

/// Convert the full tree into a UI-sized one: within each directory, items smaller
/// than `min` bytes are merged into a single "N small items" bucket. Totals are preserved.
pub fn prune(node: Node, min: u64) -> Out {
    if !node.is_dir {
        return Out {
            n: node.name,
            s: node.size,
            f: 1,
            c: None,
            g: false,
        };
    }
    let mut kids = Vec::new();
    let (mut small_s, mut small_f, mut small_n) = (0u64, 0u64, 0u64);
    for ch in node.children {
        if ch.size >= min {
            kids.push(prune(ch, min));
        } else {
            small_s += ch.size;
            small_f += ch.files;
            small_n += 1;
        }
    }
    if small_n > 0 {
        let label = if small_n == 1 {
            "1 small item".to_string()
        } else {
            format!("{small_n} small items")
        };
        kids.push(Out {
            n: label,
            s: small_s,
            f: small_f,
            c: None,
            g: true,
        });
    }
    Out {
        n: node.name,
        s: node.size,
        f: node.files,
        c: Some(kids),
        g: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;

    fn write(path: &Path, bytes: usize) {
        let mut f = File::create(path).unwrap();
        f.write_all(&vec![7u8; bytes]).unwrap();
    }

    fn on_disk(path: &Path) -> u64 {
        fs::symlink_metadata(path).unwrap().blocks() * 512
    }

    fn run(root: &Path) -> Scan {
        scan(root, &AtomicBool::new(false), &Counters::default())
            .unwrap()
            .unwrap()
    }

    fn find<'a>(n: &'a Node, name: &str) -> Option<&'a Node> {
        n.children.iter().find(|c| c.name == name)
    }

    #[test]
    fn ext_of_handles_common_cases() {
        assert_eq!(ext_of("movie.MP4"), "mp4");
        assert_eq!(ext_of("archive.tar.gz"), "gz");
        assert_eq!(ext_of(".bashrc"), "");
        assert_eq!(ext_of("Makefile"), "");
        assert_eq!(ext_of("trailing."), "");
        assert_eq!(ext_of("weird.thisisnotanext"), "");
    }

    #[test]
    fn measures_sizes_and_counts() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("big.bin"), 200_000);
        fs::create_dir(root.join("sub")).unwrap();
        write(&root.join("sub/a.txt"), 10_000);
        write(&root.join("sub/b.TXT"), 5_000);

        let expected =
            on_disk(&root.join("big.bin")) + on_disk(&root.join("sub/a.txt")) + on_disk(&root.join("sub/b.TXT"));
        let s = run(root);
        assert_eq!(s.tree.size, expected);
        assert_eq!(s.tree.files, 3);
        assert_eq!(s.errors, 0);

        // children sorted largest first
        assert_eq!(s.tree.children[0].name, "big.bin");
        let sub = find(&s.tree, "sub").unwrap();
        assert!(sub.is_dir);
        assert_eq!(sub.files, 2);

        let txt = s.kinds.iter().find(|k| k.ext == "txt").unwrap();
        assert_eq!(txt.count, 2);
        assert_eq!(txt.size, sub.size);
    }

    #[test]
    fn hardlinks_are_counted_once() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("orig.dat"), 100_000);
        fs::hard_link(root.join("orig.dat"), root.join("link.dat")).unwrap();
        let s = run(root);
        assert_eq!(s.tree.files, 2);
        assert_eq!(s.tree.size, on_disk(&root.join("orig.dat")));
    }

    #[test]
    fn symlinks_are_not_followed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join("real")).unwrap();
        write(&root.join("real/data.bin"), 100_000);
        std::os::unix::fs::symlink(root.join("real"), root.join("alias")).unwrap();
        let s = run(root);
        let alias = find(&s.tree, "alias").unwrap();
        assert!(!alias.is_dir, "symlinked directory must be a leaf");
        assert_eq!(s.tree.files, 2); // data.bin + the symlink itself
        assert!(s.tree.size < 2 * on_disk(&root.join("real/data.bin")));
    }

    #[test]
    fn cancelled_scan_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("x"), 10);
        let r = scan(dir.path(), &AtomicBool::new(true), &Counters::default()).unwrap();
        assert!(r.is_none());
    }

    #[test]
    fn scanning_a_file_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("file");
        write(&f, 10);
        assert!(scan(&f, &AtomicBool::new(false), &Counters::default()).is_err());
        assert!(scan(
            &dir.path().join("missing"),
            &AtomicBool::new(false),
            &Counters::default()
        )
        .is_err());
    }

    #[test]
    fn counters_match_result() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..20 {
            write(&dir.path().join(format!("f{i}")), 1000 * i);
        }
        let counters = Counters::default();
        let s = scan(dir.path(), &AtomicBool::new(false), &counters).unwrap().unwrap();
        assert_eq!(counters.files.load(Ordering::Relaxed), s.tree.files);
        assert_eq!(counters.bytes.load(Ordering::Relaxed), s.tree.size);
    }

    fn file(name: &str, size: u64) -> Node {
        Node {
            name: name.into(),
            size,
            files: 1,
            is_dir: false,
            children: vec![],
        }
    }

    #[test]
    fn prune_groups_small_items_and_keeps_totals() {
        let tree = Node {
            name: "/root".into(),
            size: 1111,
            files: 4,
            is_dir: true,
            children: vec![file("big", 1000), file("mid", 100), file("s1", 10), file("s2", 1)],
        };
        let out = prune(tree, 50);
        let kids = out.c.unwrap();
        assert_eq!(out.s, 1111);
        assert_eq!(kids.len(), 3);
        assert_eq!(kids[2].n, "2 small items");
        assert!(kids[2].g);
        assert_eq!(kids[2].s, 11);
        assert_eq!(kids[2].f, 2);
        assert_eq!(kids.iter().map(|k| k.s).sum::<u64>(), 1111);
    }

    #[test]
    fn prune_serializes_compactly() {
        let out = prune(file("a.txt", 5), 1);
        assert_eq!(serde_json::to_string(&out).unwrap(), r#"{"n":"a.txt","s":5,"f":1}"#);
    }
}
