import math
import os
from dataclasses import dataclass, field

CLASSIFY_MODEL = "MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli"
CLASSIFY_REVISION = "0a71e92a985b6e1ad1828cf67ce9c459639c1dca"
WHISPER_REVISIONS = {
    "base": "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66",
    "small": "536b0662742c02347bc0e980a01041f333bce120",
}
MAX_AUDIO_BYTES = 8 * 1024 * 1024
MAX_AUDIO_SECONDS = 120
# Whisper's multilingual language codes; names/URLs are deliberately not accepted.
LANGUAGES = frozenset("en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su yue".split())


@dataclass(frozen=True)
class Settings:
    token: str = field(repr=False)
    allow_download: bool = False
    whisper_size: str = "base"
    timeout_seconds: float = 120
    upload_timeout_seconds: float = 15
    cache_dir: str = "/models/hub"

    def __post_init__(self):
        if len(self.token) < 32 or any(c.isspace() for c in self.token) or not self.token.isascii():
            raise ValueError("LOCAL_AI_TOKEN must contain at least 32 non-whitespace ASCII characters")
        if self.whisper_size not in WHISPER_REVISIONS:
            raise ValueError("LOCAL_AI_WHISPER_SIZE must be base or small")
        for value in (self.timeout_seconds, self.upload_timeout_seconds):
            if not math.isfinite(value) or not 0.05 <= value <= 600:
                raise ValueError("Timeouts must be finite and between 0.05 and 600 seconds")

    @property
    def transcribe_model(self):
        return f"Systran/faster-whisper-{self.whisper_size}"

    @classmethod
    def from_env(cls):
        download = os.environ.get("LOCAL_AI_ALLOW_DOWNLOAD", "0")
        if download not in ("0", "1"):
            raise ValueError("LOCAL_AI_ALLOW_DOWNLOAD must be 0 or 1")
        return cls(
            token=os.environ.get("LOCAL_AI_TOKEN", ""),
            allow_download=download == "1",
            whisper_size=os.environ.get("LOCAL_AI_WHISPER_SIZE", "base"),
            timeout_seconds=float(os.environ.get("LOCAL_AI_TIMEOUT_SECONDS", "120")),
            upload_timeout_seconds=float(os.environ.get("LOCAL_AI_UPLOAD_TIMEOUT_SECONDS", "15")),
            cache_dir=os.environ.get("LOCAL_AI_CACHE_DIR", "/models/hub"),
        )
