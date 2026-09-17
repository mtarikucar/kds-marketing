"""Private JSON-lines worker protocol. Never exposed as a network endpoint."""

import json
import os
import sys

from .models import ModelEngine
from .process import InferenceError


def serve(engine, source, target):
    for line in source:
        try:
            request = json.loads(line)
            if request["action"] == "classify":
                result = engine.classify(**request["payload"])
            elif request["action"] == "transcribe":
                result = engine.transcribe(**request["payload"])
            else:
                raise InferenceError(422, "Unsupported inference action")
            response = {"result": result}
        except InferenceError as error:
            response = {"error": {"status": error.status, "detail": error.detail}}
        except Exception:
            response = {"error": {"status": 503, "detail": "Model inference unavailable; check model cache and resource limits"}}
        target.write(json.dumps(response, allow_nan=False) + "\n")
        target.flush()


if __name__ == "__main__":
    serve(ModelEngine(
        allow_download=os.environ.get("LOCAL_AI_ALLOW_DOWNLOAD", "0") == "1",
        whisper_size=os.environ.get("LOCAL_AI_WHISPER_SIZE", "base"),
        cache_dir=os.environ.get("LOCAL_AI_CACHE_DIR", "/models/hub"),
    ), sys.stdin, sys.stdout)
