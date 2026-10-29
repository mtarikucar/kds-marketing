//! A phone's commands are kept like ledger history (spec 2026-10-28-device-bridge-design.md §5.6,
//! owner): only device files are purged, never a command row. Read from the files themselves:
//! nothing under `crates/` or `migrations/` deletes from `device_commands`, but a `down`
//! migration (which drops the table whole).

use std::fs;
use std::path::{Path, PathBuf};

use jt_archtest::workspace_dir;

/// What deleting a command row reads as, in lowercase with single spaces. Put together here, so
/// this file does not say it.
fn needle() -> String {
    ["delete", "from", "device_commands"].join(" ")
}

/// `text` in lowercase, every run of whitespace one space, so a statement split over lines or
/// in capitals is found too.
fn normalized(text: &str) -> String {
    text.to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Whether `text` deletes from `device_commands` (also `only device_commands`).
fn deletes_commands(text: &str) -> bool {
    let text = normalized(text);
    let only = ["delete", "from", "only", "device_commands"].join(" ");
    text.contains(&needle()) || text.contains(&only)
}

/// Every file under `dir`, recursively.
fn files_in(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries =
        fs::read_dir(dir).unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()));
    for entry in entries {
        let path = entry.expect("cannot read a directory entry").path();
        if path.is_dir() {
            files_in(&path, out);
        } else {
            out.push(path);
        }
    }
}

#[test]
fn the_scan_finds_a_deletion_however_it_is_written() {
    // The samples are put together too: a literal would be found by the scan of this file.
    let table = "device_commands";
    assert!(deletes_commands(&needle()));
    assert!(deletes_commands(&format!(
        "DELETE{}FROM {table} WHERE workspace_id = $1",
        "\n    "
    )));
    assert!(deletes_commands(&format!("Delete From Only {table}")));
    assert!(!deletes_commands(&format!(
        "delete from {}files where workspace_id = $1",
        "device_"
    )));
    assert!(!deletes_commands(&format!("drop table if exists {table};")));
    assert!(!deletes_commands(&format!(
        "\"delete\", \"from\", \"{table}\""
    )));
}

#[test]
fn no_command_row_is_ever_deleted() {
    let root = workspace_dir();
    let mut files = Vec::new();
    for dir in ["crates", "migrations"] {
        let before = files.len();
        files_in(&root.join(dir), &mut files);
        assert!(
            files.len() > before,
            "nothing under {dir}: the scan would pass vacuously"
        );
    }
    let offending: Vec<String> = files
        .iter()
        .filter(|path| !path.to_string_lossy().ends_with(".down.sql"))
        .filter(|path| {
            // Binary files (fixtures, images) are not read as text.
            fs::read_to_string(path).is_ok_and(|text| deletes_commands(&text))
        })
        .map(|path| {
            path.strip_prefix(&root)
                .unwrap_or(path)
                .display()
                .to_string()
        })
        .collect();
    assert!(
        offending.is_empty(),
        "these delete device command rows, which are kept like ledger history (only device \
         files are purged): {offending:?}"
    );
}
