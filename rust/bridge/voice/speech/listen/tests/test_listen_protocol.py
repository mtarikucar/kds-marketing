"""The listen protocol over a real WebSocket, served by the service's own server builder: TCP
loopback here, a unix socket in production (the unix tests run on Linux only)."""
import asyncio
import json
import logging
import os
import pathlib
import socket
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import websockets  # noqa: E402
from websockets.exceptions import ConnectionClosed  # noqa: E402

import jeeta_listen  # noqa: E402
from jeeta_listen import MAX_MESSAGE_BYTES, MAX_SESSIONS, Slots, connection, health, open_server, parse_endpoint  # noqa: E402
from test_listen_session import LOUD, QUIET, FakeAsr, FakeTurn, LevelVad, ears, frames  # noqa: E402

QUIET_LOG = logging.getLogger("test-client")
QUIET_LOG.setLevel(logging.WARNING)
HELLO = {"type": "hello", "listen_id": "test-ears", "sample_rate": 8000, "format": "pcm16le"}


class Broken:
    """A session engine that fails on its first audio, then works."""

    def __init__(self, asr):
        self.asr, self.failed = asr, False

    def accept(self, stream, samples):
        if not self.failed:
            self.failed = True
            raise RuntimeError("Ayşe Yılmaz 0532")
        self.asr.accept(stream, samples)

    def __getattr__(self, name):
        return getattr(self.asr, name)


async def serving(the_ears, client, slots=None):
    pool = ThreadPoolExecutor(max_workers=2)
    slots = slots or Slots()
    try:
        async with open_server(("tcp", "127.0.0.1", 0), lambda ws: connection(ws, the_ears, pool, slots)) as server:
            url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
            return await client(url)
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


async def call(ws, messages, until=("final", "unheard"), settle=0.0):
    """Sends `messages` (dicts as JSON, bytes as audio), then reads text messages until one whose
    type is in `until` (and `settle` seconds more); returns them decoded."""
    for m in messages:
        await ws.send(m if isinstance(m, (bytes, str)) else json.dumps(m))
    got = []
    while True:
        msg = json.loads(await asyncio.wait_for(ws.recv(), 10))
        got.append(msg)
        if msg["type"] in until:
            break
    deadline = time.monotonic() + settle
    while time.monotonic() < deadline:
        try:
            got.append(json.loads(await asyncio.wait_for(ws.recv(), deadline - time.monotonic())))
        except asyncio.TimeoutError:
            break
    return got


def one_call(the_ears, messages, until=("final", "unheard"), settle=0.0):
    async def client(url):
        async with websockets.connect(url, logger=QUIET_LOG) as ws:
            assert json.loads(await ws.recv()) == HELLO
            return await call(ws, messages, until, settle)

    return asyncio.run(serving(the_ears, client))


START = {"type": "start", "sample_rate": 8000, "hotwords": ["Jeeta"]}
TURN = frames(QUIET, 400) + frames(LOUD, 600) + frames(QUIET, 400)


def test_hello_then_a_call_from_start_to_final():
    got = one_call(ears(FakeAsr(["evet benim"]), FakeTurn(0.9)), [START, *TURN])
    assert [m["type"] for m in got if m["type"] != "partial"] == ["speech_start", "speech_end", "final"]
    assert got[-1]["text"] == "evet benim" and got[-1]["endpoint_by"] == "smart_turn"


def test_turkish_text_is_sent_as_is():
    async def client(url):
        async with websockets.connect(url, logger=QUIET_LOG) as ws:
            await ws.recv()
            for m in [json.dumps(START), *TURN]:
                await ws.send(m)
            while True:
                raw = await asyncio.wait_for(ws.recv(), 10)
                if json.loads(raw)["type"] == "final":
                    return raw

    raw = asyncio.run(serving(ears(FakeAsr(["perşembe günü"]), FakeTurn(0.9)), client))
    assert "perşembe günü" in raw


def test_the_echo_guard_message_reaches_the_session():
    middling = frames(0.1, 1000)
    got = one_call(ears(FakeAsr(["x"]), FakeTurn(0.9)),
                   [START, {"type": "playback", "active": True}, *middling, {"type": "playback", "active": False},
                    *middling], until=("speech_start",))
    # The guard lifts at 1000 ms; the 32 ms chunk from 992 ms is judged after it.
    assert got[-1]["audio_ms"] >= 992, "nothing was heard while the bridge played"


def test_bad_requests_are_answered_and_the_connection_stays_usable():
    bad = {"type": "error", "reason": "bad_request"}
    got = one_call(
        ears(FakeAsr(["sonunda"]), FakeTurn(0.9)),
        [
            b"\x00\x01",  # audio before start: answered once
            b"\x00\x01",
            "{not json", "[1, 2]", "[" * 60_000,
            {"type": "playback", "active": True},  # before start
            {"type": "start", "sample_rate": 16000},
            {"type": "start", "sample_rate": True},
            {"type": "listen"},
            START,
            START,  # a second start
            {"type": "playback", "active": "yes"},
            b"\x00\x00\x00",  # odd length: dropped, since audio was refused once already
            *TURN,
        ],
    )
    errors = [m for m in got if m["type"] == "error"]
    assert errors == [bad] * 10
    assert got[-1]["type"] == "final" and got[-1]["text"] == "sonunda"


def test_a_start_at_another_rate_starts_nothing():
    for rate in (16000, True, "8000"):
        async def client(url, rate=rate):
            async with websockets.connect(url, logger=QUIET_LOG) as ws:
                await ws.recv()
                await ws.send(json.dumps({"type": "start", "sample_rate": rate}))
                for f in TURN:
                    await ws.send(f)
                got = []
                while True:
                    try:
                        got.append(json.loads(await asyncio.wait_for(ws.recv(), 1.0)))
                    except asyncio.TimeoutError:
                        return got

        got = asyncio.run(serving(ears(FakeAsr(["evet"]), FakeTurn(0.9)), client))
        assert got == [{"type": "error", "reason": "bad_request"}] * 2, (rate, got)  # the start, then the audio


def test_bad_hotwords_never_refuse_the_call():
    for hot in ([7, None, "Studio 54", "x" * 500, "Ayşe"] + ["Jeeta"] * 30, "Jeeta", {"a": 1}, None):
        got = one_call(ears(FakeAsr(["evet"]), FakeTurn(0.9)), [{"type": "start", "hotwords": hot}, *TURN])
        assert got[-1]["type"] == "final", hot


def test_a_failed_start_gives_its_slot_back():
    tries = {"n": 0}

    def flaky_vad():
        tries["n"] += 1
        if tries["n"] <= MAX_SESSIONS + 1:
            raise RuntimeError("no vad")
        return LevelVad()

    the_ears = ears(FakeAsr(["evet"]), FakeTurn(0.9))
    the_ears.vad = flaky_vad

    async def client(url):
        answers = []
        async with websockets.connect(url, logger=QUIET_LOG) as ws:
            await ws.recv()
            for _ in range(MAX_SESSIONS + 1):
                await ws.send(json.dumps(START))
                answers.append(json.loads(await asyncio.wait_for(ws.recv(), 5)))
            got = await call(ws, [START, *TURN])
        return answers, got

    answers, got = asyncio.run(serving(the_ears, client))
    assert answers == [{"type": "error", "reason": "failed"}] * (MAX_SESSIONS + 1)
    assert got[-1]["type"] == "final", "every failed start gave its slot back"


def test_a_call_beyond_the_limit_is_busy_and_closed():
    async def client(url):
        held = []
        for _ in range(MAX_SESSIONS):
            ws = await websockets.connect(url, logger=QUIET_LOG)
            await ws.recv()
            await ws.send(json.dumps(START))
            held.append(ws)
        await asyncio.sleep(0.2)
        async with websockets.connect(url, logger=QUIET_LOG) as ws:
            await ws.recv()
            await ws.send(json.dumps(START))
            answer = json.loads(await asyncio.wait_for(ws.recv(), 5))
            with pytest.raises(ConnectionClosed) as closed:
                await asyncio.wait_for(ws.recv(), 5)
        await held[0].close()
        await asyncio.sleep(0.2)
        async with websockets.connect(url, logger=QUIET_LOG) as ws:
            await ws.recv()
            again = await call(ws, [START, *TURN])
        for ws in held[1:]:
            await ws.close()
        return answer, closed.value.rcvd.code, again

    answer, code, again = asyncio.run(serving(ears(FakeAsr(["evet"] * 5), FakeTurn(0.9)), client))
    assert answer == {"type": "error", "reason": "busy"} and code == 1013
    assert again[-1]["type"] == "final", "a freed slot is taken again"


def test_a_failure_in_the_audio_is_answered_failed_and_the_call_goes_on():
    asr = FakeAsr(["ikinci"])
    got = one_call(ears(Broken(asr), FakeTurn(0.9)), [START, *frames(LOUD, 600), *frames(QUIET, 600), *TURN],
                   until=("final",))
    at = got.index({"type": "error", "reason": "failed"})
    assert got[at + 1]["type"] == "unheard", "the dropped turn is closed toward the bridge"
    assert [m["type"] for m in got[at + 2:] if m["type"] != "partial"] == ["speech_start", "speech_end", "final"]
    assert got[-1]["text"] == "ikinci"


def test_a_message_over_the_size_limit_closes_with_1009_only_that_connection():
    async def client(url):
        async with websockets.connect(url, logger=QUIET_LOG, max_size=None) as ws:
            await ws.recv()
            await ws.send(json.dumps(START))
            await ws.send(b"\x00" * (MAX_MESSAGE_BYTES + 2))
            with pytest.raises(ConnectionClosed) as closed:
                await asyncio.wait_for(ws.recv(), 5)
        async with websockets.connect(url, logger=QUIET_LOG) as ws:
            await ws.recv()
            got = await call(ws, [START, *TURN])
        return closed.value.rcvd.code, got

    code, got = asyncio.run(serving(ears(FakeAsr(["evet", "evet"]), FakeTurn(0.9)), client))
    assert code == 1009 and got[-1]["type"] == "final"


def test_the_server_never_compresses_and_never_pings():
    assert jeeta_listen.SERVER_OPTIONS["compression"] is None
    assert jeeta_listen.SERVER_OPTIONS["ping_interval"] is None

    async def client(url):
        async with websockets.connect(url, logger=QUIET_LOG, compression="deflate") as ws:
            await ws.recv()
            return ws.response.headers.get("Sec-WebSocket-Extensions")

    assert asyncio.run(serving(ears(FakeAsr([]), FakeTurn(0.9)), client)) is None


def test_the_log_never_carries_a_word_a_hotword_or_audio(caplog):
    caplog.set_level(logging.DEBUG)
    logging.getLogger("jeeta-listen").setLevel(logging.DEBUG)
    secret = ["Ayşe Yılmaz", "Bağdat Caddesi"]
    try:
        got = one_call(ears(FakeAsr(["ayşe yılmaz bağdat caddesi"], partial="ayşe yılmaz"), FakeTurn(0.9)),
                       [{"type": "start", "hotwords": secret}, *TURN])
        one_call(ears(Broken(FakeAsr(["ayşe"])), FakeTurn(0.9)),
                 [{"type": "start", "hotwords": secret}, *TURN, *TURN], until=("final",))
    finally:
        logging.getLogger("jeeta-listen").setLevel(logging.NOTSET)
    assert got[-1]["text"] == "ayşe yılmaz bağdat caddesi"
    text = caplog.text.lower()
    assert "a call started: 2 hotwords" in text and "final:" in text and "chars" in text
    assert "audio processing failed: runtimeerror" in text
    for word in ("ayşe", "yılmaz", "bağdat", "caddesi", "0532"):
        assert word not in text, word


def test_endpoints():
    assert parse_endpoint("unix:/run/jeeta-voice/listen.sock") == ("unix", "/run/jeeta-voice/listen.sock")
    assert parse_endpoint("/run/jeeta-voice/listen.sock") == ("unix", "/run/jeeta-voice/listen.sock")
    assert parse_endpoint("tcp:127.0.0.1:9000") == ("tcp", "127.0.0.1", 9000)
    assert parse_endpoint("tcp:[::1]:9000") == ("tcp", "::1", 9000)
    for bad in ("tcp:0.0.0.0:9000", "tcp:10.0.0.5:9000", "tcp:example.com:80", "tcp:127.0.0.1:x",
                "tcp:127.0.0.1:70000", "listen.sock", "unix:listen.sock"):
        with pytest.raises(ValueError):
            parse_endpoint(bad)


def test_the_health_check_answers_only_when_the_service_does():
    async def client(url):
        port = int(url.rsplit(":", 1)[1])
        return await asyncio.to_thread(health, ("tcp", "127.0.0.1", port)), port

    up, port = asyncio.run(serving(ears(FakeAsr([]), FakeTurn(0.9)), client))
    assert up == 0
    assert health(("tcp", "127.0.0.1", port)) == 1


def test_main_health_listen_id_and_a_bad_socket(monkeypatch, capsys):
    async def client(url):
        monkeypatch.setenv("LISTEN_SOCKET", "tcp:127.0.0.1:" + url.rsplit(":", 1)[1])
        return await asyncio.to_thread(jeeta_listen.main, ["--health"])

    assert asyncio.run(serving(ears(FakeAsr([]), FakeTurn(0.9)), client)) == 0
    assert jeeta_listen.main(["--health"]) == 1  # nothing listens there any more
    monkeypatch.setenv("LISTEN_SOCKET", "tcp:0.0.0.0:9")
    with pytest.raises(SystemExit, match="LISTEN_SOCKET"):
        jeeta_listen.main(["--health"])
    monkeypatch.delenv("LISTEN_SOCKET")
    assert jeeta_listen.main(["--listen-id"]) == 0
    printed = capsys.readouterr().out.strip()
    assert len(printed) == 12 and int(printed, 16) >= 0
    monkeypatch.setenv("LISTEN_FALLBACK_MS", "1800")
    assert jeeta_listen.main(["--listen-id"]) == 0
    assert capsys.readouterr().out.strip() != printed, "the fallback is part of the listen id"
    for name, value in [("LISTEN_FALLBACK_MS", "1000"), ("LISTEN_DIGITS_FALLBACK_MS", "3500"),
                        ("LISTEN_THREADS", "x"), ("LISTEN_WATCHDOG_S", "5"), ("LISTEN_GUARD_TAIL_MS", "100")]:
        monkeypatch.setenv(name, value)
        with pytest.raises(SystemExit, match=name):
            jeeta_listen.main(["--listen-id"])
        monkeypatch.delenv(name)


def test_the_watchdog_ends_a_stuck_process():
    clock = [0.0]
    exits = []
    dog = jeeta_listen.Watchdog(30, clock=lambda: clock[0], exit=exits.append)
    token = dog.begin()
    clock[0] = 20.0
    dog.heartbeat()
    assert dog.check() is False
    clock[0] = 31.0
    dog.heartbeat()
    assert dog.check() is True and exits == [70]
    dog.end(token)
    clock[0] = 70.0
    assert dog.check() is True, "a loop with no heartbeat for 30 s is stuck too"


@pytest.mark.skipif(sys.platform == "win32", reason="asyncio serves unix sockets on Linux and macOS only")
def test_the_unix_socket_is_the_groups_and_a_stale_one_is_replaced():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "listen.sock")
        stale = socket.socket(socket.AF_UNIX)
        stale.bind(path)
        stale.close()

        async def run():
            pool = ThreadPoolExecutor(max_workers=1)
            the_ears = ears(FakeAsr(["evet"]), FakeTurn(0.9))
            async with open_server(("unix", path), lambda ws: connection(ws, the_ears, pool, Slots())):
                mode = os.stat(path).st_mode & 0o777
                async with websockets.unix_connect(path, logger=QUIET_LOG) as ws:
                    hello = json.loads(await ws.recv())
                    got = await call(ws, [START, *TURN])
                healthy = await asyncio.to_thread(health, ("unix", path))
            return mode, hello, got, healthy

        mode, hello, got, healthy = asyncio.run(run())
        assert mode == 0o660 and hello == HELLO and got[-1]["type"] == "final" and healthy == 0
        assert not os.path.exists(path), "the socket is removed when the service stops"


@pytest.mark.skipif(sys.platform == "win32", reason="asyncio serves unix sockets on Linux and macOS only")
def test_the_socket_is_born_0660_before_any_chmod(monkeypatch):
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "listen.sock")
        monkeypatch.setattr(os, "chmod", lambda *a, **k: None)

        async def run():
            async with open_server(("unix", path), lambda ws: None):
                return os.stat(path).st_mode & 0o777

        assert asyncio.run(run()) == 0o660


@pytest.mark.skipif(sys.platform == "win32", reason="asyncio serves unix sockets on Linux and macOS only")
def test_a_regular_file_in_the_sockets_place_is_never_deleted():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "listen.sock")
        pathlib.Path(path).write_text("not a socket", encoding="utf-8")

        async def run():
            async with open_server(("unix", path), lambda ws: None):
                pass

        with pytest.raises(SystemExit):
            asyncio.run(run())
        assert pathlib.Path(path).read_text(encoding="utf-8") == "not a socket"


def test_an_unsupported_numpy_frame_is_not_the_clients_concern():
    # The worker sends 20 ms frames; any even length is audio, so a 30 ms frame is fine too.
    pcm = np.full(240, 16000, dtype="<i2").tobytes()
    got = one_call(ears(FakeAsr(["evet"]), FakeTurn(0.9)), [START, *([pcm] * 30), *frames(QUIET, 400)])
    assert got[-1]["type"] == "final"


def test_the_contract_values():
    assert (jeeta_listen.PREROLL_MS, jeeta_listen.HISTORY_MS, jeeta_listen.PARTIAL_EVERY_MS) == (500, 9000, 160)
    assert (jeeta_listen.MAX_SESSIONS, jeeta_listen.MAX_MESSAGE_BYTES) == (4, 65536)
    assert jeeta_listen.SERVER_OPTIONS["max_queue"] == 256
    assert jeeta_listen.DEFAULT_SOCKET == "unix:/run/jeeta-voice/listen/listen.sock"
    assert jeeta_listen.EXIT_SOCKET_HELD == 78
    from endpoint import EndpointConfig

    assert EndpointConfig() == EndpointConfig(
        threshold=0.5, guarded_threshold=0.6, release=0.15, min_speech_ms=200, guarded_min_speech_ms=250,
        guard_tail_ms=400, stop_ms=200, fallback_ms=1500, digits_fallback_ms=2800, max_turn_ms=30000,
        smart_turn_threshold=0.5)
    assert jeeta_listen.endpoint_config(jeeta_listen.settings()) == EndpointConfig()


def test_only_our_records_pass():
    flt = jeeta_listen.OnlyOurs()

    def record(name, level):
        return logging.LogRecord(name, level, __file__, 1, "Ayşe Yılmaz", (), None)

    assert flt.filter(record("jeeta-listen", logging.DEBUG))
    assert flt.filter(record("jeeta-listen.asr", logging.WARNING))
    assert not flt.filter(record("jeeta-listener", logging.INFO)), "a prefix is not a child"
    assert not flt.filter(record("websockets.server", logging.ERROR))
    assert not flt.filter(record("listen.websocket", logging.DEBUG))


def test_a_withheld_record_is_named_not_quoted(caplog):
    caplog.set_level(logging.WARNING)
    jeeta_listen.OnlyOurs().filter(logging.LogRecord("onnx", logging.ERROR, __file__, 1, "Ayşe", (), None))
    assert "withheld a record (ERROR) from onnx" in caplog.text and "Ayşe" not in caplog.text


def test_the_health_check_wants_the_hello():
    async def run(first):
        async def handler(ws):
            await ws.send(json.dumps(first))
            await asyncio.sleep(0.5)

        async with websockets.serve(handler, "127.0.0.1", 0, logger=QUIET_LOG) as server:
            port = server.sockets[0].getsockname()[1]
            return await asyncio.to_thread(health, ("tcp", "127.0.0.1", port))

    assert asyncio.run(run({"type": "hello", "listen_id": "x"})) == 0
    assert asyncio.run(run({"type": "final", "text": "x"})) == 1


def test_a_socket_another_user_holds_ends_the_process_once_with_78(monkeypatch, tmp_path):
    import stat as stat_module

    class Sock:
        st_mode = stat_module.S_IFSOCK | 0o660

    class File:
        st_mode = stat_module.S_IFREG | 0o644

    def refused(path):
        raise PermissionError(1, "Operation not permitted")

    monkeypatch.setattr(os, "lstat", lambda path: Sock())
    monkeypatch.setattr(os, "unlink", refused)
    with pytest.raises(SystemExit) as held:
        jeeta_listen.remove_stale_socket(str(tmp_path / "listen.sock"))
    assert held.value.code == 78
    monkeypatch.setattr(os, "lstat", lambda path: File())
    with pytest.raises(SystemExit) as taken:
        jeeta_listen.remove_stale_socket(str(tmp_path / "listen.sock"))
    assert taken.value.code == 78


def test_an_unraisable_exception_is_logged_by_kind_only(caplog):
    import threading
    import types
    import warnings

    saved = (sys.excepthook, sys.unraisablehook, threading.excepthook, warnings.showwarning)
    handler = jeeta_listen.configure_logging("info")
    try:
        caplog.set_level(logging.INFO)
        sys.unraisablehook(types.SimpleNamespace(exc_type=ValueError, exc_value=ValueError("Ayşe Yılmaz"),
                                                 exc_traceback=None, err_msg="Exception ignored", object=None))
    finally:
        logging.getLogger().removeHandler(handler)
        logging.getLogger("jeeta-listen").setLevel(logging.NOTSET)
        sys.excepthook, sys.unraisablehook, threading.excepthook, warnings.showwarning = saved
    assert "uncaught ValueError" in caplog.text and "Ayşe" not in caplog.text
