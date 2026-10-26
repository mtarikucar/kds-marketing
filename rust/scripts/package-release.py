#!/usr/bin/env python3
"""Assemble a revision's already-built candidate, without publishing or deployment.

Run from rust/: python3 scripts/package-release.py /absolute/new/output-directory
SHA-256 panel manifest lines are sorted POSIX relative paths, UTF-8, LF terminated.
Migration SQL checksums use SHA-384, matching sqlx's embedded migration checksums.
"""
import hashlib
import io
import tarfile
import json
from pathlib import Path
import shutil
import subprocess
import sys


def digest(path, algorithm="sha256"):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, algorithm).hexdigest()


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: package-release.py <new-output-directory>")
    root = Path(__file__).resolve().parents[1]
    if Path.cwd() != root:
        raise SystemExit("run from rust/")
    revision = run("git", "rev-parse", "HEAD")
    # Reject modified tracked inputs; ignored build outputs are expected.
    if run("git", "status", "--porcelain", "--untracked-files=no", "--", ".", "../docs/operations", "../.github/workflows/rust.yml"):
        raise SystemExit("package only a clean committed source revision")
    for required in (root / "target/release/jeeta", root / "panel/dist/index.html"):
        if not required.is_file():
            raise SystemExit(f"missing build input: {required.relative_to(root)}")
    output = Path(sys.argv[1]).resolve()
    output.mkdir(parents=True, exist_ok=False)
    (output / "REVISION").write_text(revision + "\n", encoding="ascii")
    shutil.copy2(root / "target/release/jeeta", output / "jeeta")
    shutil.copytree(root / "panel/dist", output / "panel")
    # Copy only committed source files; local ignored diagnostics/secrets are never inputs.
    archive = subprocess.check_output(["git", "-C", str(root.parent), "archive", "HEAD",
                                       "rust/migrations", "rust/scripts", "rust/deploy", "docs/operations"])
    with tarfile.open(fileobj=io.BytesIO(archive)) as source:
        for member in source:
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
    print(f"assembled release {revision}")


if __name__ == "__main__":
    main()
