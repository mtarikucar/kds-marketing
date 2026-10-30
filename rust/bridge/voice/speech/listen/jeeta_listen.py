"""jeeta-listen: the voice bridge's ears (design addendum section 6, plan V1-T3 B3).

A long-lived process that keeps Silero VAD, Smart Turn v3.2 and seda-v0.1 loaded and speaks one
protocol, one WebSocket per call, on a unix socket (the container runs with --network none) or, for
development, a loopback TCP port. LISTEN_SOCKET is `unix:/path`, `/path` or `tcp:127.0.0.1:<port>`.

  server -> {"type": "hello", "listen_id": "<12 hex>", "sample_rate": 8000, "format": "pcm16le"}
  client -> {"type": "start", "sample_rate": 8000, "hotwords": ["<a word or a name>", ...]}
  client -> binary frames: PCM16 little-endian mono 8000 Hz, any even length (the worker sends 20 ms)
  client -> {"type": "playback", "active": true|false}   the echo guard, while the bridge plays
  server -> {"type": "speech_start", "audio_ms": n}       the caller began (the onset)
          | {"type": "speech_end", "audio_ms": n}         a pause: the end of speech, judged now
          | {"type": "resume", "audio_ms": n}             speech came back in the pause (its onset)
          | {"type": "partial", "text": "..."}            the turn so far, when it changed
          | {"type": "final", "text": "...", "speech_end_ms": n, "endpoint_ms": n,
             "endpoint_by": "smart_turn"|"fallback", "stt_ms": n}
          | {"type": "unheard", "audio_ms": n}            a turn ended without words
          | {"type": "error", "reason": "bad_request"|"busy"|"failed"}

`hello` comes first on every connection; its listen id names everything that decides how audio
becomes words and turns (versions, model digests, the endpoint and decoding rules). One `start` per
connection, first: audio before it, a second `start`, a `playback` without a boolean or any other
message is answered `bad_request` (audio only the first time) and changes nothing. A `start` beyond
MAX_SESSIONS calls at once is answered `busy` and the connection closed (1013). Up to 20 hotwords
are used; one that cannot be (hotwords.clean), or hotwords that are not a list, are dropped and the
call starts all the same, since a refused start would leave the call deaf. A failure while
processing audio is answered `failed`, then `unheard` if a turn was under way (so the bridge does
not wait for its final), and the call goes on.

Positions are audio time since `start`, in milliseconds, at 32 ms steps (Silero's chunks): the worker
maps them to the instants it forwarded those frames. A turn begins after 200 ms of speech (250 ms
while the bridge plays and for 400 ms after), pauses after 200 ms of silence, when Smart Turn judges
it, and ends at its "complete" (p >= 0.5) or after the fallback silence (1.5 s); while digits are
dictated only 2.8 s of silence ends it, since a digit group sounds finished. Its
words are decoded from 500 ms before the onset, in segments cut at its pauses: at each pause the
segment is decoded to its end beside the turn model, so a "complete" is final at once and a fallback
has nothing left to decode. `stt_ms` is how long the turn's last decode took. A turn is cut at 30 s
and reported `endpoint_by: "fallback"`: the bridge reads the field as jt_calls::EndpointBy, which
has no third kind, and a final it cannot parse would be dropped whole.

Nothing that holds a word reaches the log: no transcript, no hotword, no audio. The root handler
passes only this service's records, which carry counts, lengths, timings and kinds.
"""
import argparse
import asyncio
import collections
import contextlib
import dataclasses
import hashlib
import json
import logging
import os
import signal
import stat
import sys
import threading
import time
import traceback
import warnings
from concurrent.futures import ThreadPoolExecutor

import numpy as np

import hotwords
from endpoint import EndpointConfig, Endpointer, dictating

LOG = logging.getLogger("jeeta-listen")
# The connections' logger, outside "jeeta-listen" on purpose: websockets logs every frame at debug
# level and quotes exceptions at error level, so the root filter withholds it.
WS_LOG = logging.getLogger("listen.websocket")
WS_LOG.setLevel(logging.WARNING)

SAMPLE_RATE = 8000
RATE16 = 16000
VAD_CHUNK = 256
PREROLL_MS = 500
PARTIAL_EVERY_MS = 160
# Audio kept for the turn model and the preroll: its 8 s and a second more.
HISTORY_MS = 9000
MAX_SESSIONS = 4
MAX_MESSAGE_BYTES = 1 << 16
# Bump with any change to how audio becomes words and turns that the data below misses.
PIPELINE_VERSION = 1
# In listen's own directory (0710, its user's), so no other service can bind the name while it
# restarts (the B3 review, I4).
DEFAULT_SOCKET = "unix:/run/jeeta-voice/listen/listen.sock"
# The exit status when the socket's path is held by another user: restarting cannot help (the
# unit's RestartPreventExitStatus), so the unit fails once and the alert fires.
EXIT_SOCKET_HELD = 78
DEFAULT_MODELS = "/models"
LOOPBACK = {"127.0.0.1", "::1", "localhost"}


class Done:
    """A finished computation, for ears that judge on the caller's thread."""

    def __init__(self, fn, *args):
        try:
            self.value, self.error = fn(*args), None
        except Exception as e:  # noqa: BLE001 - re-raised by result()
            self.value, self.error = None, e

    def result(self):
        if self.error is not None:
            raise self.error
        return self.value


class Ears:
    """The loaded models, shared by every call: `vad()` makes a call's VAD, `resampler()` its
    8 to 16 kHz resampler; `turn` and `asr` serve every call. `judge` runs the turn model on its own
    thread when the ears have one (`judges`), so a pause's decode does not wait for it."""

    def __init__(self, vad, turn, asr, resampler, cfg=None, listen_id="test-ears", judges=None):
        self.vad = vad
        self.turn = turn
        self.asr = asr
        self.resampler = resampler
        self.cfg = cfg or EndpointConfig()
        self.listen_id = listen_id
        self.judges = judges

    def judge(self, audio16k):
        if self.judges is None:
            return Done(self.turn.complete_probability, audio16k)
        return self.judges.submit(self.turn.complete_probability, audio16k)


def soxr_resampler():
    import soxr

    stream = soxr.ResampleStream(SAMPLE_RATE, RATE16, 1, dtype="float32", quality="HQ")
    return lambda x: stream.resample_chunk(x)


class Session:
    """One call: audio in, events out. `feed` runs on a worker thread, one call at a time.

    A turn's words are decoded in segments cut at its pauses: at each pause the segment is decoded
    to its end while the turn model judges the turn, so neither waits for the other; speech after the
    pause opens the next segment, from at most PREROLL_MS before its onset and never before the audio
    the last segment was given. The final transcript is the turn's segments joined."""

    def __init__(self, ears, words):
        self.ears = ears
        vocab = getattr(ears.asr, "vocab", None)
        self.hotwords, self.kept, self.dropped = hotwords.prepare(words, vocab) if vocab else ("", 0, 0)
        self.endpointer = Endpointer(ears.cfg)
        self.vad = ears.vad()
        self.resample = ears.resampler()
        self.pending8 = np.zeros(0, dtype=np.float32)
        self.history = collections.deque()  # (first 16 kHz sample index, chunk)
        self.total16 = 0
        self.received8 = 0
        self.stream = None
        self.segments = []
        self.turn_open = False  # a speech_start went out and no final or unheard yet
        self.decoded_to_ms = 0  # the end of the audio a closed segment was given
        self.onset_ms = 0
        self.stt_ms = 0
        self.last_partial = ""
        self.since_partial_ms = 0
        self.stats = collections.Counter()

    def playback(self, active):
        self.endpointer.playback(bool(active), self.received8 * 1000 // SAMPLE_RATE)

    def _remember(self, x16):
        self.history.append((self.total16, x16))
        self.total16 += len(x16)
        keep = self.total16 - HISTORY_MS * RATE16 // 1000
        while self.history and self.history[0][0] + len(self.history[0][1]) <= keep:
            self.history.popleft()

    def _since(self, ms):
        """The 16 kHz audio from audio position `ms` on (as much of it as is kept)."""
        start = max(0, ms * RATE16 // 1000)
        parts = [c[max(0, start - first):] for first, c in self.history if first + len(c) > start]
        return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)

    def _words(self):
        """The turn's words so far: the decoded segments and the open one's partial."""
        open_ = self.ears.asr.text(self.stream) if self.stream is not None else ""
        return " ".join(t for t in [*self.segments, open_] if t)

    def _open_segment(self, onset_ms):
        self.stream = self.ears.asr.stream(self.hotwords)
        self.ears.asr.accept(self.stream, self._since(max(onset_ms - PREROLL_MS, self.decoded_to_ms)))
        self.since_partial_ms = 0

    def _close_segment(self):
        started = time.monotonic()
        text = self.ears.asr.finish(self.stream)
        self.stt_ms = int((time.monotonic() - started) * 1000)
        self.stream = None
        self.decoded_to_ms = self.total16 * 1000 // RATE16
        if text:
            self.segments.append(text)

    def feed(self, pcm):
        x8 = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        x16 = np.asarray(self.resample(x8), dtype=np.float32)
        self.received8 += len(x8)
        self.stats["audio_ms"] = self.received8 * 1000 // SAMPLE_RATE
        self._remember(x16)
        if self.stream is not None and len(x16):
            self.ears.asr.accept(self.stream, x16)
        events = []
        self.pending8 = np.concatenate([self.pending8, x8])
        while len(self.pending8) >= VAD_CHUNK:
            chunk, self.pending8 = self.pending8[:VAD_CHUNK], self.pending8[VAD_CHUNK:]
            for kind, at in self.endpointer.feed(self.vad.prob(chunk)):
                events += self._on(kind, at)
        if self.stream is not None:
            self.since_partial_ms += len(x8) * 1000 // SAMPLE_RATE
            if self.since_partial_ms >= PARTIAL_EVERY_MS:
                self.since_partial_ms = 0
                text = self._words()
                if text and text != self.last_partial:
                    self.last_partial = text
                    events.append({"type": "partial", "text": text})
        return events

    def _on(self, kind, at):
        if kind == "speech_start":
            self.turn_open = True
            self.segments = []
            self.onset_ms = at
            self.last_partial = ""
            self._open_segment(at)
            return [{"type": "speech_start", "audio_ms": at}]
        if kind == "resume":
            self._open_segment(at)
            return [{"type": "resume", "audio_ms": at}]
        if kind == "pause":
            started = time.monotonic()
            verdict = self.ears.judge(self._since(self.onset_ms - PREROLL_MS))
            self._close_segment()
            try:
                p = verdict.result()
            except Exception as e:  # noqa: BLE001 - the fallback silence decides instead
                LOG.error("the turn model failed: %s", type(e).__name__)
                p = 0.0
            LOG.debug("pause: p %.2f, decoded and judged in %d ms", p, int((time.monotonic() - started) * 1000))
            self.endpointer.dictating = dictating(self._words())
            events = [{"type": "speech_end", "audio_ms": at}]
            for k, a in self.endpointer.verdict(p >= self.ears.cfg.smart_turn_threshold):
                events += self._on(k, a)
            return events
        if kind == "finalize":
            if self.stream is not None:  # a turn cut at its longest, mid-speech
                self._close_segment()
            text = " ".join(self.segments)
            self.segments = []
            self.turn_open = False
            self.stats["turns"] += 1
            if not text:
                self.stats["unheard"] += 1
                return [{"type": "unheard", "audio_ms": at["endpoint_ms"]}]
            self.stats[at["by"]] += 1
            LOG.debug("final: %d chars, by %s, %d ms after the end of speech, stt %d ms", len(text), at["by"],
                      at["endpoint_ms"] - at["speech_end_ms"], self.stt_ms)
            return [{"type": "final", "text": text, "speech_end_ms": at["speech_end_ms"],
                     "endpoint_ms": at["endpoint_ms"], "endpoint_by": at["by"], "stt_ms": self.stt_ms}]
        return []

    def drop_turn(self):
        """After a failure: the turn under way is forgotten and positions keep counting. Returns the
        `unheard` that closes it toward the bridge when one was open (or about to be), so the bridge
        does not wait for a final that will never come."""
        open_ = self.turn_open or self.endpointer.state != "idle"
        self.stream = None
        self.segments = []
        self.turn_open = False
        self.endpointer.state = "idle"
        self.endpointer.run_ms = 0
        self.endpointer.dictating = False
        self.vad = self.ears.vad()
        if not open_:
            return []
        self.stats["turns"] += 1
        self.stats["unheard"] += 1
        return [{"type": "unheard", "audio_ms": self.endpointer.audio_ms}]


# --- the service ---------------------------------------------------------------------------------


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
    """The environment's knobs (the unit sets each explicitly). The fallbacks keep to the ranges
    the self-hosted report gives (1.2-1.8 s; 2.5-3 s while digits are dictated); the echo guard's
    tail covers the line's echo of the last sound (100-300 ms) with room."""
    return {
        "threads": env_int("LISTEN_THREADS", 2, 1, 8),
        "watchdog_s": env_int("LISTEN_WATCHDOG_S", 30, 10, 600),
        "fallback_ms": env_int("LISTEN_FALLBACK_MS", 1500, 1200, 1800),
        "digits_fallback_ms": env_int("LISTEN_DIGITS_FALLBACK_MS", 2800, 2500, 3000),
        "guard_tail_ms": env_int("LISTEN_GUARD_TAIL_MS", 400, 200, 800),
    }


def endpoint_config(knobs):
    return EndpointConfig(fallback_ms=knobs["fallback_ms"], digits_fallback_ms=knobs["digits_fallback_ms"],
                          guard_tail_ms=knobs["guard_tail_ms"])


def versions():
    from importlib.metadata import PackageNotFoundError, version

    out = {}
    for name in ("sherpa-onnx", "sherpa-onnx-core", "onnxruntime", "soxr", "numpy"):
        try:
            out[name] = version(name)
        except PackageNotFoundError:
            out[name] = "?"
    return out


def pipeline():
    return {"version": PIPELINE_VERSION, "preroll_ms": PREROLL_MS, "partial_every_ms": PARTIAL_EVERY_MS,
            "history_ms": HISTORY_MS, "vocab_scores": "zipf-1000"}


def listen_fingerprint(versions, models, cfg, decoding):
    parts = {"versions": versions, "models": models, "endpoint": dataclasses.asdict(cfg), "decoding": decoding,
             "pipeline": pipeline()}
    return hashlib.sha256(json.dumps(parts, sort_keys=True).encode()).hexdigest()[:12]


def listen_id(knobs=None):
    """The listen id from the installed versions, models.lock and the knobs, without loading a model
    (the models are checked against the same lock before they are loaded)."""
    import asr
    import listen_pins

    lock = listen_pins.load_lock()
    models = {name: entry["sha256"] for name, entry in lock["files"].items()}
    return listen_fingerprint(versions(), models, endpoint_config(knobs or settings()), asr.settings())


def build_ears(knobs=None, models_dir=None):
    """The real ears: the pinned models checked, then loaded on the CPU."""
    import asr
    import listen_pins
    import turn
    import vad

    knobs = knobs or settings()
    models_dir = models_dir or os.environ.get("LISTEN_MODELS", DEFAULT_MODELS)
    try:
        digests = listen_pins.verify(listen_pins.load_lock(), models_dir)
    except (listen_pins.PinError, OSError, ValueError) as e:
        raise SystemExit(f"models check failed: {e}") from None
    session = vad.load(os.path.join(models_dir, "silero-vad", "silero_vad.onnx"))
    smart = turn.SmartTurn(os.path.join(models_dir, "smart-turn", "smart-turn-v3.2-cpu.onnx"))
    seda = asr.Seda(os.path.join(models_dir, "seda-v0.1"))
    cfg = endpoint_config(knobs)
    lid = listen_fingerprint(versions(), digests, cfg, asr.settings())
    judges = ThreadPoolExecutor(max_workers=1, thread_name_prefix="listen-turn")
    return Ears(lambda: vad.SileroVad(session), smart, seda, soxr_resampler, cfg, lid, judges)


def self_test(ears):
    """The models answer as they should before any call is taken: silence is neither speech nor a
    turn, the turn model gives a probability, hotwords encode and a biased stream opens."""
    probe = ears.vad()
    if max(probe.prob(np.zeros(VAD_CHUNK, dtype=np.float32)) for _ in range(20)) >= ears.cfg.threshold:
        raise SystemExit("self-test: the VAD hears speech in silence")
    ears.turn.complete_probability(np.zeros(RATE16, dtype=np.float32))
    vocab = ears.asr.vocab
    words, kept, _ = hotwords.prepare(["Jeeta", "Ayşe Yılmaz", "İstanbul"], vocab)
    if kept != 3 or vocab.pieces("merhaba") is None:
        raise SystemExit("self-test: hotwords do not encode")
    s = Session(ears, ["Jeeta", "Ayşe Yılmaz"])
    if any(s.feed(np.zeros(160, dtype="<i2").tobytes()) for _ in range(100)):
        raise SystemExit("self-test: silence made an event")
    stream = ears.asr.stream(words)
    if not ears.asr.hotwords_ok:
        raise SystemExit("self-test: the recognizer refused hotwords")
    ears.asr.accept(stream, np.zeros(RATE16, dtype=np.float32))
    if ears.asr.finish(stream):
        raise SystemExit("self-test: silence was transcribed")


def warm(ears):
    """One decode and one turn judgement, so the first call does not pay for the first run."""
    t = np.arange(int(1.5 * RATE16)) / RATE16
    x = (0.1 * np.sin(2 * np.pi * 180 * t) * (1 + np.sin(2 * np.pi * 3 * t))).astype(np.float32)
    started = time.monotonic()
    stream = ears.asr.stream("")
    ears.asr.accept(stream, x)
    ears.asr.finish(stream)
    decoded = int((time.monotonic() - started) * 1000)
    started = time.monotonic()
    ears.turn.complete_probability(x)
    return decoded, int((time.monotonic() - started) * 1000)


class Watchdog:
    """Ends the process when audio processing, or the event loop itself, is stuck past `limit_s`,
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
            LOG.critical("stuck for over %d s (%d audio waits, loop %s): exiting", self.limit_s, stuck,
                         "stalled" if now - self.beat > self.limit_s else "running")
            self.exit(70)
            return True
        return False

    def start(self, period_s=1.0):
        def run():
            while not self.check():
                time.sleep(period_s)

        threading.Thread(target=run, name="listen-watchdog", daemon=True).start()


_watchdog = None


class OnlyOurs(logging.Filter):
    """Passes this service's records only. A library's record may quote a text: it is withheld,
    and one of ours says which logger and level it came from."""

    def filter(self, record):
        if record.name == LOG.name or record.name.startswith(LOG.name + "."):
            return True
        if record.levelno >= logging.WARNING:
            LOG.warning("withheld a record (%s) from %s", record.levelname, record.name)
        return False


def _quiet_warning(message, category, filename, lineno, file=None, line=None):
    LOG.warning("%s at %s:%d", category.__name__, os.path.basename(filename), lineno)


def _quiet_exception(kind, value, tb):
    frame = traceback.extract_tb(tb)[-1] if tb else None
    where = f"{os.path.basename(frame.filename)}:{frame.lineno}" if frame else "?"
    LOG.critical("uncaught %s at %s", kind.__name__, where)


def configure_logging(level_name):
    """Our handler on the root logger, behind OnlyOurs; library warnings and uncaught exceptions
    are logged by kind and place. Returns the handler."""
    level = getattr(logging, level_name.upper(), None)
    if not isinstance(level, int):
        raise SystemExit("LISTEN_LOG must be debug, info, warning or error")
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
    # An exception Python cannot raise (in a finaliser, say) is printed with its message otherwise.
    sys.unraisablehook = lambda u: _quiet_exception(u.exc_type, u.exc_value, u.exc_traceback)
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
    """Removes our previous socket. Something else in its place, or a socket another user holds
    (which this user may not remove), ends the process once with EXIT_SOCKET_HELD."""
    try:
        mode = os.lstat(path).st_mode
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(mode):
        LOG.critical("the socket's path is taken by something that is not a socket: exiting")
        raise SystemExit(EXIT_SOCKET_HELD)
    try:
        os.unlink(path)
    except PermissionError:
        LOG.critical("the socket's path is held by another user: exiting")
        raise SystemExit(EXIT_SOCKET_HELD) from None


SERVER_OPTIONS = {
    # No compression (audio does not shrink), no keepalive pings (a local socket closes when its
    # peer dies), 64 KiB per message (2 s of audio), and room for 5 s of 20 ms frames queued while
    # a turn is judged and decoded.
    "compression": None, "ping_interval": None, "max_size": MAX_MESSAGE_BYTES, "max_queue": 256,
    "logger": WS_LOG,
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
    """(kind, message, problem): problem is None or the reason of the error to answer."""
    try:
        msg = json.loads(message)
    except (ValueError, RecursionError):
        return None, None, "bad_request"
    if not isinstance(msg, dict):
        return None, None, "bad_request"
    kind = msg.get("type")
    if kind == "start":
        if msg.get("sample_rate", SAMPLE_RATE) != SAMPLE_RATE or isinstance(msg.get("sample_rate"), bool):
            return kind, None, "bad_request"
        return kind, msg, None
    if kind == "playback":
        if not isinstance(msg.get("active"), bool):
            return kind, None, "bad_request"
        return kind, msg, None
    return kind, None, "bad_request"


class Slots:
    """How many calls are started at once."""

    def __init__(self, limit=MAX_SESSIONS):
        self.limit, self.used = limit, 0

    def take(self):
        if self.used >= self.limit:
            return False
        self.used += 1
        return True

    def give(self):
        self.used -= 1


async def _feed(loop, pool, session, pcm):
    token = _watchdog.begin() if _watchdog else None
    try:
        return await loop.run_in_executor(pool, session.feed, pcm)
    finally:
        if token is not None:
            _watchdog.end(token)


async def connection(ws, ears, pool, slots):
    from websockets.exceptions import ConnectionClosed

    loop = asyncio.get_running_loop()
    session, refused_audio, began = None, False, time.monotonic()

    async def answer(reason):
        LOG.warning("refused a request: %s", reason)
        await ws.send(json.dumps({"type": "error", "reason": reason}))

    try:
        await ws.send(json.dumps({"type": "hello", "listen_id": ears.listen_id, "sample_rate": SAMPLE_RATE,
                                  "format": "pcm16le"}))
        async for message in ws:
            if isinstance(message, bytes):
                if session is None or len(message) % 2:
                    if not refused_audio:
                        refused_audio = True
                        await answer("bad_request")
                    continue
                try:
                    events = await _feed(loop, pool, session, message)
                except Exception as e:  # noqa: BLE001 - report the kind, never the audio or words
                    LOG.error("audio processing failed: %s", type(e).__name__)
                    closing = session.drop_turn()
                    await ws.send(json.dumps({"type": "error", "reason": "failed"}))
                    for event in closing:
                        await ws.send(json.dumps(event))
                    continue
                for event in events:
                    await ws.send(json.dumps(event, ensure_ascii=False))
                continue
            kind, msg, problem = parse_request(message)
            if problem is None and kind == "start" and session is not None:
                problem = "bad_request"
            if problem is None and kind == "playback" and session is None:
                problem = "bad_request"
            if problem is not None:
                await answer(problem)
                continue
            if kind == "playback":
                session.playback(msg["active"])
                continue
            if not slots.take():
                await answer("busy")
                await ws.close(1013, "busy")
                return
            try:
                session = await loop.run_in_executor(pool, Session, ears, msg.get("hotwords", []))
            except Exception as e:  # noqa: BLE001
                slots.give()
                LOG.error("a call could not start: %s", type(e).__name__)
                await ws.send(json.dumps({"type": "error", "reason": "failed"}))
                continue
            began = time.monotonic()
            LOG.info("a call started: %d hotwords (%d dropped)", session.kept, session.dropped)
    except ConnectionClosed:
        pass
    finally:
        if session is not None:
            slots.give()
            s = session.stats
            LOG.info("a call ended after %d s: %d s of audio, %d turns (%d by smart turn, %d by fallback, %d unheard)",
                     int(time.monotonic() - began), s["audio_ms"] // 1000, s["turns"], s["smart_turn"],
                     s["fallback"], s["unheard"])


async def serve_forever(endpoint, ears, pool, watchdog=None):
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
    slots = Slots()
    async with open_server(endpoint, lambda ws: connection(ws, ears, pool, slots)):
        LOG.info("listening")
        await stop
    if beating:
        beating.cancel()
    LOG.info("stopped")


def main(argv=None):
    global _watchdog
    parser = argparse.ArgumentParser(prog="jeeta_listen.py")
    parser.add_argument("--health", action="store_true", help="exit 0 if the service answers")
    parser.add_argument("--self-test", action="store_true", help="load, check the models, exit")
    parser.add_argument("--listen-id", action="store_true", help="print the listen id and exit")
    args = parser.parse_args(argv)
    try:
        endpoint = parse_endpoint(os.environ.get("LISTEN_SOCKET", DEFAULT_SOCKET))
    except ValueError as e:
        raise SystemExit(f"LISTEN_SOCKET: {e}") from None
    if args.health:
        return health(endpoint)
    knobs = settings()
    if args.listen_id:
        print(listen_id(knobs))
        return 0
    configure_logging(os.environ.get("LISTEN_LOG", "info"))
    import onnxruntime

    onnxruntime.set_default_logger_severity(3)
    started = time.monotonic()
    ears = build_ears(knobs)
    loaded_ms = int((time.monotonic() - started) * 1000)
    self_test(ears)
    LOG.info("loaded in %d ms: %s; fallback %d ms, digits %d ms, listen %s", loaded_ms,
             ", ".join(f"{k} {v}" for k, v in versions().items()), knobs["fallback_ms"],
             knobs["digits_fallback_ms"], ears.listen_id)
    if args.self_test:
        LOG.info("self-test passed")
        return 0
    decoded, judged = warm(ears)
    LOG.info("warm: 1500 ms decoded in %d ms, a turn judged in %d ms", decoded, judged)
    pool = ThreadPoolExecutor(max_workers=knobs["threads"], thread_name_prefix="listen")
    _watchdog = Watchdog(knobs["watchdog_s"])
    asyncio.run(serve_forever(endpoint, ears, pool, _watchdog))
    return 0


if __name__ == "__main__":
    sys.exit(main())
