import importlib
import importlib.util
import math
import sys
import types
import wave
from contextlib import nullcontext
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def models_module():
    assert importlib.util.find_spec("local_ai.models") is not None, "model adapters are not implemented"
    return importlib.import_module("local_ai.models")


@pytest.fixture
def model_dependencies(monkeypatch, tmp_path):
    calls = {}

    def snapshot_download(**kwargs):
        calls.setdefault("snapshots", []).append(kwargs)
        for name in kwargs["allow_patterns"]:
            (tmp_path / name).touch()
        return str(tmp_path)

    class Loader:
        @staticmethod
        def from_pretrained(path, **kwargs):
            calls.setdefault("loads", []).append((path, kwargs))
            return types.SimpleNamespace(eval=lambda: None)

    def pipeline(task, **kwargs):
        calls["pipeline"] = (task, kwargs)

        def classify(text, **kwargs):
            calls["classification"] = (text, kwargs)
            return {"labels": ["spor", "ürün"], "scores": [0.8, 0.2], "sequence": text}

        return classify

    def whisper_model(path, **kwargs):
        calls["whisper_load"] = (path, kwargs)

        def transcribe(audio, **kwargs):
            calls["transcription"] = kwargs
            # Actual faster-whisper segments are lazy; text must consume the iterator.
            segments = (types.SimpleNamespace(text=text) for text in (" Merhaba", " dünya "))
            return segments, types.SimpleNamespace(language="tr")

        return types.SimpleNamespace(transcribe=transcribe)

    monkeypatch.setitem(sys.modules, "huggingface_hub", types.SimpleNamespace(snapshot_download=snapshot_download))
    monkeypatch.setitem(sys.modules, "transformers", types.SimpleNamespace(AutoTokenizer=Loader, AutoModelForSequenceClassification=Loader, pipeline=pipeline))
    monkeypatch.setitem(sys.modules, "torch", types.SimpleNamespace(set_num_threads=lambda n: None, set_num_interop_threads=lambda n: None, manual_seed=lambda n: None, use_deterministic_algorithms=lambda value: None, inference_mode=nullcontext))
    monkeypatch.setitem(sys.modules, "faster_whisper", types.SimpleNamespace(WhisperModel=whisper_model))
    return calls


@pytest.mark.parametrize("allow_download", [False, True])
def test_classifier_uses_only_pinned_safe_snapshot_and_reuses_weights(model_dependencies, allow_download):
    models = models_module()
    engine = models.ModelEngine(allow_download=allow_download, whisper_size="base", cache_dir="/cache")
    assert model_dependencies == {}  # constructor/boot must not load/download anything
    assert engine.classify("Bu bir spor haberi.", ["ürün", "spor"]) == {"label": "spor", "score": 0.8}
    engine.classify("İkinci haber.", ["ürün", "spor"])
    snapshots = model_dependencies["snapshots"]
    assert len(snapshots) == 1
    snapshot = snapshots[0]
    assert snapshot["repo_id"] == "MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli"
    assert snapshot["revision"] == "0a71e92a985b6e1ad1828cf67ce9c459639c1dca"
    assert snapshot["local_files_only"] is (not allow_download)
    assert snapshot["max_workers"] == 1
    assert "model.safetensors" in snapshot["allow_patterns"]
    assert not any(name.endswith((".py", ".bin", ".onnx")) for name in snapshot["allow_patterns"])
    for _, options in model_dependencies["loads"]:
        assert options["trust_remote_code"] is False
        assert options["local_files_only"] is True
    assert model_dependencies["loads"][0][1]["model_max_length"] == 512
    assert model_dependencies["loads"][1][1]["use_safetensors"] is True
    assert model_dependencies["pipeline"][1]["device"] == -1
    assert model_dependencies["classification"][1]["batch_size"] == 1
    assert model_dependencies["classification"][1]["multi_label"] is False


def write_wav(path, seconds):
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(b"\0\0" * int(16000 * seconds))
    return path


@pytest.mark.parametrize("size,revision", [("base", "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66"), ("small", "536b0662742c02347bc0e980a01041f333bce120")])
def test_transcription_is_cpu_int8_multilingual_and_deterministic(model_dependencies, tmp_path, size, revision):
    models = models_module()
    engine = models.ModelEngine(allow_download=False, whisper_size=size, cache_dir="/cache")
    audio = write_wav(tmp_path / "audio.wav", 0.1)
    assert engine.transcribe(str(audio), "tr") == {"text": "Merhaba dünya", "language": "tr"}
    snapshot = model_dependencies["snapshots"][0]
    assert snapshot["repo_id"] == f"Systran/faster-whisper-{size}"
    assert snapshot["revision"] == revision
    assert snapshot["local_files_only"] is True
    options = model_dependencies["whisper_load"][1]
    assert options == {"device": "cpu", "compute_type": "int8", "cpu_threads": 1, "num_workers": 1, "local_files_only": True}
    inference = model_dependencies["transcription"]
    assert inference["language"] == "tr"
    assert inference["temperature"] == 0
    assert inference["beam_size"] == 1
    assert inference["best_of"] == 1
    assert inference["vad_filter"] is False
    assert inference["condition_on_previous_text"] is False


@pytest.mark.parametrize("content", [b"not an audio file", b"#EXTM3U\nhttp://127.0.0.1:9/private\n", b"[playlist]\nFile1=file:///etc/passwd\n"])
def test_invalid_audio_and_playlists_fail_before_model_loading(model_dependencies, tmp_path, content):
    models = models_module()
    from local_ai.process import InferenceError

    audio = tmp_path / "audio"
    audio.write_bytes(content)
    engine = models.ModelEngine(allow_download=False, whisper_size="base", cache_dir="/cache")
    with pytest.raises(InferenceError) as error:
        engine.transcribe(str(audio), None)
    assert error.value.status == 422
    assert model_dependencies == {}


def test_audio_duration_cap_is_enforced_before_model_loading(model_dependencies, tmp_path):
    models = models_module()
    from local_ai.process import InferenceError

    engine = models.ModelEngine(allow_download=False, whisper_size="base", cache_dir="/cache")
    audio = write_wav(tmp_path / "long.wav", 121)
    with pytest.raises(InferenceError) as error:
        engine.transcribe(str(audio), "tr")
    assert error.value.status == 422
    assert model_dependencies == {}


def test_bounded_decoder_resamples_stereo_audio(tmp_path):
    models = models_module()
    path = tmp_path / "stereo.wav"
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(44100)
        output.writeframes(b"\0\0\0\0" * 4410)
    samples = models.decode_audio(str(path))
    assert len(samples) == 1600
    assert samples.dtype.name == "float32"
    assert math.isclose(float(samples.sum()), 0)


def test_missing_cache_has_actionable_error_without_online_fallback(monkeypatch):
    models = models_module()
    from local_ai.process import InferenceError

    def missing(**kwargs):
        assert kwargs["local_files_only"] is True
        raise OSError("private/cache/path must not be exposed")

    monkeypatch.setitem(sys.modules, "huggingface_hub", types.SimpleNamespace(snapshot_download=missing))
    engine = models.ModelEngine(allow_download=False, whisper_size="base", cache_dir="/cache")
    with pytest.raises(InferenceError) as error:
        engine.classify("text", ["a"])
    assert error.value.status == 503
    assert "LOCAL_AI_ALLOW_DOWNLOAD" in error.value.detail
    assert "private/cache/path" not in error.value.detail


def test_partial_whisper_cache_cannot_trigger_tokenizer_network_fallback(monkeypatch, tmp_path):
    models = models_module()
    from local_ai.process import InferenceError

    (tmp_path / "model.bin").touch()
    monkeypatch.setitem(sys.modules, "huggingface_hub", types.SimpleNamespace(snapshot_download=lambda **kwargs: str(tmp_path)))
    engine = models.ModelEngine(allow_download=False, whisper_size="base", cache_dir="/cache")
    with pytest.raises(InferenceError) as error:
        engine.transcribe(str(write_wav(tmp_path / "test.wav", 0.1)), "tr")
    assert error.value.status == 503
