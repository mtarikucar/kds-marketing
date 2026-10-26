#!/usr/bin/env python3
"""Build and assemble a clean revision's production candidate, without publishing or deployment.

Run from rust/: python3 scripts/package-release.py /absolute/new/output-directory
SHA-256 panel manifest lines are sorted POSIX relative paths, UTF-8, LF terminated.
Migration SQL checksums use SHA-384, matching sqlx's embedded migration checksums.
"""
import hashlib
import io
import tarfile
import json
import os
import re
import stat
from pathlib import Path
import shutil
import subprocess
import sys


def digest(path, algorithm="sha256"):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, algorithm).hexdigest()


def run(*args):
    return subprocess.check_output(args, text=True).strip()


# Only index.html and these browser asset types belong in the generated panel.
# Configuration, source maps, arbitrary text/JSON and dotfiles are not release assets.
PANEL_ASSET_SUFFIXES = frozenset({
    ".js", ".css", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif",
    ".ico", ".woff", ".woff2", ".ttf", ".otf", ".wasm",
})


def regular_tree(path):
    """Reject links (including ancestors/dangling links) and special files without following them."""
    path = path.absolute()  # resolve() would erase the symlinks we must reject.
    for component in (*reversed(path.parents), path):
        if component.is_symlink():
            raise SystemExit("symlink in release input path")
    if not path.exists():
        return []
    mode = path.lstat().st_mode
    if stat.S_ISREG(mode):
        return [path]
    if not stat.S_ISDIR(mode):
        raise SystemExit("release input must be a regular file or directory")
    entries = [path]
    for child in sorted(path.iterdir()):
        entries.extend(regular_tree(child))
    return entries


def panel_inventory(panel):
    entries = regular_tree(panel)
    files = []
    for path in entries:
        relative = path.relative_to(panel)
        if any(part.startswith(".") or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", part)
               for part in relative.parts):
            raise SystemExit("prohibited generated panel path")
        if path.is_file():
            if relative.as_posix() != "index.html" and path.suffix.lower() not in PANEL_ASSET_SUFFIXES:
                raise SystemExit("prohibited generated panel file type")
            files.append(path)
    if panel / "index.html" not in files:
        raise SystemExit("missing generated panel index.html")
    return files


def clean_revision(revision):
    # Git status intentionally hides skip-worktree/assume-unchanged entries.
    # Packaging must not trust either flag, including parent Cargo configuration.
    entries = run("git", "ls-files", "-v", "-z", "--", ":/").split("\0")
    if any(entry and not entry.startswith("H ") for entry in entries):
        raise SystemExit("masked Git index entries are not valid release provenance")
    if run("git", "rev-parse", "HEAD") != revision or run(
        "git", "status", "--porcelain", "--untracked-files=no"
    ):
        raise SystemExit("package only an unchanged clean committed source revision")


def clean_build_inputs(root):
    """Git's clean status omits ignored/untracked source consumed by Cargo/Vite."""
    tracked = set(run("git", "ls-files", "-z", "--", ".").split("\0"))
    generated = {root / "target", root / "panel/dist", root / "panel/node_modules"}
    for directory, subdirs, filenames in os.walk(root, followlinks=False):
        parent = Path(directory)
        for name in list(subdirs):
            path = parent / name
            if path in generated or path == root / "scripts/__pycache__":
                subdirs.remove(name)
            elif path.is_symlink():
                raise SystemExit("symlink in build source")
        for name in filenames:
            path = parent / name
            if path.is_symlink() or path.relative_to(root).as_posix() not in tracked:
                raise SystemExit("untracked or ignored build input; use a clean packaging checkout")
    # Cargo also reads repository-level configuration above the Rust workspace.
    config = root.parent / ".cargo"
    for path in regular_tree(config):
        if path.is_file() and not run("git", "ls-files", "--", str(path)):
            raise SystemExit("untracked or ignored Cargo configuration")


def build_candidate(root):
    # Cargo emits compiler-artifact metadata even for fresh cached artifacts. Inspect the
    # linked production dependency's actual features, never workspace-test feature metadata.
    build_env = os.environ.copy()
    # This entry point owns the feature/target policy. Ambient rustflags must not inject
    # cfg(feature="test-loopback") behind Cargo's feature metadata; VITE_* must not
    # silently inject machine-local values into the recorded panel source revision.
    build_env["CARGO_ENCODED_RUSTFLAGS"] = ""
    build_env["RUSTFLAGS"] = ""
    build_env["CARGO_TARGET_DIR"] = str(root / "target")
    build_env.pop("CARGO_BUILD_TARGET", None)
    for name in list(build_env):
        if name.startswith("VITE_"):
            del build_env[name]
    build_env.pop("NODE_ENV", None)
    result = subprocess.run(
        ["cargo", "build", "--release", "--locked", "-p", "jeeta", "--message-format=json"],
        check=True, stdout=subprocess.PIPE, text=True, env=build_env,
    )
    try:
        messages = [json.loads(line) for line in result.stdout.splitlines()]
        artifacts = [m for m in messages if m.get("reason") == "compiler-artifact"]
        outbound = [m for m in artifacts if m["target"]["name"] == "jt_outbound"
                    and m["target"]["kind"] == ["lib"]]
        binary = [m for m in artifacts if m["target"]["name"] == "jeeta"
                  and m["target"]["kind"] == ["bin"]]
        if ([m.get("success") for m in messages if m.get("reason") == "build-finished"] != [True]
                or len(outbound) != 1 or len(binary) != 1
                or "test-loopback" in outbound[0]["features"]
                or outbound[0]["profile"]["test"] or binary[0]["profile"]["test"]
                or Path(binary[0]["executable"]) != root / "target/release/jeeta"):
            raise ValueError("unverified build")
    except (ValueError, KeyError, TypeError):
        raise SystemExit("production Cargo artifact evidence missing or test-loopback enabled") from None
    subprocess.run(["pnpm", "--dir", "panel", "install", "--frozen-lockfile"], check=True, env=build_env)
    panel_env = dict(build_env, NODE_ENV="production")
    subprocess.run(["pnpm", "--dir", "panel", "build"], check=True, env=panel_env)


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: package-release.py <new-output-directory>")
    root = Path(os.path.abspath(__file__)).parents[1]
    if Path.cwd() != root:
        raise SystemExit("run from rust/")
    output = Path(os.path.abspath(sys.argv[1]))
    regular_tree(output)
    if output.exists():
        raise SystemExit("output directory must not exist")
    inputs = [root / name for name in (
        "target/release/jeeta", "panel/dist", "panel/public", "migrations", "scripts", "deploy",
    )] + [root.parent / "docs/operations"]
    # Reject existing links BEFORE Cargo or Vite can write through them or erase evidence.
    for source in inputs:
        regular_tree(source)
    revision = run("git", "rev-parse", "HEAD")
    clean_revision(revision)
    clean_build_inputs(root)
    build_candidate(root)
    clean_revision(revision)
    clean_build_inputs(root)
    for source in inputs:
        regular_tree(source)
    if not (root / "target/release/jeeta").is_file():
        raise SystemExit("missing production binary")
    panel_inventory(root / "panel/dist")
    output.mkdir(parents=True, exist_ok=False)
    (output / "REVISION").write_text(revision + "\n", encoding="ascii")
    shutil.copy2(root / "target/release/jeeta", output / "jeeta", follow_symlinks=False)
    shutil.copytree(root / "panel/dist", output / "panel", symlinks=True)
    regular_tree(output / "jeeta")
    panel_inventory(output / "panel")
    # Copy only committed source files; local ignored diagnostics/secrets are never inputs.
    archive = subprocess.check_output(["git", "-C", str(root.parent), "archive", revision,
                                       "rust/migrations", "rust/scripts", "rust/deploy", "docs/operations"])
    with tarfile.open(fileobj=io.BytesIO(archive)) as source:
        for member in source:
            if member.name == "rust":
                continue
            name = member.name.removeprefix("rust/")
            target = output / name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as content, target.open("wb") as dest:
                    shutil.copyfileobj(content, dest)
                target.chmod(member.mode & 0o777)
            else:
                raise SystemExit(f"release source must be a regular file/directory: {name}")
    panel_files = sorted(p for p in (output / "panel").rglob("*") if p.is_file())
    panel_manifest = output / "panel.sha256"
    panel_manifest.write_text("".join(f"{digest(p)}  {p.relative_to(output).as_posix()}\n" for p in panel_files), encoding="utf-8")
    migrations = []
    for up in sorted((output / "migrations").glob("*.up.sql")):
        down = up.with_name(up.name.removesuffix(".up.sql") + ".down.sql")
        if not down.is_file():
            raise SystemExit(f"missing rollback: {down.name}")
        migrations.append({"version": int(up.name.split("_", 1)[0]),
                           "up": up.name, "up_sha384": digest(up, "sha384"),
                           "down": down.name, "down_sha384": digest(down, "sha384")})
    migrations.sort(key=lambda m: m["version"])
    if not migrations or len({m["version"] for m in migrations}) != len(migrations):
        raise SystemExit("empty or duplicate migration versions")
    if len(list((output / "migrations").glob("*.down.sql"))) != len(migrations):
        raise SystemExit("unpaired rollback migration")
    manifest = {
        "format": 1, "source_revision": revision, "source_clean": True,
        "binary_checksum": {"algorithm": "sha256", "value": digest(output / "jeeta")},
        "panel_checksum": {"algorithm": "sha256", "manifest": "panel.sha256", "value": digest(panel_manifest)},
        "migration_versions": [m["version"] for m in migrations], "migrations": migrations,
        "schema_version": migrations[-1]["version"],
        "toolchain": {"rustc": run("rustc", "--version"), "cargo": run("cargo", "--version"),
                      "node": run("node", "--version"), "pnpm": run("pnpm", "--version")},
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    clean_revision(revision)
    print(f"assembled release {revision}")


if __name__ == "__main__":
    main()
