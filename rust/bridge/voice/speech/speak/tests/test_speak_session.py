"""The speak protocol over a real WebSocket, served by the service's own server builder: TCP
loopback here, a unix socket in production (the unix test runs on Linux only)."""
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

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import websockets  # noqa: E402

from jeeta_speak import MAX_TEXT_CHARS, health, open_server, parse_endpoint, session  # noqa: E402

QUIET = logging.getLogger("test-client")
QUIET.setLevel(logging.WARNING)


class FakeMouth:
    """chunks(text) like the real mouth: here `n` chunks of one byte value per text, `delay` apart."""

    def __init__(self, n=2, size=800, delay=0.0, tags=None):
        self.n, self.size, self.delay = n, size, delay
        self.tags = tags or {}
        self.closed = []

    def chunks(self, text):
        tag = self.tags.get(text, 1)
        try:
            for _ in range(self.n):
                if self.delay:
                    time.sleep(self.delay)
                yield bytes([tag, 0]) * self.size
        finally:
            self.closed.append(text)


async def talk(mouth, script, until):
    """Serves `mouth`, runs `script(ws)` (sends), then collects every message until a text message
    whose (type, id) is in `until`; returns them decoded (bytes stay bytes)."""
    pool = ThreadPoolExecutor(max_workers=2)
    try:
        async with open_server(("tcp", "127.0.0.1", 0), lambda ws: session(ws, mouth, pool)) as server:
            port = server.sockets[0].getsockname()[1]
            async with websockets.connect(f"ws://127.0.0.1:{port}", logger=QUIET) as ws:
                got = []
                await script(ws)
                while True:
                    msg = await asyncio.wait_for(ws.recv(), 10)
                    msg = msg if isinstance(msg, bytes) else json.loads(msg)
                    got.append(msg)
                    if isinstance(msg, dict) and (msg["type"], msg.get("id")) in until:
                        return got
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


def sending(*messages):
    async def script(ws):
        for m in messages:
            await ws.send(m if isinstance(m, str) else json.dumps(m))

    return script


def texts(got):
    return [m for m in got if isinstance(m, dict)]


def test_synth_streams_pcm_then_done():
    mouth = FakeMouth(n=2, size=800)
    got = asyncio.run(talk(mouth, sending({"type": "synth", "id": "a:0", "text": "Merhaba."}), {("done", "a:0")}))
    assert got[0] == b"\x01\x00" * 800 and got[1] == b"\x01\x00" * 800
    done = got[2]
    assert done["id"] == "a:0" and done["audio_ms"] == 200
    assert isinstance(done["synth_ms"], int) and isinstance(done["first_ms"], int)


def test_a_second_synth_while_busy_is_refused():
    mouth = FakeMouth(n=3, size=8000, delay=0.05)
    got = asyncio.run(
        talk(
            mouth,
            sending({"type": "synth", "id": "a:0", "text": "Bir."}, {"type": "synth", "id": "a:1", "text": "İki."}),
            {("done", "a:0")},
        )
    )
    assert {"type": "error", "id": "a:1", "reason": "busy"} in texts(got)
    assert len([m for m in got if isinstance(m, bytes)]) == 3


def test_a_cancel_stops_between_chunks_and_nothing_follows_it():
    mouth = FakeMouth(n=100, size=160, delay=0.02)

    async def script(ws):
        await ws.send(json.dumps({"type": "synth", "id": "a:0", "text": "Uzun bir cümle."}))
        assert isinstance(await ws.recv(), bytes)
        await ws.send(json.dumps({"type": "cancel", "id": "a:0"}))

    async def run():
        got = await talk(mouth, script, {("cancelled", "a:0")})
        return got

    got = asyncio.run(run())
    cancelled = got[-1]
    assert cancelled["type"] == "cancelled" and cancelled["id"] == "a:0"
    assert len([m for m in got if isinstance(m, bytes)]) < 50
    assert mouth.closed == ["Uzun bir cümle."]


def test_a_synth_after_a_cancel_waits_for_the_cancelled_one_instead_of_busy():
    mouth = FakeMouth(n=20, size=160, delay=0.03, tags={"Bir.": 1, "İki.": 2})

    async def script(ws):
        await ws.send(json.dumps({"type": "synth", "id": "a:0", "text": "Bir."}))
        assert await ws.recv() == bytes([1, 0]) * 160
        await ws.send(json.dumps({"type": "cancel", "id": "a:0"}))
        await ws.send(json.dumps({"type": "synth", "id": "a:1", "text": "İki."}))

    got = asyncio.run(talk(mouth, script, {("done", "a:1")}))
    kinds = [(m["type"], m["id"]) if isinstance(m, dict) else m[0] for m in got]
    assert ("error", "a:1") not in kinds
    cut = kinds.index(("cancelled", "a:0"))
    assert all(k == 1 for k in kinds[:cut])
    assert kinds[cut + 1:-1] == [2] * 20 and kinds[-1] == ("done", "a:1")


def test_a_cancel_for_another_id_or_after_the_end_is_ignored():
    mouth = FakeMouth(n=2)
    got = asyncio.run(
        talk(
            mouth,
            sending(
                {"type": "cancel", "id": "x:9"},
                {"type": "synth", "id": "a:0", "text": "Bir."},
                {"type": "cancel", "id": "x:9"},
            ),
            {("done", "a:0")},
        )
    )
    assert [m["type"] for m in texts(got)] == ["done"]


def test_bad_requests_are_answered_and_the_connection_stays_usable():
    mouth = FakeMouth(n=1)
    got = asyncio.run(
        talk(
            mouth,
            sending(
                "{not json",
                "[1, 2]",
                {"type": "synth", "text": "Kimliksiz."},
                {"type": "synth", "id": "a:0"},
                {"type": "speak", "id": "a:1"},
                {"type": "synth", "id": "a:2", "text": "x" * (MAX_TEXT_CHARS + 1)},
                {"type": "synth", "id": "a:3", "text": "Sonunda."},
            ),
            {("done", "a:3")},
        )
    )
    assert texts(got)[:6] == [
        {"type": "error", "id": None, "reason": "bad_request"},
        {"type": "error", "id": None, "reason": "bad_request"},
        {"type": "error", "id": None, "reason": "bad_request"},
        {"type": "error", "id": "a:0", "reason": "bad_request"},
        {"type": "error", "id": "a:1", "reason": "bad_request"},
        {"type": "error", "id": "a:2", "reason": "too_long"},
    ]
    assert texts(got)[6]["type"] == "done"


def test_a_failed_synthesis_reports_its_kind_and_the_next_one_runs():
    class Flaky(FakeMouth):
        def chunks(self, text):
            if text == "Kötü.":
                raise RuntimeError("Ayşe Yılmaz 0532 111 22 33")
            return super().chunks(text)

    got = asyncio.run(
        talk(
            Flaky(n=1),
            sending({"type": "synth", "id": "a:0", "text": "Kötü."}),
            {("error", "a:0")},
        )
    )
    assert texts(got) == [{"type": "error", "id": "a:0", "reason": "failed"}]

    async def again(ws):
        await ws.send(json.dumps({"type": "synth", "id": "a:0", "text": "Kötü."}))
        assert json.loads(await ws.recv())["reason"] == "failed"
        await ws.send(json.dumps({"type": "synth", "id": "a:1", "text": "İyi."}))

    got = asyncio.run(talk(Flaky(n=1), again, {("done", "a:1")}))
    assert got[-1]["type"] == "done"


def test_the_log_never_carries_the_text(caplog):
    caplog.set_level(logging.DEBUG)
    logging.getLogger("jeeta-speak").setLevel(logging.DEBUG)
    secret = "Ayşe Yılmaz, 0532 111 22 33, Bağdat Caddesi"

    class Failing(FakeMouth):
        def chunks(self, text):
            if text.startswith("x"):
                raise ValueError(secret)
            return super().chunks(text)

    try:
        asyncio.run(talk(Failing(n=2), sending({"type": "synth", "id": "a:0", "text": secret}), {("done", "a:0")}))
        asyncio.run(talk(Failing(n=1), sending("{" + secret), {("error", None)}))
        asyncio.run(talk(Failing(n=1), sending({"type": "synth", "id": "a:2", "text": "x" + secret}), {("error", "a:2")}))
        asyncio.run(
            talk(
                Failing(n=20, delay=0.02),
                sending({"type": "synth", "id": "a:3", "text": secret}, {"type": "synth", "id": "a:4", "text": secret}),
                {("error", "a:4")},
            )
        )
    finally:
        logging.getLogger("jeeta-speak").setLevel(logging.NOTSET)
    assert "done:" in caplog.text and "chars" in caplog.text and "busy" in caplog.text
    for word in ("Ayşe", "Yılmaz", "0532", "Bağdat"):
        assert word not in caplog.text


def test_endpoints():
    assert parse_endpoint("unix:/run/jeeta-voice/speak.sock") == ("unix", "/run/jeeta-voice/speak.sock")
    assert parse_endpoint("/run/jeeta-voice/speak.sock") == ("unix", "/run/jeeta-voice/speak.sock")
    assert parse_endpoint("tcp:127.0.0.1:9000") == ("tcp", "127.0.0.1", 9000)
    assert parse_endpoint("tcp:[::1]:9000") == ("tcp", "::1", 9000)
    for bad in ("tcp:0.0.0.0:9000", "tcp:10.0.0.5:9000", "tcp:example.com:80", "tcp:127.0.0.1:x",
                "tcp:127.0.0.1:70000", "speak.sock", "unix:speak.sock"):
        with pytest.raises(ValueError):
            parse_endpoint(bad)


def test_the_health_check_answers_only_when_the_service_does():
    async def run():
        pool = ThreadPoolExecutor(max_workers=1)
        async with open_server(("tcp", "127.0.0.1", 0), lambda ws: session(ws, FakeMouth(), pool)) as server:
            port = server.sockets[0].getsockname()[1]
            return await asyncio.to_thread(health, ("tcp", "127.0.0.1", port)), port

    up, port = asyncio.run(run())
    assert up == 0
    assert health(("tcp", "127.0.0.1", port)) == 1


@pytest.mark.skipif(sys.platform == "win32", reason="asyncio serves unix sockets on Linux and macOS only")
def test_the_unix_socket_is_the_groups_and_a_stale_one_is_replaced():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "speak.sock")
        stale = socket.socket(socket.AF_UNIX)
        stale.bind(path)
        stale.close()

        async def run():
            pool = ThreadPoolExecutor(max_workers=1)
            async with open_server(("unix", path), lambda ws: session(ws, FakeMouth(n=1), pool)):
                mode = os.stat(path).st_mode & 0o777
                async with websockets.unix_connect(path, logger=QUIET) as ws:
                    await ws.send(json.dumps({"type": "synth", "id": "a:0", "text": "Bir."}))
                    first = await ws.recv()
                    done = json.loads(await ws.recv())
                healthy = await asyncio.to_thread(health, ("unix", path))
            return mode, first, done, healthy

        mode, first, done, healthy = asyncio.run(run())
        assert mode == 0o660
        assert first == b"\x01\x00" * 800 and done["type"] == "done"
        assert healthy == 0
        assert not os.path.exists(path), "the socket is removed when the service stops"


@pytest.mark.skipif(sys.platform == "win32", reason="asyncio serves unix sockets on Linux and macOS only")
def test_a_regular_file_in_the_sockets_place_is_never_deleted():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "speak.sock")
        pathlib.Path(path).write_text("not a socket", encoding="utf-8")

        async def run():
            async with open_server(("unix", path), lambda ws: None):
                pass

        with pytest.raises(SystemExit):
            asyncio.run(run())
        assert pathlib.Path(path).read_text(encoding="utf-8") == "not a socket"
