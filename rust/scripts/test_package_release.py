"""Release boundary regressions; real Git/filesystem, scripted build tools (no nested Cargo)."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("package-release.py")
SPEC = importlib.util.spec_from_file_location("package_release", SCRIPT)
PACKAGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACKAGE)
REAL_CHECK_OUTPUT = subprocess.check_output
REAL_RUN = subprocess.run


class PackageReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="package-release-test-")
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.root = self.repo / "rust"
        self.output = self.repo / "candidate"
        for directory in ("scripts", "migrations", "deploy", "panel/public", "panel/dist/assets", "target/release"):
            (self.root / directory).mkdir(parents=True)
        (self.repo / "docs/operations").mkdir(parents=True)
        shutil.copy2(SCRIPT, self.root / "scripts/package-release.py")
        self.tracked = {
            "rust/migrations/1_fixture.up.sql": "SELECT 1;\n",
            "rust/migrations/1_fixture.down.sql": "SELECT 1;\n",
            "rust/deploy/jeeta.service": "[Service]\nExecStart=/opt/jeeta/current/jeeta serve\n",
            "rust/panel/package.json": '{}\n',
            "rust/panel/public/logo.svg": '<svg/>\n',
            "docs/operations/deployment.md": "Synthetic fixture\n",
            ".gitignore": "rust/target/\nrust/panel/dist/\n.env*\n",
        }
        for name, content in self.tracked.items():
            (self.repo / name).write_text(content)
        self.git("init", "-q")
        author = REAL_CHECK_OUTPUT(
            ["git", "-C", str(SCRIPT.resolve().parents[2]), "show", "-s", "--format=%an%x00%ae", "HEAD"],
            text=True,
        ).strip().split("\0")
        self.git("config", "user.name", author[0])
        self.git("config", "user.email", author[1])
        self.git("add", *self.tracked, "rust/scripts/package-release.py")
        self.git("commit", "-qm", "test: synthetic packaging fixture")
        self.revision = self.git("rev-parse", "HEAD")
        self.binary = self.root / "target/release/jeeta"
        self.binary.write_bytes(b"STALE BINARY FROM ANOTHER REVISION")
        self.binary.chmod(0o755)
        self.panel = self.root / "panel/dist"
        (self.panel / "index.html").write_text("STALE PANEL")
        (self.panel / "assets/stale.js").write_text("STALE ASSET")
        self.calls = []
        self.build_envs = []
        self.features = []
        self.after_build = lambda: None
        self.cargo_success = True
        self.report_artifacts = True
        self.build_fails = False

    def git(self, *args):
        return REAL_CHECK_OUTPUT(["git", "-C", str(self.repo), *args], text=True, stderr=subprocess.STDOUT).strip()

    def build(self, args):
        args = list(args)
        self.calls.append(args)
        if self.build_fails:
            raise subprocess.CalledProcessError(1, args)
        if args[:2] == ["cargo", "build"]:
            self.binary.write_text("built from " + self.revision)
            messages = []
            if self.report_artifacts:
                messages.extend([
                    {"reason": "compiler-artifact", "target": {"name": "jt_outbound", "kind": ["lib"]}, "features": self.features, "profile": {"test": False}},
                    {"reason": "compiler-artifact", "target": {"name": "jeeta", "kind": ["bin"]}, "features": [], "profile": {"test": False}, "executable": str(self.binary)},
                ])
            messages.append({"reason": "build-finished", "success": self.cargo_success})
            return "\n".join(json.dumps(message) for message in messages)
        if args == ["pnpm", "--dir", "panel", "build"]:
            # Vite empties dist, emits assets, then copies public (including ignored files).
            shutil.rmtree(self.panel)
            (self.panel / "assets").mkdir(parents=True)
            (self.panel / "index.html").write_text("panel built from " + self.revision)
            (self.panel / "assets/index-123.js").write_text("synthetic javascript")
            (self.panel / "assets/index-123.css").write_text("synthetic css")
            shutil.copytree(self.root / "panel/public", self.panel, dirs_exist_ok=True, symlinks=True)
            self.after_build()
        return ""

    def checked_output(self, args, **kwargs):
        args = list(args)
        if args[0] == "git":
            return REAL_CHECK_OUTPUT(args, **kwargs)
        if "--version" in args:
            return "synthetic-toolchain"
        return self.build(args)

    def checked_run(self, args, **kwargs):
        args = list(args)
        if args[0] not in ("cargo", "pnpm"):
            return REAL_RUN(args, **kwargs)
        self.build_envs.append((args, kwargs.get("env", {})))
        return subprocess.CompletedProcess(args, 0, self.build(args), "")

    def package(self):
        previous = Path.cwd()
        try:
            os.chdir(self.root)
            with patch.object(PACKAGE, "__file__", str(self.root / "scripts/package-release.py")), patch("sys.argv", ["package-release.py", str(self.output)]), patch.object(PACKAGE.subprocess, "check_output", side_effect=self.checked_output), patch.object(PACKAGE.subprocess, "run", side_effect=self.checked_run), redirect_stdout(io.StringIO()):
                PACKAGE.main()
        finally:
            os.chdir(previous)

    def assert_refused(self):
        with self.assertRaises((SystemExit, subprocess.CalledProcessError)):
            self.package()
        self.assertFalse(self.output.exists(), "refused inputs must not produce a candidate")

    def test_generated_panel_refuses_secrets_and_unknown_types(self):
        for name in (".env", ".env.production", ".hidden.js", "private.pem", "private.KEY", "notes.txt", "settings.json", "assets/.cache/index.js"):
            with self.subTest(name=name):
                path = self.root / "panel/public" / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("SYNTHETIC SECRET CANARY")
                # Also reproduce the initial externally-built dist accepted by the old packager.
                generated = self.panel / name
                generated.parent.mkdir(parents=True, exist_ok=True)
                generated.write_text("SYNTHETIC SECRET CANARY")
                try:
                    self.assert_refused()
                finally:
                    path.unlink()
                    if generated.exists(): generated.unlink()
                    shutil.rmtree(self.output, ignore_errors=True)
                    # Remove the synthetic hidden directory, which is itself prohibited.
                    for empty in (path.parent, generated.parent):
                        if empty.name == ".cache": empty.rmdir()

    def test_rebuilds_both_artifacts_from_recorded_revision(self):
        self.package()
        self.assertEqual((self.output / "jeeta").read_text(), "built from " + self.revision)
        self.assertEqual((self.output / "panel/index.html").read_text(), "panel built from " + self.revision)
        self.assertFalse((self.output / "panel/assets/stale.js").exists())
        self.assertEqual(self.calls, [
            ["cargo", "build", "--release", "--locked", "-p", "jeeta", "--message-format=json"],
            ["pnpm", "--dir", "panel", "install", "--frozen-lockfile"],
            ["pnpm", "--dir", "panel", "build"],
        ])
        manifest = json.loads((self.output / "manifest.json").read_text())
        self.assertEqual(manifest["source_revision"], self.revision)
        self.assertEqual((self.output / "REVISION").read_text(), self.revision + "\n")
        self.assertEqual(manifest["binary_checksum"]["value"], hashlib.sha256((self.output / "jeeta").read_bytes()).hexdigest())
        self.assertEqual(manifest["panel_checksum"]["value"], hashlib.sha256((self.output / "panel.sha256").read_bytes()).hexdigest())
        self.assertEqual(manifest["migrations"][0]["up_sha384"], hashlib.sha384((self.output / "migrations/1_fixture.up.sql").read_bytes()).hexdigest())
        self.assertEqual(manifest["migration_versions"], [1])

    def test_refuses_test_loopback_build(self):
        self.features = ["test-loopback"]
        self.assert_refused()

    def test_requires_successful_cargo_artifact_evidence(self):
        self.report_artifacts = False
        self.assert_refused()

    def test_refuses_build_failure(self):
        self.build_fails = True
        self.assert_refused()

    def test_refuses_revision_change_during_build(self):
        def advance():
            self.git("commit", "--allow-empty", "-qm", "test: next source revision")
        self.after_build = advance
        self.assert_refused()

    def test_refuses_tracked_changes_during_build(self):
        self.after_build = lambda: (self.root / "panel/package.json").write_text('{"changed":true}')
        self.assert_refused()

    def test_refuses_index_flags_that_hide_modified_source(self):
        path = "rust/panel/public/logo.svg"
        for flag in ("skip-worktree", "assume-unchanged"):
            with self.subTest(flag=flag):
                self.git("update-index", "--" + flag, path)
                (self.repo / path).write_text("hidden local source change")
                try:
                    self.assert_refused()
                    self.assertEqual(self.calls, [])
                finally:
                    self.git("update-index", "--no-" + flag, path)
                    (self.repo / path).write_text(self.tracked[path])
                    self.calls.clear()
                    shutil.rmtree(self.output, ignore_errors=True)

    def test_refuses_dirty_source_before_build(self):
        (self.root / "panel/package.json").write_text('{"changed":true}')
        self.assert_refused()
        self.assertEqual(self.calls, [])

    def test_refuses_symlinks_in_input_roots_and_ancestors(self):
        for relative in ("rust/target/release/jeeta", "rust/target/release", "rust/target", "rust/panel/dist", "rust/panel", "rust/migrations", "rust/scripts", "rust/deploy", "docs/operations", "docs"):
            with self.subTest(path=relative):
                path = self.repo / relative
                saved = self.repo / "saved-input"
                path.rename(saved)
                path.symlink_to(saved, target_is_directory=saved.is_dir())
                try:
                    self.assert_refused()
                    self.assertEqual(self.calls, [], "reject symlinks before a build can follow them")
                finally:
                    path.unlink()
                    saved.rename(path)
                    self.calls.clear()
                    shutil.rmtree(self.output, ignore_errors=True)

    def test_refuses_nested_and_dangling_symlinks_in_every_input_tree(self):
        outside = self.repo / "outside-secret"
        outside.write_text("SYNTHETIC SECRET CANARY")
        for relative in ("rust/panel/dist", "rust/migrations", "rust/scripts", "rust/deploy", "docs/operations"):
            for kind in ("file", "directory", "dangling"):
                with self.subTest(path=relative, kind=kind):
                    link = self.repo / relative / "escape.js"
                    target = {"file": outside, "directory": self.repo, "dangling": self.repo / "missing"}[kind]
                    link.symlink_to(target, target_is_directory=kind == "directory")
                    try:
                        self.assert_refused()
                        self.assertEqual(self.calls, [])
                    finally:
                        link.unlink()
                        self.calls.clear()
                        shutil.rmtree(self.output, ignore_errors=True)

    def test_rechecks_generated_symlinks_after_build(self):
        secret = self.repo / "outside-secret"
        secret.write_text("SYNTHETIC SECRET CANARY")
        self.after_build = lambda: (self.panel / "assets/escape.js").symlink_to(secret)
        self.assert_refused()

    def test_refuses_untracked_allowed_public_asset(self):
        (self.root / "panel/public/uncommitted.js").write_text("not part of the recorded revision")
        self.assert_refused()
        self.assertEqual(self.calls, [])

    def test_refuses_ignored_vite_environment_input(self):
        (self.root / "panel/.env.production").write_text("VITE_SYNTHETIC_CANARY=not-committed")
        self.assert_refused()
        self.assertEqual(self.calls, [])

    def test_controls_build_environment_without_skipping_dev_tools(self):
        with patch.dict(os.environ, {"VITE_SYNTHETIC_CANARY": "not-source", "CARGO_ENCODED_RUSTFLAGS": '--cfg=feature="test-loopback"', "NODE_ENV": "production"}):
            self.package()
        for args, env in self.build_envs:
            self.assertNotIn("VITE_SYNTHETIC_CANARY", env)
            self.assertEqual(env["CARGO_ENCODED_RUSTFLAGS"], "")
            if "install" in args:
                self.assertNotEqual(env.get("NODE_ENV"), "production", "install needs TypeScript/Vite devDependencies")

    def test_validates_generated_inventory_after_build(self):
        for name in (".env", ".env.production", "assets/.secret.js", "private.pem", "private.key", "data.json", "notes.txt", "assets/index.js.map"):
            with self.subTest(name=name):
                def inject():
                    path = self.panel / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("SYNTHETIC GENERATED SECRET")
                self.after_build = inject
                self.assert_refused()
                self.assertEqual(len(self.calls), 3, "must validate the actual generated inventory")
                self.calls.clear()

    def test_untracked_source_files_are_not_packaged(self):
        (self.repo / "docs/operations/untracked-canary").write_text("not shipped")
        self.package()
        self.assertFalse((self.output / "docs/operations/untracked-canary").exists())


if __name__ == "__main__":
    unittest.main()
