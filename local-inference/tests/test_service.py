import asyncio
import importlib.util
import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

TOKEN = "test-local-token-with-at-least-32-characters"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
CLASSIFIER = "MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli"


@pytest.fixture
def api():
    assert importlib.util.find_spec("local_ai") is not None, "local inference service is not implemented"
    from local_ai import service, settings

    return service, settings


class StubRunner:
    def __init__(self):
        self.calls = []

    async def run(self, action, payload):
        self.calls.append((action, payload))
        if action == "classify":
            return {"label": payload["labels"][0], "score": 0.75}
        assert Path(payload["path"]).read_bytes() == b"test audio"
        return {"text": "Merhaba dünya", "language": payload["language"] or "tr"}

    async def close(self):
        pass


@pytest.fixture
def client(api):
    service, settings = api
    runner = StubRunner()
    with TestClient(service.create_app(settings.Settings(token=TOKEN), runner=runner)) as client:
        client.runner = runner
        yield client


@pytest.mark.parametrize("path,method", [("/health", "get"), ("/classify", "post"), ("/transcribe", "post"), ("/docs", "get")])
@pytest.mark.parametrize("authorization", [None, "Bearer wrong", "Basic whatever", "Bearer "])
def test_all_routes_require_token_before_reading_body(client, path, method, authorization):
    headers = {} if authorization is None else {"Authorization": authorization}
    response = getattr(client, method)(path, headers=headers)
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    assert client.runner.calls == []


def test_health_reports_configured_models_without_loading_weights(client):
    assert client.get("/health", headers=AUTH).json() == {
        "ok": True,
        "models": {"classify": CLASSIFIER, "transcribe": "Systran/faster-whisper-base"},
    }
    assert client.runner.calls == []
    assert not any(name in sys.modules for name in ("torch", "transformers", "faster_whisper"))
    assert client.get("/openapi.json", headers=AUTH).status_code == 404


def test_classify_accepts_turkish_and_returns_top_label(client):
    response = client.post("/classify", headers=AUTH, json={"text": "Yeni ürünümüz çıktı.", "labels": ["ürün", "spor"]})
    assert response.status_code == 200
    assert response.json() == {"label": "ürün", "score": 0.75, "model": CLASSIFIER}


@pytest.mark.parametrize("body", [
    {"text": "", "labels": ["a"]},
    {"text": "  ", "labels": ["a"]},
    {"text": "a" * 4097, "labels": ["a"]},
    {"text": 123, "labels": ["a"]},
    {"text": "ok", "labels": []},
    {"text": "ok", "labels": [str(n) for n in range(17)]},
    {"text": "ok", "labels": ["a", "a"]},
    {"text": "ok", "labels": ["a", " a "]},
    {"text": "ok", "labels": [" "]},
    {"text": "ok", "labels": ["a" * 97]},
    {"text": "ok", "labels": [1]},
    {"text": "ok", "labels": ["a"], "url": "http://localhost/private"},
    {"text": "ok", "labels": ["a"], "model": "custom/model"},
])
def test_classification_bounds_and_extra_fields(client, body):
    assert client.post("/classify", headers=AUTH, json=body).status_code == 422
    assert client.runner.calls == []


def test_raw_body_limit_is_enforced_without_content_length(client):
    response = client.post("/classify", headers={**AUTH, "Content-Type": "application/json"}, content=iter([b"x" * 20000, b"x" * 20000]))
    assert response.status_code == 413
    assert client.runner.calls == []


@pytest.mark.parametrize("length", ["-1", "nonsense"])
def test_invalid_content_length(client, length):
    response = client.post("/classify", headers={**AUTH, "Content-Length": length}, content=b"{}")
    assert response.status_code == 400


@pytest.mark.parametrize("language", [None, "tr"])
def test_transcribe_uses_uploaded_bytes_and_cleans_tempfile(client, language):
    response = client.post("/transcribe", headers=AUTH, files={"file": ("../../audio.wav", b"test audio", "audio/wav")}, data={} if language is None else {"language": language})
    assert response.status_code == 200
    assert response.json() == {"text": "Merhaba dünya", "language": "tr", "model": "Systran/faster-whisper-base"}
    assert not Path(client.runner.calls[0][1]["path"]).exists()


@pytest.mark.parametrize("data", [{"language": "https://evil.test"}, {"language": "xx"}, {"url": "https://evil.test/audio.wav"}])
def test_transcribe_rejects_unknown_language_and_extra_fields(client, data):
    response = client.post("/transcribe", headers=AUTH, files={"file": ("a.wav", b"test audio")}, data=data)
    assert response.status_code == 422
    assert client.runner.calls == []


def test_transcribe_rejects_url_instead_of_file(client):
    assert client.post("/transcribe", headers=AUTH, data={"file": "https://evil.test/audio.wav"}).status_code == 422
    assert client.runner.calls == []


@pytest.mark.parametrize("audio,status", [(b"", 422), (b"x" * (8 * 1024 * 1024 + 1), 413)], ids=["empty", "oversize"])
def test_audio_size_bound(client, audio, status):
    response = client.post("/transcribe", headers=AUTH, files={"file": ("a.wav", audio)})
    assert response.status_code == status
    assert client.runner.calls == []


def test_extra_upload_is_rejected(client):
    response = client.post("/transcribe", headers=AUTH, files=[("file", ("a.wav", b"a")), ("file", ("b.wav", b"b"))])
    assert response.status_code == 400
    assert client.runner.calls == []


def test_one_job_at_a_time_while_health_remains_available(api):
    service, settings = api

    async def scenario():
        started, release = asyncio.Event(), asyncio.Event()

        class WaitingRunner(StubRunner):
            async def run(self, action, payload):
                started.set()
                await release.wait()
                return await super().run(action, payload)

        app = service.create_app(settings.Settings(token=TOKEN), runner=WaitingRunner())
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers=AUTH) as client:
            first = asyncio.create_task(client.post("/classify", json={"text": "ok", "labels": ["a"]}))
            await asyncio.wait_for(started.wait(), 2)
            try:
                assert (await client.get("/health")).status_code == 200
                second = await client.post("/transcribe", files={"file": ("a.wav", b"audio")})
                assert second.status_code == 429
                assert second.headers["retry-after"] == "1"
            finally:
                release.set()
                assert (await first).status_code == 200

    asyncio.run(scenario())


def test_upload_deadline_releases_job_slot(api):
    service, settings = api

    async def scenario():
        app = service.create_app(settings.Settings(token=TOKEN, upload_timeout_seconds=0.05), runner=StubRunner())

        async def slow_body():
            yield b"{"
            await asyncio.sleep(0.2)
            yield b"}"

        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers=AUTH) as client:
            assert (await client.post("/classify", content=slow_body())).status_code == 408
            assert (await client.post("/classify", json={"text": "ok", "labels": ["a"]})).status_code == 200

    asyncio.run(scenario())


@pytest.mark.parametrize("status", [422, 503, 504])
def test_worker_errors_preserve_status_and_remove_upload(api, status):
    service, settings = api
    from local_ai.process import InferenceError

    class FailingRunner(StubRunner):
        async def run(self, action, payload):
            self.calls.append((action, payload))
            raise InferenceError(status, "inference failed")

    runner = FailingRunner()
    with TestClient(service.create_app(settings.Settings(token=TOKEN), runner=runner)) as client:
        assert client.post("/transcribe", headers=AUTH, files={"file": ("a.wav", b"audio")}).status_code == status
    assert not Path(runner.calls[0][1]["path"]).exists()


def test_settings_fail_closed_and_allow_only_small_or_base(api, monkeypatch):
    _, settings = api
    monkeypatch.delenv("LOCAL_AI_TOKEN", raising=False)
    with pytest.raises(ValueError):
        settings.Settings.from_env()
    monkeypatch.setenv("LOCAL_AI_TOKEN", TOKEN)
    monkeypatch.delenv("LOCAL_AI_ALLOW_DOWNLOAD", raising=False)
    assert settings.Settings.from_env().allow_download is False
    monkeypatch.setenv("LOCAL_AI_ALLOW_DOWNLOAD", "true")
    with pytest.raises(ValueError):
        settings.Settings.from_env()
    monkeypatch.setenv("LOCAL_AI_ALLOW_DOWNLOAD", "1")
    assert settings.Settings.from_env().allow_download is True
    monkeypatch.setenv("LOCAL_AI_WHISPER_SIZE", "https://evil.test/model")
    with pytest.raises(ValueError):
        settings.Settings.from_env()


@pytest.mark.parametrize("kwargs", [{"token": ""}, {"token": " " * 40}, {"timeout_seconds": 601}, {"timeout_seconds": float("nan")}, {"whisper_size": "large-v3"}])
def test_invalid_settings_cannot_start_service(api, kwargs):
    _, settings = api
    with pytest.raises(ValueError):
        settings.Settings(**({"token": TOKEN} | kwargs))
