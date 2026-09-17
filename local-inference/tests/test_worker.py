import importlib
import importlib.util
import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def test_worker_protocol_dispatches_and_sanitizes_errors():
    assert importlib.util.find_spec("local_ai.worker") is not None, "worker protocol is not implemented"
    worker = importlib.import_module("local_ai.worker")
    from local_ai.process import InferenceError

    class Engine:
        def classify(self, text, labels):
            if text == "crash":
                raise RuntimeError("sensitive/path and text")
            return {"label": labels[0], "score": 0.9}

        def transcribe(self, path, language):
            raise InferenceError(422, "Invalid audio")

    requests = [
        {"action": "classify", "payload": {"text": "hi", "labels": ["hello"]}},
        {"action": "transcribe", "payload": {"path": "/tmp/audio", "language": "tr"}},
        {"action": "classify", "payload": {"text": "crash", "labels": ["hello"]}},
        {"action": "custom", "payload": {}},
    ]
    output = io.StringIO()
    worker.serve(Engine(), io.StringIO("\n".join(json.dumps(item) for item in requests)), output)
    responses = [json.loads(line) for line in output.getvalue().splitlines()]
    assert responses[0] == {"result": {"label": "hello", "score": 0.9}}
    assert responses[1] == {"error": {"status": 422, "detail": "Invalid audio"}}
    assert responses[2]["error"]["status"] == 503
    assert "sensitive" not in output.getvalue()
    assert responses[3]["error"]["status"] == 422
