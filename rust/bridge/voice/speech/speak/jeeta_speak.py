"""jeeta-speak: the voice bridge's mouth (design addendum section 6, plan V1-T3 B2).

A long-lived process that keeps EMA Lightning warm and speaks one protocol, one WebSocket per
connection, on a unix socket (the container runs with --network none) or, for development, a
loopback TCP port. SPEAK_SOCKET is `unix:/path`, `/path` or `tcp:127.0.0.1:<port>`.

  client -> {"type": "synth", "id": "<id>", "text": "<a sentence>"}
  server -> binary frames: PCM16 little-endian mono 8000 Hz, in order (the worker encodes G.711)
  server -> {"type": "done", "id": "<id>", "synth_ms": <int>, "audio_ms": <int>, "first_ms": <int>}
  client -> {"type": "cancel", "id": "<id>"}
  server -> {"type": "cancelled", "id": "<id>", "synth_ms": <int>, "audio_ms": <int>}
  server -> {"type": "error", "id": "<id>"|null, "reason": "busy"|"bad_request"|"too_long"|"failed"}

Frames are EMA's chunks (about one second first, then up to four), of any even length. Every frame
of a synthesis comes before its done/cancelled/error message and none after it, and a synthesis
starts only after the previous one's message: a client that cancels drops frames until it reads
that `cancelled`. One synthesis at a time per connection: a second `synth` while one runs is
refused `busy`, except after a `cancel`, when it waits for the cancelled one to unwind and then
starts. A cancel takes effect when EMA hands over its next chunk; the rest of that sentence is
dropped. `first_ms` is the time to the first frame, absent when there was none.

Text goes through the brand respelling table, then Antalia-2 Mini's normaliser, is cut into
sentences, and each sentence is one EMA stream (`sample_rate=8000`, a fixed seed), with 250 ms of
silence between sentences. A one-sentence text is exactly one stream of the normalised text, the
path the owner's blind test heard. The log never carries a text: only lengths, timings and kinds.
"""
import argparse
import asyncio
import contextlib
import hashlib
import json
import logging
import os
import re
import signal
import stat
import sys
import time
import warnings
from concurrent.futures import ThreadPoolExecutor

import numpy as np

from respell import Respeller

LOG = logging.getLogger("jeeta-speak")
# The connections' own logger: at debug level websockets logs every frame, text included.
WS_LOG = logging.getLogger("jeeta-speak.websocket")
WS_LOG.setLevel(logging.WARNING)

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLE_RATE = 8000
# EMA's own pause between the pieces it cuts a long text into (ema_lightning/chunker.py).
SENTENCE_GAP = b"\x00\x00" * (SAMPLE_RATE // 4)
MIN_SENTENCE_WORDS = 3
MAX_TEXT_CHARS = 2000
MAX_ID_CHARS = 128
MAX_MESSAGE_BYTES = 1 << 20
DEFAULT_SOCKET = "unix:/run/jeeta-voice/speak.sock"
LOOPBACK = {"127.0.0.1", "::1", "localhost"}
CLOCK_PROBE = "Salı saat 14:00'e randevunuz var."
WARM_TEXT = "Merhaba, ben dijital asistanınız; size nasıl yardımcı olabilirim?"
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
_RUNNING = set()


def tr_lower(text):
    return text.replace("I", "ı").replace("İ", "i").lower()


def split_sentences(text):
    """The sentences of a normalised text: cut after . ! ? and a space (after Antalia's normaliser
    numbers, times and abbreviations are words, so a period left is a sentence's end). A piece of
    fewer than three words joins the next one ("evet. tamam. yarın görüşürüz." stays whole)."""
    out, pending = [], ""
    for part in _SENTENCE_END.split(text.strip()):
        pending = f"{pending} {part}".strip()
        if len(pending.split()) >= MIN_SENTENCE_WORDS:
            out.append(pending)
            pending = ""
    if pending:
        if out:
            out[-1] = f"{out[-1]} {pending}"
        else:
            out.append(pending)
    return out


def to_pcm16(audio):
    samples = np.asarray(audio, dtype=np.float32).reshape(-1)
    return np.rint(np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


class Mouth:
    def __init__(self, respeller, normalize, tts, seed, sample_rate=SAMPLE_RATE):
        self.respeller = respeller
        self.normalize = normalize
        self.tts = tts
        self.seed = seed
        self.sample_rate = sample_rate
        self.weights = {}  # name -> sha256 of the weights checked before loading

    def spoken(self, text):
        return self.normalize(self.respeller.apply(text))

    def sentences(self, text):
        return split_sentences(self.spoken(text))

    def model_text(self, text):
        """What EMA's model reads for `text` (its frontend runs after ours), or None if unknown."""
        frontend = getattr(self.tts, "_frontend", None)
        if frontend is None:
            return None
        return " ".join(frontend(s) for s in self.sentences(text))

    def chunks(self, text):
        """PCM16 chunks of `text`, as EMA makes them. Closing this generator stops EMA's work."""
        for i, sentence in enumerate(self.sentences(text)):
            if i:
                yield SENTENCE_GAP
            stream = self.tts.stream(sentence, sample_rate=self.sample_rate, seed=self.seed)
            try:
                for audio in stream:
                    pcm = to_pcm16(audio)
                    if pcm:
                        yield pcm
            finally:
                close = getattr(stream, "close", None)
                if close is not None:
                    close()


def measure(mouth, text):
    """(first chunk ms, total ms, audio ms) of one synthesis."""
    started, first, samples = time.monotonic(), None, 0
    for chunk in mouth.chunks(text):
        if first is None:
            first = int((time.monotonic() - started) * 1000)
        samples += len(chunk) // 2
    return first, int((time.monotonic() - started) * 1000), samples * 1000 // mouth.sample_rate


def env_int(name, default, low, high):
    raw = os.environ.get(name, str(default))
    try:
        value = int(raw)
    except ValueError:
        raise SystemExit(f"{name} must be an integer") from None
    if not low <= value <= high:
        raise SystemExit(f"{name} must be from {low} to {high}")
    return value


def set_batch(tts, size):
    """EMA measures its best batch size on first use (every size up to 8 on its probe sentence) and
    caches the result under ~/.cache, which this read-only container cannot write; a failed write
    fails every synthesis in that turn. One line means at most two streams (the live sentence and
    the pre-synthesis), so the size is fixed instead (ema-lightning 1.1.2, `EMA._batch_size`)."""
    if not hasattr(tts, "_batch_size"):
        raise SystemExit("ema-lightning changed: it has no batch size to fix")
    tts._batch_size = size


def build_mouth():
    """The real mouth: the pinned weights checked, EMA loaded on the CPU, Antalia's normaliser."""
    import torch
    from antalia_mini import Antalia
    from ema_lightning import EMA

    import pins

    try:
        weights = pins.verify(pins.load_lock(os.environ.get("SPEAK_WEIGHTS_LOCK", str(pins.LOCK))))
    except (pins.PinError, OSError, ValueError) as e:
        raise SystemExit(f"weights check failed: {e}") from None
    torch.set_num_threads(env_int("SPEAK_THREADS", 2, 1, 16))
    tts = EMA(device="cpu")
    set_batch(tts, env_int("SPEAK_BATCH", 2, 1, 8))
    respeller = Respeller.load(os.environ.get("RESPELL_FILE", os.path.join(HERE, "respell.json")))
    # A static method in antalia-mini 1.0.1: the text the model reads, with no weights loaded.
    mouth = Mouth(respeller, Antalia.normalize, tts, env_int("EMA_SEED", 0, 0, 2**31 - 1))
    mouth.weights = weights
    return mouth


def self_test(mouth):
    """The readings the owner's test depended on, as EMA's model receives them; the process
    refuses to start without them."""
    reading = mouth.model_text(CLOCK_PROBE)
    if reading is None:
        raise SystemExit("self-test: the voice does not show the text its model reads")
    if "on dörde" not in reading or "nokta" in reading:
        raise SystemExit("normaliser self-test failed: 14:00'e")
    for written, said in mouth.respeller.table.items():
        reading = mouth.model_text(f"Bugün {written} hakkında konuşuyoruz.")
        if not re.search(rf"(?<!\w){re.escape(tr_lower(said))}(?!\w)", reading):
            raise SystemExit(f"respelling self-test failed: {written}")


def versions():
    from importlib.metadata import PackageNotFoundError, version

    out = {}
    for name in ("ema-lightning", "antalia-mini", "normalizer-tr", "torch"):
        try:
            out[name] = version(name)
        except PackageNotFoundError:
            out[name] = "?"
    return out


def voice_fingerprint(versions, weights, seed, table):
    """A short id of everything that decides how a text sounds: the cache of synthesised policy
    sentences is only valid for one (the worker's VOICE_ID)."""
    parts = {"versions": versions, "weights": weights, "seed": seed, "rate": SAMPLE_RATE,
             "respell": table}
    encoded = json.dumps(parts, sort_keys=True, ensure_ascii=False).encode()
    return hashlib.sha256(encoded).hexdigest()[:12]


def _quiet_warning(message, category, filename, lineno, file=None, line=None):
    # A library warning may quote the text it failed on (antalia-mini's normaliser fallback does).
    LOG.warning("%s at %s:%d", category.__name__, os.path.basename(filename), lineno)


def configure_logging(level_name):
    level = getattr(logging, level_name.upper(), None)
    if not isinstance(level, int):
        raise SystemExit("SPEAK_LOG must be debug, info, warning or error")
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s %(message)s")
    LOG.setLevel(level)
    warnings.showwarning = _quiet_warning


def parse_endpoint(value):
    if value.startswith("tcp:"):
        host, _, port = value[4:].rpartition(":")
        host = host.strip("[]")
        if host not in LOOPBACK:
            raise ValueError("a TCP endpoint must be on loopback")
        if not port.isdigit() or int(port) > 65535:
            raise ValueError("a TCP endpoint needs a port")
        return ("tcp", host, int(port))
    path = value.removeprefix("unix:")
    if not path.startswith("/"):
        raise ValueError("a unix socket path must be absolute")
    return ("unix", path)


def remove_stale_socket(path):
    try:
        mode = os.lstat(path).st_mode
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(mode):
        raise SystemExit(f"{path} exists and is not a socket")
    os.unlink(path)


@contextlib.asynccontextmanager
async def open_server(endpoint, handler):
    from websockets.asyncio.server import serve, unix_serve

    # No compression (audio does not shrink), no keepalive pings (a local socket closes when its
    # peer dies), a megabyte per message so an over-long text is refused, not a dropped connection.
    options = {"compression": None, "ping_interval": None, "max_size": MAX_MESSAGE_BYTES,
               "logger": WS_LOG}
    if endpoint[0] == "tcp":
        async with serve(handler, endpoint[1], endpoint[2], **options) as server:
            yield server
        return
    path = endpoint[1]
    remove_stale_socket(path)
    old = os.umask(0o117)
    try:
        server = await unix_serve(handler, path, **options)
    finally:
        os.umask(old)
    try:
        os.chmod(path, 0o660)
        yield server
    finally:
        server.close()
        await server.wait_closed()
        with contextlib.suppress(OSError):
            if stat.S_ISSOCK(os.lstat(path).st_mode):
                os.unlink(path)


def health(endpoint):
    """0 when the service answers a WebSocket handshake, 1 otherwise (the image's HEALTHCHECK)."""
    from websockets.sync.client import connect, unix_connect

    options = {"open_timeout": 5, "compression": None}
    try:
        if endpoint[0] == "tcp":
            host = f"[{endpoint[1]}]" if ":" in endpoint[1] else endpoint[1]
            opening = connect(f"ws://{host}:{endpoint[2]}/", **options)
        else:
            opening = unix_connect(endpoint[1], **options)
        with opening:
            return 0
    except Exception:  # noqa: BLE001 - any failure is "unhealthy"
        return 1


def parse_request(message):
    """(kind, id, text, problem): problem is None or the reason of the error to answer."""
    try:
        msg = json.loads(message)
    except ValueError:
        return None, None, None, "bad_request"
    if not isinstance(msg, dict):
        return None, None, None, "bad_request"
    sid = msg.get("id")
    if not (isinstance(sid, str) and 0 < len(sid) <= MAX_ID_CHARS):
        sid = None
    kind = msg.get("type")
    if kind not in ("synth", "cancel") or sid is None:
        return kind, sid, None, "bad_request"
    if kind == "cancel":
        return kind, sid, None, None
    text = msg.get("text")
    if not isinstance(text, str):
        return kind, sid, None, "bad_request"
    if len(text) > MAX_TEXT_CHARS:
        return kind, sid, None, "too_long"
    return kind, sid, text, None


async def run_synth(ws, mouth, pool, sid, text, cancel, after=None):
    from websockets.exceptions import ConnectionClosed

    if after is not None:
        with contextlib.suppress(Exception):
            await after
    loop = asyncio.get_running_loop()
    started, first_ms, samples, gen = time.monotonic(), None, 0, None
    try:
        if not cancel.is_set():
            gen = mouth.chunks(text)
            while True:
                chunk = await loop.run_in_executor(pool, next, gen, None)
                if chunk is None or cancel.is_set():
                    break
                if first_ms is None:
                    first_ms = int((time.monotonic() - started) * 1000)
                samples += len(chunk) // 2
                await ws.send(chunk)
        reply = {
            "type": "cancelled" if cancel.is_set() else "done",
            "id": sid,
            "synth_ms": int((time.monotonic() - started) * 1000),
            "audio_ms": samples * 1000 // SAMPLE_RATE,
        }
        if first_ms is not None:
            reply["first_ms"] = first_ms
        await ws.send(json.dumps(reply))
        LOG.debug("%s: %d chars, first %s ms, synth %d ms, audio %d ms", reply["type"], len(text),
                  first_ms, reply["synth_ms"], reply["audio_ms"])
    except ConnectionClosed:
        cancel.set()
    except Exception as e:  # noqa: BLE001 - report the kind, never the text
        LOG.error("synthesis failed: %s", type(e).__name__)
        with contextlib.suppress(Exception):
            await ws.send(json.dumps({"type": "error", "id": sid, "reason": "failed"}))
    finally:
        if gen is not None:
            with contextlib.suppress(ValueError):  # still running in a thread only at shutdown
                gen.close()


async def session(ws, mouth, pool):
    from websockets.exceptions import ConnectionClosed

    current = None  # (id, cancel event, task) of the last synthesis started
    try:
        async for message in ws:
            if isinstance(message, bytes):
                continue
            kind, sid, text, problem = parse_request(message)
            if problem is not None:
                LOG.warning("refused a request: %s", problem)
                await ws.send(json.dumps({"type": "error", "id": sid, "reason": problem}))
                continue
            busy = current is not None and not current[2].done()
            if kind == "cancel":
                if busy and current[0] == sid:
                    current[1].set()
                continue
            if busy and not current[1].is_set():
                LOG.warning("refused a request: busy")
                await ws.send(json.dumps({"type": "error", "id": sid, "reason": "busy"}))
                continue
            cancel = asyncio.Event()
            after = current[2] if busy else None
            task = asyncio.create_task(run_synth(ws, mouth, pool, sid, text, cancel, after))
            _RUNNING.add(task)
            task.add_done_callback(_RUNNING.discard)
            current = (sid, cancel, task)
    except ConnectionClosed:
        pass
    finally:
        if current is not None:
            current[1].set()


async def serve_forever(endpoint, mouth, pool):
    loop = asyncio.get_running_loop()
    stop = loop.create_future()
    for sig in (signal.SIGTERM, signal.SIGINT):
        with contextlib.suppress(NotImplementedError, AttributeError, ValueError):
            loop.add_signal_handler(sig, lambda: stop.done() or stop.set_result(None))
    async with open_server(endpoint, lambda ws: session(ws, mouth, pool)):
        LOG.info("listening")
        await stop
    LOG.info("stopped")


def main(argv=None):
    parser = argparse.ArgumentParser(prog="jeeta_speak.py")
    parser.add_argument("--health", action="store_true", help="exit 0 if the service answers")
    parser.add_argument("--self-test", action="store_true", help="load, check the readings, exit")
    args = parser.parse_args(argv)
    try:
        endpoint = parse_endpoint(os.environ.get("SPEAK_SOCKET", DEFAULT_SOCKET))
    except ValueError as e:
        raise SystemExit(f"SPEAK_SOCKET: {e}") from None
    if args.health:
        return health(endpoint)
    configure_logging(os.environ.get("SPEAK_LOG", "info"))
    started = time.monotonic()
    mouth = build_mouth()
    loaded_ms = int((time.monotonic() - started) * 1000)
    self_test(mouth)
    found = versions()
    LOG.info("loaded in %d ms: %s; seed %d, voice %s", loaded_ms,
             ", ".join(f"{k} {v}" for k, v in found.items()), mouth.seed,
             voice_fingerprint(found, mouth.weights, mouth.seed, mouth.respeller.table))
    if args.self_test:
        LOG.info("self-test passed")
        return 0
    first, total, audio = measure(mouth, WARM_TEXT)
    LOG.info("warm: first audio in %s ms, %d ms for %d ms of audio", first, total, audio)
    workers = env_int("SPEAK_WORKERS", 2, 1, 8)
    pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="speak")
    asyncio.run(serve_forever(endpoint, mouth, pool))
    return 0


if __name__ == "__main__":
    sys.exit(main())
