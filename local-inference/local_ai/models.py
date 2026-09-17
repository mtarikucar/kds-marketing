"""Lazy, fixed-revision model adapters. Heavy imports happen only inside the worker."""

import io
import itertools
from pathlib import Path

from .process import InferenceError
from .settings import CLASSIFY_MODEL, CLASSIFY_REVISION, MAX_AUDIO_BYTES, MAX_AUDIO_SECONDS, WHISPER_REVISIONS


def decode_audio(path):
    """Decode uploaded bytes only, with no playlist protocols and a decoded sample cap."""
    import av
    import numpy as np

    limit = 16000 * MAX_AUDIO_SECONDS
    output = io.BytesIO()
    try:
        with open(path, "rb") as source:
            data = source.read(MAX_AUDIO_BYTES + 1)
        if len(data) > MAX_AUDIO_BYTES:
            raise InferenceError(413, "Audio file exceeds 8 MiB")
        with av.open(
            io.BytesIO(data), mode="r", metadata_errors="ignore",
            options={
                "format_whitelist": "wav,mp3,flac,ogg,matroska,webm,mov",
                "protocol_whitelist": "pipe",
            },
        ) as container:
            if not container.streams.audio:
                raise InferenceError(422, "File contains no audio stream")
            container.streams.audio[0].codec_context.thread_count = 1
            resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
            total = 0
            for frame in itertools.chain(container.decode(audio=0), [None]):
                if frame is not None:
                    frame.pts = None
                for converted in resampler.resample(frame):
                    total += converted.samples
                    if total > limit:
                        raise InferenceError(422, "Audio exceeds 120 seconds; split it into shorter clips")
                    output.write(converted.to_ndarray().tobytes())
        if not total:
            raise InferenceError(422, "Audio contains no samples")
    except InferenceError:
        raise
    except Exception:
        raise InferenceError(422, "Invalid or unsupported audio; use WAV, MP3, FLAC, OGG, WebM or MP4") from None
    return np.frombuffer(output.getbuffer(), dtype=np.int16).astype(np.float32) / 32768.0


class ModelEngine:
    def __init__(self, *, allow_download, whisper_size, cache_dir):
        if whisper_size not in WHISPER_REVISIONS:
            raise ValueError("Only multilingual base and small Whisper models are supported")
        self.allow_download = allow_download
        self.whisper_size = whisper_size
        self.cache_dir = cache_dir
        self.classifier = None
        self.transcriber = None

    def _snapshot(self, model, revision, files):
        from huggingface_hub import snapshot_download

        try:
            path = snapshot_download(
                repo_id=model,
                revision=revision,
                allow_patterns=files,
                cache_dir=self.cache_dir,
                local_files_only=not self.allow_download,
                max_workers=1,
            )
            # Offline snapshots can be partial. In particular Whisper's library
            # otherwise tries to fetch a different tokenizer if tokenizer.json is absent.
            if not all((Path(path) / name).is_file() for name in files):
                raise OSError("Incomplete model cache")
            return path
        except Exception:
            raise InferenceError(503, "Model cache unavailable; populate it with LOCAL_AI_ALLOW_DOWNLOAD=1 at container boot, then restart with 0") from None

    def classify(self, text, labels):
        if self.classifier is None:
            path = self._snapshot(CLASSIFY_MODEL, CLASSIFY_REVISION, [
                "config.json", "model.safetensors", "tokenizer.json", "tokenizer_config.json",
                "special_tokens_map.json", "sentencepiece.bpe.model", "README.md",
            ])
            import torch
            from transformers import AutoModelForSequenceClassification, AutoTokenizer, pipeline

            torch.set_num_threads(1)
            torch.set_num_interop_threads(1)
            torch.manual_seed(0)
            torch.use_deterministic_algorithms(True)
            tokenizer = AutoTokenizer.from_pretrained(path, trust_remote_code=False, local_files_only=True, model_max_length=512)
            model = AutoModelForSequenceClassification.from_pretrained(path, trust_remote_code=False, local_files_only=True, use_safetensors=True)
            model.eval()
            self.classifier = pipeline("zero-shot-classification", model=model, tokenizer=tokenizer, device=-1, framework="pt", num_workers=0)
        import torch

        with torch.inference_mode():
            result = self.classifier(text, candidate_labels=labels, multi_label=False, batch_size=1, hypothesis_template="This text is about {}.")
        return {"label": result["labels"][0], "score": float(result["scores"][0])}

    def transcribe(self, path, language):
        audio = decode_audio(path)
        if self.transcriber is None:
            snapshot = self._snapshot(
                f"Systran/faster-whisper-{self.whisper_size}", WHISPER_REVISIONS[self.whisper_size],
                ["config.json", "model.bin", "tokenizer.json", "vocabulary.txt", "README.md"],
            )
            from faster_whisper import WhisperModel

            self.transcriber = WhisperModel(snapshot, device="cpu", compute_type="int8", cpu_threads=1, num_workers=1, local_files_only=True)
        segments, info = self.transcriber.transcribe(
            audio, language=language, task="transcribe", beam_size=1, best_of=1, temperature=0,
            condition_on_previous_text=False, vad_filter=False, word_timestamps=False,
        )
        parts, characters = [], 0
        for segment in segments:
            characters += len(segment.text)
            if characters > 32768:
                raise InferenceError(422, "Transcript exceeds output limit; split the clip")
            parts.append(segment.text)
        return {"text": "".join(parts).strip(), "language": info.language}
