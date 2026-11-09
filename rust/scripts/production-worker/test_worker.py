import base64
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("worker", Path(__file__).with_name("worker.py"))
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)

MID = "00000000-0000-4000-8000-000000000001"
PID = "00000000-0000-4000-8000-000000000002"
OUTPUT = "00000000-0000-4000-8000-000000000003"
ANALYSIS = {"title": "Ürün", "description": "Turuncu bir ürün.", "labels": ["ürün"],
            "group_name": "Ürün çekimleri", "quality": "publishable", "depicts": []}
CROP = {"supported": True, "title": "Yakın plan", "left": .25, "top": .25, "right": .75, "bottom": .75}


def png():
    from PIL import Image
    image = Image.new("RGB", (100, 80), (210, 110, 20))
    stream = io.BytesIO()
    image.save(stream, format="PNG")
    return stream.getvalue()


class FakeModel:
    def __init__(self, failure=None):
        self.calls = []
        self.failure = failure

    def run(self, kind, image, instructions, directory):
        self.calls.append((kind, instructions))
        if self.failure:
            raise self.failure
        return dict(ANALYSIS if kind == "analysis" else CROP)


class FakeMcp:
    def __init__(self, kind="analysis", production_kind="crop"):
        self.calls = []
        self.material = {"id": MID, "revision": 4, "mime": "image/png", "tags": {"depicts": ["client_logo"]}, "people": []}
        self.production = {"id": PID, "kind": production_kind, "instructions": "Ortayı kırp", "revision": 1,
                           "sources": [{"material_id": MID, "expected_revision": 4}]}
        self.kind = kind
        self.completed = False
        self.uploads = {}
        self.adds = {}
        self.unknown_completion = False
        self.conflict = False

    def call(self, name, data):
        assert name in w.TOOLS, name
        self.calls.append((name, data))
        suffix = name.removeprefix(w.PREFIX)
        if name == "jeeta.work.checkin":
            item = {"kind": "studio_material_analysis", "material_id": MID, "expected_revision": 4} if self.kind == "analysis" else {
                "kind": "studio_material_production", "production_id": PID, "expected_revision": self.production["revision"]}
            return {"items": [] if self.completed else [item]}
        if suffix == "material_get":
            return {"material": self.material}
        if suffix == "material_production_list":
            # MCP studio.rs uses listed("productions", ...), unlike the HTTP DTO array.
            return {"productions": [self.production]}
        if suffix == "material_preview":
            return {"url": "https://staging.example/files/signed?token=private"}
        if suffix == "material_analysis_claim":
            return {"material": self.material, "claim_token": "analysis-secret", "expected_revision": 4,
                    "preview": {"url": "https://staging.example/files/signed?token=private"}}
        if suffix == "material_production_claim":
            self.production["revision"] += 1
            return {"production": dict(self.production), "claim_token": "production-secret"}
        if suffix.endswith("_complete"):
            if self.conflict:
                raise w.WorkerError("revision_or_claim_conflict")
            if self.unknown_completion:
                raise w.WorkerError("mcp_transport_failed", uncertain=True)
            self.completed = True
            return {}
        if suffix.endswith("_fail"):
            return {}
        if suffix == "file_upload":
            self.uploads[data["request_key"]] = data
            return {"id": "file-id"}
        if suffix == "material_add":
            self.adds[data["request_key"]] = data
            return {"material": {"id": OUTPUT}}
        raise AssertionError(name)


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.root.chmod(0o700)

    def tearDown(self):
        self.tmp.cleanup()

    def supervisor(self, client, model=None):
        return w.Supervisor(client, model or FakeModel(), self.root, {w.origin("https://staging.example")},
                            downloader=lambda *_: png())

    def test_analysis_claim_uses_revision_and_preserves_date_unknown(self):
        client = FakeMcp()
        model = FakeModel()
        self.assertEqual(self.supervisor(client, model).cycle(), "completed")
        complete = next(data for name, data in client.calls if name.endswith("analysis_complete"))
        self.assertEqual(complete["expected_revision"], 4)
        self.assertEqual(complete["claim_token"], "analysis-secret")
        self.assertIsNone(complete["captured_at"])
        self.assertEqual(complete["date_source"], "unknown")
        self.assertNotIn("share", complete)
        self.assertEqual(model.calls, [("analysis", "")])

    def test_crop_writes_real_pixels_and_does_not_grant_share(self):
        from PIL import Image
        client = FakeMcp("production")
        model = FakeModel()
        self.assertEqual(self.supervisor(client, model).cycle(), "completed")
        uploaded = next(iter(client.uploads.values()))
        image = Image.open(io.BytesIO(base64.b64decode(uploaded["content"]["data"])))
        self.assertEqual(image.size, (50, 40))
        added = next(iter(client.adds.values()))
        self.assertIsNone(added["share"])
        self.assertEqual(added["depicts"], ["client_logo"])
        self.assertEqual(added["origin"]["kind"], "ai_generated")
        self.assertFalse((self.root / ("crop-" + PID)).exists())
        self.assertFalse(any("publish" in name for name, _ in client.calls))

    def test_uncertain_completion_reuses_cached_output_without_another_model_charge(self):
        client = FakeMcp("production")
        client.unknown_completion = True
        model = FakeModel()
        supervisor = self.supervisor(client, model)
        with self.assertRaises(w.WorkerError):
            supervisor.cycle()
        self.assertFalse(any(name.endswith("_fail") for name, _ in client.calls))
        # Simulate a later check-in after server lease expiry/reclaim; output remains cached.
        client.unknown_completion = False
        self.assertEqual(supervisor.cycle(), "completed")
        self.assertEqual(len(model.calls), 1)
        self.assertEqual(len(client.uploads), 1)
        self.assertEqual(len(client.adds), 1)

    def test_unsupported_production_and_video_remain_unclaimed(self):
        client = FakeMcp("production", "poster")
        self.assertEqual(self.supervisor(client).cycle(), "idle")
        self.assertFalse(any(name.endswith("_claim") for name, _ in client.calls))
        client = FakeMcp()
        client.material["mime"] = "video/mp4"
        self.assertEqual(self.supervisor(client).cycle(), "idle")
        self.assertFalse(any(name.endswith("_claim") for name, _ in client.calls))

    def test_exact_work_id_and_kind_filter_before_claim(self):
        client = FakeMcp()
        supervisor = self.supervisor(client)
        supervisor.kind = "crop"
        self.assertEqual(supervisor.cycle(), "idle")
        supervisor.kind = "analysis"
        supervisor.work_id = OUTPUT
        self.assertEqual(supervisor.cycle(), "idle")
        self.assertEqual([name for name, _ in client.calls], ["jeeta.work.checkin", "jeeta.work.checkin"])

    def test_cache_capacity_pauses_new_work_without_claim(self):
        client = FakeMcp("production")
        supervisor = self.supervisor(client)
        supervisor.cache_limit = 1
        with self.assertRaisesRegex(w.WorkerError, "worker_cache_full"):
            supervisor.cycle()
        self.assertFalse(any(name.endswith("_claim") for name, _ in client.calls))

    def test_health_never_claims_live_model_success_or_echoes_key(self):
        stream = io.StringIO()
        with patch.dict(os.environ, {"JEETA_WORKER_ENABLE_CODEX": "1", "JEETA_WORKER_API_KEY": "private-health-key", "JEETA_MCP_URL": "https://staging.example/mcp"}):
            with contextlib.redirect_stdout(stream):
                w.main(["--health"])
        value = json.loads(stream.getvalue())
        self.assertEqual(value["event"], "configured_not_verified")
        self.assertFalse(value["live_model_verified"])
        self.assertNotIn("private-health-key", stream.getvalue())

    def test_model_failure_is_fixed_code_and_stale_completion_is_not_success(self):
        client = FakeMcp()
        with self.assertRaisesRegex(w.WorkerError, "model_timeout"):
            self.supervisor(client, FakeModel(w.WorkerError("model_timeout"))).cycle()
        failure = next(data for name, data in client.calls if name.endswith("analysis_fail"))
        self.assertEqual(failure["error_code"], "model_timeout")
        client = FakeMcp()
        client.conflict = True
        with self.assertRaisesRegex(w.WorkerError, "revision_or_claim_conflict"):
            self.supervisor(client).cycle()
        self.assertFalse(client.completed)

    def test_second_local_worker_cannot_acquire_same_lock(self):
        with w.singleton(self.root):
            with self.assertRaisesRegex(w.WorkerError, "worker_already_running"):
                with w.singleton(self.root):
                    self.fail("second worker entered")

    def test_crop_and_analysis_reject_invalid_model_results(self):
        for patch_value in [{"left": float("nan")}, {"left": -1}, {"right": 10**400}, {"bottom": .1}, {"supported": False}]:
            with self.assertRaises(w.WorkerError):
                w.validate_crop({**CROP, **patch_value})
        with self.assertRaises(w.WorkerError):
            w.validate_analysis({**ANALYSIS, "share": "shareable"})
        with self.assertRaises(w.WorkerError):
            w.validate_analysis({**ANALYSIS, "labels": ["x" * 65]})

    def test_url_and_tool_allowlist_reject_cross_host_redirect_and_publish(self):
        client = w.McpClient("https://staging.example/mcp", "private")
        with self.assertRaisesRegex(w.WorkerError, "tool_not_allowed"):
            client.call("jeeta.studio.publish", {})
        with self.assertRaisesRegex(w.WorkerError, "preview_origin_refused"):
            w.download_image("https://other.example/file", {w.origin("https://staging.example")}, 1024)
        with self.assertRaisesRegex(w.WorkerError, "redirect_refused"):
            w.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.example")
        for url in ["http://example.com/mcp", "https://user:secret@example.com/mcp", "file:///tmp/a", "https://exam\nple.com/mcp", " https://example.com/mcp", "https://example.com\\mcp"]:
            with self.assertRaises(w.WorkerError):
                w.origin(url)
        with self.assertRaisesRegex(w.WorkerError, "invalid_mcp_endpoint"):
            w.McpClient("https://staging.example/mcp?token=private", "private")

    def test_budget_reserves_failed_calls_and_pauses_before_claim(self):
        model = w.BudgetedModel(FakeModel(w.WorkerError("model_timeout")), self.root, 1)
        with self.assertRaises(w.WorkerError):
            model.run("analysis", None, "", self.root)
        client = FakeMcp()
        with self.assertRaisesRegex(w.WorkerError, "model_daily_limit"):
            self.supervisor(client, model).cycle()
        self.assertEqual([name for name, _ in client.calls], ["jeeta.work.checkin"])

    def fake_cli(self, code):
        path = self.root / "fake-codex"
        path.write_text("#!/usr/bin/env python3\n" + code)
        path.chmod(0o700)
        return str(path)

    def test_fake_cli_never_receives_key_or_unsafe_tools(self):
        code = '''import json,os,pathlib,sys
assert "JEETA_WORKER_API_KEY" not in os.environ
assert "GH_TOKEN" not in os.environ
assert "OPENAI_API_KEY" not in os.environ
assert "--ignore-user-config" in sys.argv
assert sys.argv[sys.argv.index("--sandbox")+1]=="read-only"
assert 'mcp_servers={}' in sys.argv
for name in ("shell_tool","unified_exec","apps","plugins","computer_use","browser_use","code_mode"):
 assert any(a=="--disable" and b==name for a,b in zip(sys.argv,sys.argv[1:]))
prompt=sys.stdin.read()
assert "super-secret" not in prompt
pathlib.Path(sys.argv[sys.argv.index("--output-last-message")+1]).write_text(''' + repr(json.dumps(ANALYSIS)) + ")\n"
        binary = self.fake_cli(code)
        image = self.root / "input.png"
        image.write_bytes(png())
        with patch.dict(os.environ, {"JEETA_WORKER_API_KEY": "super-secret", "GH_TOKEN": "secret-gh", "OPENAI_API_KEY": "secret-provider"}):
            result = w.CodexModel(binary, "", timeout=5).run("analysis", image, "", self.root)
        self.assertEqual(result, ANALYSIS)

    def test_fake_cli_timeout_and_malformed_output_are_redacted(self):
        image = self.root / "input.png"
        image.write_bytes(png())
        binary = self.fake_cli("import time\ntime.sleep(60)\n")
        with self.assertRaisesRegex(w.WorkerError, "^model_timeout$"):
            w.CodexModel(binary, "", timeout=1).run("analysis", image, "", self.root)
        binary = self.fake_cli("import pathlib,sys\npathlib.Path(sys.argv[sys.argv.index('--output-last-message')+1]).write_text('private invalid output')\n")
        with self.assertRaisesRegex(w.WorkerError, "^model_output_invalid$"):
            w.CodexModel(binary, "", timeout=5).run("analysis", image, "", self.root)

    def test_fake_cli_auth_failure_is_fixed_code_and_diagnostics_bounded(self):
        image = self.root / "input.png"
        image.write_bytes(png())
        binary = self.fake_cli("import sys\nsys.stdin.read()\nsys.stderr.write('private-token=' + 'x'*200000)\nsys.stderr.write('\\nERROR: Your access token could not be refreshed because you have since logged out.\\n')\nsys.exit(1)\n")
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            with self.assertRaisesRegex(w.WorkerError, "^model_auth_unavailable$"):
                w.CodexModel(binary, "", timeout=5).run("analysis", image, "", self.root)
        self.assertEqual(stdout.getvalue() + stderr.getvalue(), "")
        self.assertEqual(w.model_failure_code(b"ERROR: private-token arbitrary failure"), "model_process_failed")

    def test_malformed_production_envelope_is_rejected_before_claim(self):
        for value in ([], {"productions": None}, {"productions": ["private invalid entry"]}):
            client = FakeMcp("crop")
            original = client.call
            client.call = lambda name, data: value if name.endswith("material_production_list") else original(name, data)
            with self.assertRaisesRegex(w.WorkerError, "^invalid_production_list_response$"):
                self.supervisor(client).cycle()
            self.assertFalse(any(name.endswith("_claim") for name, _ in client.calls))

    def test_mcp_http_initialization_sse_and_key_boundary(self):
        seen = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                seen.append((body, self.headers.get("Authorization")))
                self.send_response(200 if "id" in body else 202)
                self.send_header("Mcp-Session-Id", "session-1")
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                if "id" in body:
                    result = {"protocolVersion": "2025-06-18", "capabilities": {}} if body["method"] == "initialize" else {"structuredContent": {"items": []}}
                    self.wfile.write(("event: message\ndata: " + json.dumps({"jsonrpc": "2.0", "id": body["id"], "result": result}) + "\n\n").encode())
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = w.McpClient(f"http://127.0.0.1:{server.server_port}/mcp", "mcp-private")
            self.assertEqual(client.call("jeeta.work.checkin", {}), {"items": []})
            self.assertEqual([body["method"] for body, _ in seen], ["initialize", "notifications/initialized", "tools/call"])
            self.assertTrue(all(auth == "Bearer mcp-private" for _, auth in seen))
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
