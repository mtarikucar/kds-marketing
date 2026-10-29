"""jeeta-speak: the voice bridge's mouth (design addendum section 6, plan V1-T3 B2).

A long-lived process that keeps EMA Lightning warm and speaks one protocol, one WebSocket per
connection, on a unix socket (the container runs with --network none) or, for development, a
loopback TCP port. SPEAK_SOCKET is `unix:/path`, `/path` or `tcp:127.0.0.1:<port>`.

  server -> {"type": "hello", "voice_id": "<12 hex>", "sample_rate": 8000, "format": "pcm16le"}
  client -> {"type": "synth", "id": "<id>", "text": "<a sentence>"}
  server -> binary frames: PCM16 little-endian mono 8000 Hz, in order (the worker encodes G.711)
  server -> {"type": "done", "id": "<id>", "synth_ms": <int>, "audio_ms": <int>, "first_ms": <int>}
  client -> {"type": "cancel", "id": "<id>"}
  server -> {"type": "cancelled", "id": "<id>", "synth_ms": <int>, "audio_ms": <int>}
  server -> {"type": "error", "id": "<id>"|null, "reason": "busy"|"bad_request"|"too_long"|"failed"}

`hello` comes first on every connection: its voice id names everything that decides how a text
sounds (versions, weights, seed, threads, batch, the brand table, the sentence rules), so a client
keys its audio cache by it. Frames are EMA's chunks (about one second first, then up to four), of
any even length. Every frame of a synthesis comes before its terminal message (done, cancelled or
error) and none after it, and a synthesis starts only after the previous one's terminal message.
A cancel can lose the race: a synthesis that already ended is not cancelled, so a client that
cancels drops frames until it reads the terminal message for that id, whichever it is. One
synthesis at a time per connection: a second `synth` while one runs is refused `busy`, except after
a `cancel`, when it waits for the cancelled one to unwind and then starts. A cancel takes effect
when EMA hands over its next chunk; the rest of that sentence is dropped. `first_ms` is the time to
the first frame, absent when there was none.

Text goes through the brand respelling table, then Antalia-2 Mini's normaliser, is cut into
sentences, and each sentence is one EMA stream (`sample_rate=8000`, a fixed seed), with 250 ms of
silence between sentences. A one-sentence text is exactly one stream of the normalised text, the
path the owner's blind test heard. Nothing that holds a text reaches the log: the root handler
passes only this service's records, which carry lengths, timings and kinds.
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
import threading
import time
import traceback
import warnings
from concurrent.futures import ThreadPoolExecutor

import numpy as np

from respell import Respeller

LOG = logging.getLogger("jeeta-speak")
# The connections' logger, outside "jeeta-speak" on purpose: websockets logs every frame (text
# included) at debug level and quotes exceptions at error level, so the root filter withholds it.
WS_LOG = logging.getLogger("speak.websocket")
WS_LOG.setLevel(logging.WARNING)

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLE_RATE = 8000
# EMA's own pause between the pieces it cuts a long text into (ema_lightning/chunker.py).
SENTENCE_GAP_MS = 250
SENTENCE_GAP = b"\x00\x00" * (SAMPLE_RATE * SENTENCE_GAP_MS // 1000)
MIN_SENTENCE_WORDS = 3
# The worker's abbreviations (plan B4 text.rs). Antalia's normaliser expands all of them except
# a lowercase "sn.", "tel." and "st." (antalia-mini 1.0.1, checked 2026-10-29), so a period after
# one of these words never ends a sentence.
ABBREVIATIONS = frozenset([
    "dr", "sn", "av", "prof", "doç", "yrd", "no", "tel", "vb", "vs", "ltd", "şti", "cad", "sok", "mah",
    "apt", "bul", "st",
])
# Bump with any change to how a text becomes sentences or audio that the constants below miss.
PIPELINE_VERSION = 1
MAX_TEXT_CHARS = 2000
# The normalised text a request may become (numbers read out grow several times their digits).
MAX_SPOKEN_CHARS = 4000
MAX_ID_CHARS = 128
MAX_MESSAGE_BYTES = 1 << 20
DEFAULT_SOCKET = "unix:/run/jeeta-voice/speak.sock"
LOOPBACK = {"127.0.0.1", "::1", "localhost"}
CLOCK_PROBE = "Salı saat 14:00'e randevunuz var."
WARM_TEXT = "Merhaba, ben dijital asistanınız; size nasıl yardımcı olabilirim?"
# What Antalia's normaliser should have read out: a digit or one of these symbols left in its
# cased output (before its last pass drops what the model cannot read) was not spoken.
RESIDUE = re.compile(r"[0-9%@#/+]|(?<=\d):|:(?=\d)")
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
_LAST_WORD = re.compile(r"(\w+)\.$")
_RUNNING = set()

# The owner-approved texts the bridge plays (jt_calls opening.rs and phrases.rs defaults, A3/A4),
# with "Jeeta" as the workspace. The self-test reads each one through the real stack.
APPROVED_TEXTS = (
    "Merhaba, ben Jeeta'nın dijital asistanıyım.",
    "Merhaba, ben Jeeta'nın dijital asistanıyım. Size nasıl yardımcı olabilirim?",
    "Görüşmemiz hizmet kalitesi için yazıya dökülmektedir.",
    "Görüşmek üzere, iyi günler.",
    "Hı hı.",
    "Anladım.",
    "Tamam.",
    "Peki.",
    "Bir saniye, hemen bakıyorum.",
    "Kontrol ediyorum, kısa bir an.",
    "Biraz daha zaman alıyor, beklediğiniz için teşekkürler.",
    "Sizi tam duyamadım, tekrar eder misiniz?",
    "Hâlâ orada mısınız?",
    "Kısa bir teknik sorun yaşıyoruz, sizi birkaç dakika içinde geri arayacağız.",
)
# Where EMA's own frontend changes Antalia's reading of an approved text (its alphabet folds the
# circumflex: ema_lightning/frontend.py); everywhere else it must pass the reading through as is.
MODEL_READS = {"hâlâ orada mısınız?": "hala orada mısınız?"}


class TooLong(Exception):
    """The normalised text exceeds MAX_SPOKEN_CHARS."""


def tr_lower(text):
    return text.replace("I", "ı").replace("İ", "i").lower()


def split_sentences(text):
    """The sentences of a normalised text: cut after . ! ? and a space (after Antalia's normaliser
    numbers, times and most abbreviations are words, so a period left is a sentence's end), never
    after one of the worker's abbreviations. A piece of fewer than three words joins the next one
    ("evet. tamam. yarın görüşürüz." stays whole)."""
    out, pending = [], ""
    for part in _SENTENCE_END.split(text.strip()):
        pending = f"{pending} {part}".strip()
        last = _LAST_WORD.search(pending)
        if last and tr_lower(last.group(1)) in ABBREVIATIONS:
            continue
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
    samples = np.nan_to_num(np.asarray(audio, dtype=np.float32).reshape(-1), nan=0.0, posinf=1.0, neginf=-1.0)
    return np.rint(np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


class VoicePool:
    """EMA instances, one per synthesis at a time. One instance batches the streams it serves
    together, and a batched stream's audio differs (in its last bits) from the same sentence alone:
    each synthesis takes an instance of its own, on the event loop, so no worker thread ever waits
    for one."""

    def __init__(self, voices):
        self.voices = list(voices)
        self.free = None
        self.loop = None

    async def acquire(self):
        loop = asyncio.get_running_loop()
        if self.loop is not loop:  # a queue belongs to one loop: the service has one
            self.free, self.loop = asyncio.Queue(), loop
            for v in self.voices:
                self.free.put_nowait(v)
        return await self.free.get()

    def release(self, voice):
        self.free.put_nowait(voice)


class Mouth:
    def __init__(self, respeller, normalize, tts, seed, sample_rate=SAMPLE_RATE, residue=None):
        self.respeller = respeller
        self.normalize = normalize
        # One EMA instance or several (a VoicePool hands them out); the first reads the self-test.
        self.voices = list(tts) if isinstance(tts, (list, tuple)) else [tts]
        self.tts = self.voices[0]
        self.voice_pool = None
        self.seed = seed
        self.sample_rate = sample_rate
        # text -> how many symbols the normaliser left unread (None: not measured).
        self.residue = residue
        self.residual_symbols = 0
        self.weights = {}  # name -> sha256 of the weights checked before loading
        self.voice_id = None

    def spoken(self, text):
        respelled = self.respeller.apply(text)
        if self.residue is not None:
            left = self.residue(respelled)
            if left:
                self.residual_symbols += left
                LOG.warning("the normaliser left %d symbols unread (%d so far)", left, self.residual_symbols)
        return self.normalize(respelled)

    def sentences(self, text):
        spoken = self.spoken(text)
        if len(spoken) > MAX_SPOKEN_CHARS:
            raise TooLong()
        return split_sentences(spoken)

    def model_text(self, text):
        """What EMA's model reads for `text` (its frontend runs after ours), or None if unknown."""
        frontend = getattr(self.tts, "_frontend", None)
        if frontend is None:
            return None
        return " ".join(frontend(s) for s in self.sentences(text))

    def chunks(self, text, tts=None):
        """PCM16 chunks of `text`, as EMA (`tts`, else the first instance) makes them. Closing this
        generator stops EMA's work."""
        tts = tts or self.tts
        for i, sentence in enumerate(self.sentences(text)):
            if i:
                yield SENTENCE_GAP
            stream = tts.stream(sentence, sample_rate=self.sample_rate, seed=self.seed)
            try:
                for audio in stream:
                    pcm = to_pcm16(audio)
                    if pcm:
                        yield pcm
            finally:
                close = getattr(stream, "close", None)
                if close is not None:
                    close()


def measure(mouth, text, tts=None):
    """(first chunk ms, total ms, audio ms) of one synthesis."""
    started, first, samples = time.monotonic(), None, 0
    for chunk in mouth.chunks(text, tts):
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


def settings():
    """The environment's knobs (the unit sets each explicitly)."""
    return {
        "threads": env_int("SPEAK_THREADS", 2, 1, 16),
        "batch": env_int("SPEAK_BATCH", 2, 1, 8),
        "seed": env_int("EMA_SEED", 0, 0, 2**31 - 1),
        "workers": env_int("SPEAK_WORKERS", 2, 1, 8),
        "watchdog_s": env_int("SPEAK_WATCHDOG_S", 60, 10, 600),
    }


def set_batch(tts, size):
    """EMA measures its best batch size on first use (every size up to 8 on its probe sentence) and
    caches the result under ~/.cache, which this read-only container cannot write; a failed write
    fails every synthesis in that turn. The size is fixed instead (ema-lightning 1.1.2,
    `EMA._batch_size`): 2, the value EMA measured for itself in the image the owner tested."""
    if not hasattr(tts, "_batch_size"):
        raise SystemExit("ema-lightning changed: it has no batch size to fix")
    tts._batch_size = size


def versions():
    from importlib.metadata import PackageNotFoundError, version

    out = {}
    for name in ("ema-lightning", "antalia-mini", "normalizer-tr", "torch"):
        try:
            out[name] = version(name)
        except PackageNotFoundError:
            out[name] = "?"
    return out


def pipeline():
    """The sentence and audio rules, as data: a change to any of them changes the voice id."""
    return {
        "version": PIPELINE_VERSION,
        "gap_ms": SENTENCE_GAP_MS,
        "min_words": MIN_SENTENCE_WORDS,
        "splitter": _SENTENCE_END.pattern,
        "abbreviations": sorted(ABBREVIATIONS),
        "rate": SAMPLE_RATE,
    }


def voice_fingerprint(versions, weights, knobs, table):
    """A short id of everything that decides how a text sounds: a cache of synthesised sentences
    is only valid for one (the worker keys its cache by the `hello`'s voice id)."""
    parts = {"versions": versions, "weights": weights, "seed": knobs["seed"], "threads": knobs["threads"],
             "batch": knobs["batch"], "respell": table, "pipeline": pipeline()}
    encoded = json.dumps(parts, sort_keys=True, ensure_ascii=False).encode()
    return hashlib.sha256(encoded).hexdigest()[:12]


def voice_id(knobs=None):
    """The voice id from the installed versions, weights.lock, the knobs and respell.json, without
    loading the model (the weights are checked against the same lock before they are loaded)."""
    import pins

    lock = pins.load_lock()
    weights = {name: entry["sha256"] for name, entry in lock["files"].items()}
    table = Respeller.load(os.path.join(HERE, "respell.json")).table
    return voice_fingerprint(versions(), weights, knobs or settings(), table)


def build_mouth(knobs=None):
    """The real mouth: the pinned weights checked, EMA loaded on the CPU, Antalia's normaliser."""
    import torch
    from antalia_mini import Antalia
    from antalia_mini.text import normalize_for_cased_model
    from ema_lightning import EMA

    import pins

    knobs = knobs or settings()
    try:
        weights = pins.verify(pins.load_lock())
    except (pins.PinError, OSError, ValueError) as e:
        raise SystemExit(f"weights check failed: {e}") from None
    torch.set_num_threads(knobs["threads"])
    voices = [EMA(device="cpu") for _ in range(knobs["workers"])]
    for tts in voices:
        set_batch(tts, knobs["batch"])
    respeller = Respeller.load(os.path.join(HERE, "respell.json"))
    # A static method in antalia-mini 1.0.1: the text the model reads, with no weights loaded. Its
    # cased stage, before the last pass drops what the model cannot read, shows what was not read.
    mouth = Mouth(respeller, Antalia.normalize, voices, knobs["seed"],
                  residue=lambda t: len(RESIDUE.findall(normalize_for_cased_model(t))))
    mouth.voice_pool = VoicePool(voices)
    mouth.weights = weights
    mouth.voice_id = voice_fingerprint(versions(), weights, knobs, respeller.table)
    return mouth


def self_test(mouth):
    """The readings the owner's test depended on, as EMA's model receives them; the process
    refuses to start without them. The clock: "on dörde", not normalizer-tr's "iki nokta ... kesme".
    Each brand: its respelling reaches the model. Each approved text: EMA's frontend keeps
    Antalia's reading as is (or as MODEL_READS says), and no "kesme" is read aloud."""
    reading = mouth.model_text(CLOCK_PROBE)
    if reading is None:
        raise SystemExit("self-test: the voice does not show the text its model reads")
    if "on dörde" not in reading or "nokta" in reading or "kesme" in reading:
        raise SystemExit("normaliser self-test failed: 14:00'e")
    for written, said in mouth.respeller.table.items():
        reading = mouth.model_text(f"Bugün {written} hakkında konuşuyoruz.")
        if not re.search(rf"(?<!\w){re.escape(tr_lower(said))}(?!\w)", reading):
            raise SystemExit(f"respelling self-test failed: {written}")
    frontend = mouth.tts._frontend
    for n, text in enumerate(APPROVED_TEXTS):
        for sentence in mouth.sentences(text):
            read = frontend(sentence)
            if read != MODEL_READS.get(sentence, sentence) or "kesme" in read:
                raise SystemExit(f"approved-text self-test failed: text {n}")


class Watchdog:
    """Ends the process when a synthesis chunk, or the event loop itself, is stuck past `limit_s`,
    so systemd's Restart=always brings a working service back. It runs on its own thread."""

    def __init__(self, limit_s, clock=time.monotonic, exit=os._exit):
        self.limit_s, self.clock, self.exit = limit_s, clock, exit
        self.lock = threading.Lock()
        self.waits = {}
        self.token = 0
        self.beat = clock()

    def begin(self):
        with self.lock:
            self.token += 1
            self.waits[self.token] = self.clock()
            return self.token

    def end(self, token):
        with self.lock:
            self.waits.pop(token, None)

    def heartbeat(self):
        self.beat = self.clock()

    def check(self):
        now = self.clock()
        with self.lock:
            stuck = sum(1 for t in self.waits.values() if now - t > self.limit_s)
        if stuck or now - self.beat > self.limit_s:
            LOG.critical("stuck for over %d s (%d synthesis waits, loop %s): exiting", self.limit_s, stuck,
                         "stalled" if now - self.beat > self.limit_s else "running")
            self.exit(70)
            return True
        return False

    def start(self, period_s=1.0):
        def run():
            while not self.check():
                time.sleep(period_s)

        threading.Thread(target=run, name="speak-watchdog", daemon=True).start()


_watchdog = None


class OnlyOurs(logging.Filter):
    """Passes this service's records only. A library's record may quote a text (antalia-mini's
    normaliser warning does, websockets' frame and error lines can): it is withheld, and one of ours
    says which logger and level it came from."""

    def filter(self, record):
        if record.name == LOG.name or record.name.startswith(LOG.name + "."):
            return True
        if record.levelno >= logging.WARNING:
            LOG.warning("withheld a record (%s) from %s", record.levelname, record.name)
        return False


def _quiet_warning(message, category, filename, lineno, file=None, line=None):
    # A library warning may quote the text it failed on (antalia-mini's normaliser fallback does).
    LOG.warning("%s at %s:%d", category.__name__, os.path.basename(filename), lineno)


def _quiet_exception(kind, value, tb):
    # An exception's message may quote a text: its kind and where it was raised only.
    frame = traceback.extract_tb(tb)[-1] if tb else None
    where = f"{os.path.basename(frame.filename)}:{frame.lineno}" if frame else "?"
    LOG.critical("uncaught %s at %s", kind.__name__, where)


def configure_logging(level_name):
    """Our handler on the root logger, behind OnlyOurs; library warnings and uncaught exceptions
    are logged by kind and place. Returns the handler."""
    level = getattr(logging, level_name.upper(), None)
    if not isinstance(level, int):
        raise SystemExit("SPEAK_LOG must be debug, info, warning or error")
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(levelname)s %(name)s %(message)s"))
    handler.addFilter(OnlyOurs())
    root = logging.getLogger()
    root.addHandler(handler)
    root.setLevel(logging.WARNING)
    LOG.setLevel(level)
    warnings.showwarning = _quiet_warning
    sys.excepthook = _quiet_exception
    threading.excepthook = lambda a: _quiet_exception(a.exc_type, a.exc_value, a.exc_traceback)
    return handler


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


SERVER_OPTIONS = {
    # No compression (audio does not shrink), no keepalive pings (a local socket closes when its
    # peer dies), a megabyte per message so an over-long text is refused, not a dropped connection.
    "compression": None, "ping_interval": None, "max_size": MAX_MESSAGE_BYTES, "logger": WS_LOG,
}


@contextlib.asynccontextmanager
async def open_server(endpoint, handler):
    from websockets.asyncio.server import serve, unix_serve

    if endpoint[0] == "tcp":
        async with serve(handler, endpoint[1], endpoint[2], **SERVER_OPTIONS) as server:
            yield server
        return
    path = endpoint[1]
    remove_stale_socket(path)
    old = os.umask(0o117)
    try:
        server = await unix_serve(handler, path, **SERVER_OPTIONS)
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
    """0 when the service answers a WebSocket handshake with its hello, 1 otherwise (the image's
    HEALTHCHECK)."""
    from websockets.sync.client import connect, unix_connect

    options = {"open_timeout": 5, "compression": None}
    try:
        if endpoint[0] == "tcp":
            host = f"[{endpoint[1]}]" if ":" in endpoint[1] else endpoint[1]
            opening = connect(f"ws://{host}:{endpoint[2]}/", **options)
        else:
            opening = unix_connect(endpoint[1], **options)
        with opening as ws:
            return 0 if json.loads(ws.recv(timeout=5)).get("type") == "hello" else 1
    except Exception:  # noqa: BLE001 - any failure is "unhealthy"
        return 1


def parse_request(message):
    """(kind, id, text, problem): problem is None or the reason of the error to answer."""
    try:
        msg = json.loads(message)
    except (ValueError, RecursionError):
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


async def _next_chunk(loop, pool, gen):
    token = _watchdog.begin() if _watchdog else None
    try:
        return await loop.run_in_executor(pool, next, gen, None)
    finally:
        if token is not None:
            _watchdog.end(token)


async def run_synth(ws, mouth, pool, sid, text, cancel, after=None):
    from websockets.exceptions import ConnectionClosed

    if after is not None:
        with contextlib.suppress(Exception):
            await after
    loop = asyncio.get_running_loop()
    started, first_ms, samples, gen, voice = time.monotonic(), None, 0, None, None
    voices = getattr(mouth, "voice_pool", None)
    try:
        if voices is not None and not cancel.is_set():
            voice = await voices.acquire()
        if not cancel.is_set():
            gen = mouth.chunks(text) if voice is None else mouth.chunks(text, voice)
            while True:
                chunk = await _next_chunk(loop, pool, gen)
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
    except TooLong:
        LOG.warning("refused a request: too_long (normalised)")
        with contextlib.suppress(Exception):
            await ws.send(json.dumps({"type": "error", "id": sid, "reason": "too_long"}))
    except Exception as e:  # noqa: BLE001 - report the kind, never the text
        LOG.error("synthesis failed: %s", type(e).__name__)
        with contextlib.suppress(Exception):
            await ws.send(json.dumps({"type": "error", "id": sid, "reason": "failed"}))
    finally:
        if gen is not None:
            with contextlib.suppress(ValueError):  # still running in a thread only at shutdown
                gen.close()
        if voice is not None:
            voices.release(voice)


async def session(ws, mouth, pool):
    from websockets.exceptions import ConnectionClosed

    current = None  # (id, cancel event, task) of the last synthesis started
    try:
        await ws.send(json.dumps({"type": "hello", "voice_id": mouth.voice_id, "sample_rate": SAMPLE_RATE,
                                  "format": "pcm16le"}))
        async for message in ws:
            if isinstance(message, bytes):
                kind, sid, text, problem = None, None, None, "bad_request"
            else:
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


async def serve_forever(endpoint, mouth, pool, watchdog=None):
    loop = asyncio.get_running_loop()
    stop = loop.create_future()
    for sig in (signal.SIGTERM, signal.SIGINT):
        with contextlib.suppress(NotImplementedError, AttributeError, ValueError):
            loop.add_signal_handler(sig, lambda: stop.done() or stop.set_result(None))

    async def beat():
        while True:
            watchdog.heartbeat()
            await asyncio.sleep(1)

    beating = asyncio.create_task(beat()) if watchdog else None
    if watchdog:
        watchdog.start()
    async with open_server(endpoint, lambda ws: session(ws, mouth, pool)):
        LOG.info("listening")
        await stop
    if beating:
        beating.cancel()
    LOG.info("stopped")


def main(argv=None):
    global _watchdog
    parser = argparse.ArgumentParser(prog="jeeta_speak.py")
    parser.add_argument("--health", action="store_true", help="exit 0 if the service answers")
    parser.add_argument("--self-test", action="store_true", help="load, check the readings, exit")
    parser.add_argument("--voice-id", action="store_true", help="print the voice id and exit")
    args = parser.parse_args(argv)
    try:
        endpoint = parse_endpoint(os.environ.get("SPEAK_SOCKET", DEFAULT_SOCKET))
    except ValueError as e:
        raise SystemExit(f"SPEAK_SOCKET: {e}") from None
    if args.health:
        return health(endpoint)
    knobs = settings()
    if args.voice_id:
        print(voice_id(knobs))
        return 0
    configure_logging(os.environ.get("SPEAK_LOG", "info"))
    started = time.monotonic()
    mouth = build_mouth(knobs)
    loaded_ms = int((time.monotonic() - started) * 1000)
    self_test(mouth)
    LOG.info("loaded in %d ms: %s; seed %d, threads %d, batch %d, voice %s", loaded_ms,
             ", ".join(f"{k} {v}" for k, v in versions().items()), knobs["seed"], knobs["threads"],
             knobs["batch"], mouth.voice_id)
    if args.self_test:
        LOG.info("self-test passed")
        return 0
    for n, tts in enumerate(mouth.voices):
        first, total, audio = measure(mouth, WARM_TEXT, tts)
        LOG.info("warm %d: first audio in %s ms, %d ms for %d ms of audio", n, first, total, audio)
    pool = ThreadPoolExecutor(max_workers=knobs["workers"], thread_name_prefix="speak")
    _watchdog = Watchdog(knobs["watchdog_s"])
    asyncio.run(serve_forever(endpoint, mouth, pool, _watchdog))
    return 0


if __name__ == "__main__":
    sys.exit(main())
