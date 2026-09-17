import asyncio
import secrets
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator
from starlette.datastructures import Headers, UploadFile

from .process import InferenceError, ProcessRunner
from .settings import CLASSIFY_MODEL, LANGUAGES, MAX_AUDIO_BYTES, Settings


class ClassifyInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=4096)]
    labels: Annotated[list[Annotated[str, StringConstraints(strict=True, min_length=1, max_length=96)]], Field(min_length=1, max_length=16)]

    @field_validator("text")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("text must not be blank")
        return value

    @field_validator("labels")
    @classmethod
    def unique_labels(cls, value):
        normalized = [label.strip() for label in value]
        if not all(normalized) or len(set(normalized)) != len(value):
            raise ValueError("labels must be nonblank and unique after trimming")
        return value


class ClassifyOutput(BaseModel):
    label: str
    score: float = Field(ge=0, le=1, allow_inf_nan=False)
    model: str


class TranscribeOutput(BaseModel):
    text: str
    language: str
    model: str


class RequestGuard:
    """Authenticate and bound bytes before JSON/multipart parsing or disk spooling."""

    def __init__(self, app, settings):
        self.app, self.settings = app, settings
        self.busy = False

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)

        async def reject(status, detail, extra=None):
            await JSONResponse({"detail": detail}, status_code=status, headers=extra)(scope, receive, send)

        authorization = headers.getlist("authorization")
        if len(authorization) != 1:
            await reject(401, "Bearer token required", {"WWW-Authenticate": "Bearer"})
            return
        scheme, _, token = authorization[0].partition(" ")
        if scheme.lower() != "bearer" or not secrets.compare_digest(token.encode(), self.settings.token.encode()):
            await reject(401, "Invalid bearer token", {"WWW-Authenticate": "Bearer"})
            return
        if scope["method"] != "POST" or scope["path"] not in ("/classify", "/transcribe"):
            await self.app(scope, receive, send)
            return
        if self.busy:
            await reject(429, "Local inference is busy", {"Retry-After": "1"})
            return
        self.busy = True
        try:
            limit = 32768 if scope["path"] == "/classify" else MAX_AUDIO_BYTES + 65536
            lengths = headers.getlist("content-length")
            if lengths:
                if len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit():
                    await reject(400, "Invalid Content-Length")
                    return
                if len(lengths[0]) > 12 or int(lengths[0]) > limit:
                    await reject(413, "Request body is too large")
                    return
            body = bytearray()
            try:
                async with asyncio.timeout(self.settings.upload_timeout_seconds):
                    while True:
                        message = await receive()
                        if message["type"] == "http.disconnect":
                            return
                        chunk = message.get("body", b"")
                        if len(body) + len(chunk) > limit:
                            await reject(413, "Request body is too large")
                            return
                        body.extend(chunk)
                        if not message.get("more_body", False):
                            break
            except TimeoutError:
                await reject(408, "Upload deadline exceeded")
                return
            delivered = False

            async def bounded_receive():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type": "http.request", "body": bytes(body), "more_body": False}
                return await receive()

            await self.app(scope, bounded_receive, send)
        finally:
            self.busy = False


def create_app(settings=None, *, runner=None):
    settings = settings or Settings.from_env()
    runner = runner or ProcessRunner(settings)

    @asynccontextmanager
    async def lifespan(app):
        yield
        await runner.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(RequestGuard, settings=settings)

    @app.exception_handler(InferenceError)
    async def inference_error(request, error):
        return JSONResponse({"detail": error.detail}, status_code=error.status)

    @app.get("/health")
    async def health():
        return {"ok": True, "models": {"classify": CLASSIFY_MODEL, "transcribe": settings.transcribe_model}}

    @app.post("/classify", response_model=ClassifyOutput)
    async def classify(body: ClassifyInput):
        result = await runner.run("classify", body.model_dump())
        if result.get("label") not in body.labels:
            raise InferenceError(503, "Classifier returned an invalid label")
        return {**result, "model": CLASSIFY_MODEL}

    @app.post("/transcribe", response_model=TranscribeOutput)
    async def transcribe(request: Request):
        async with request.form(max_files=1, max_fields=1, max_part_size=1024) as form:
            if set(form) - {"file", "language"}:
                raise HTTPException(422, "Only file and optional language are accepted")
            upload, language = form.get("file"), form.get("language")
            if not isinstance(upload, UploadFile):
                raise HTTPException(422, "An uploaded audio file is required")
            if language is not None and (not isinstance(language, str) or language not in LANGUAGES):
                raise HTTPException(422, "Unsupported language code; use tr for Turkish or omit it")
            if upload.size is not None and upload.size > MAX_AUDIO_BYTES:
                raise HTTPException(413, "Audio file exceeds 8 MiB")
            with tempfile.TemporaryDirectory(prefix="local-ai-") as directory:
                path = Path(directory) / "audio"
                size = 0
                with path.open("wb") as target:
                    while chunk := await upload.read(65536):
                        size += len(chunk)
                        if size > MAX_AUDIO_BYTES:
                            raise HTTPException(413, "Audio file exceeds 8 MiB")
                        target.write(chunk)
                if size == 0:
                    raise HTTPException(422, "Audio file is empty")
                result = await runner.run("transcribe", {"path": str(path), "language": language})
            return {**result, "model": settings.transcribe_model}

    return app
