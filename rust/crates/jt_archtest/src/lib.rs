//! Architecture tests: crate dependency boundaries read from `cargo metadata`.
//!
//! The library only reads the workspace description; the rules themselves live in `tests/`.

use std::collections::BTreeSet;
use std::path::Path;
use std::process::Command;
use std::sync::OnceLock;

use serde_json::Value;

/// The workspace manifest, two levels above this crate (`rust/crates/jt_archtest`).
fn workspace_manifest() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../Cargo.toml")
}

/// Parsed output of `cargo metadata --format-version 1 --no-deps` for the workspace.
///
/// Computed once per test process. Panics with the command's stderr when `cargo metadata` fails,
/// because an architecture test that cannot read the workspace must not pass.
pub fn metadata() -> Value {
    static METADATA: OnceLock<Value> = OnceLock::new();
    METADATA
        .get_or_init(|| {
            let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned());
            let output = Command::new(cargo)
                .args([
                    "metadata",
                    "--format-version",
                    "1",
                    "--no-deps",
                    "--manifest-path",
                ])
                .arg(workspace_manifest())
                .output()
                .expect("failed to run `cargo metadata`");
            assert!(
                output.status.success(),
                "`cargo metadata` failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            serde_json::from_slice(&output.stdout).expect("`cargo metadata` printed invalid JSON")
        })
        .clone()
}

/// Names of the normal (non-dev, non-build) dependencies of the workspace package `krate`.
///
/// Panics when `krate` is not a workspace package, so a misspelled name cannot pass vacuously.
pub fn direct_deps(krate: &str) -> BTreeSet<String> {
    let metadata = metadata();
    let package = metadata["packages"]
        .as_array()
        .expect("`cargo metadata` has no `packages` array")
        .iter()
        .find(|p| p["name"] == krate)
        .unwrap_or_else(|| panic!("package `{krate}` is not in the workspace"));
    package["dependencies"]
        .as_array()
        .expect("package has no `dependencies` array")
        .iter()
        .filter(|d| d["kind"].is_null())
        .map(|d| {
            d["name"]
                .as_str()
                .expect("dependency has no `name`")
                .to_owned()
        })
        .collect()
}
