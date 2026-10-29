"""With the real models, inside the image on the host (B3 Step 8), with the unit's isolation:

  docker run --rm --pull never --network none --read-only --cap-drop ALL \\
    --security-opt no-new-privileges --user 1501:1501 --cpus 1.5 --memory 1g --memory-swap 1g \\
    --pids-limit 64 --ulimit core=0 --tmpfs /tmp:uid=1501,gid=1501,mode=0700,size=16m,noexec,nosuid,nodev \\
    jeeta-voice-listen:<tag> python -m pytest -p no:cacheprovider -s -rs tests

The audio is the fixtures (listen_audio: the speak voice through G.711 A-law). Skipped where the
models are not in LISTEN_MODELS (the dev machine without them, CI). TIMING lines are for the record:
`turn_end_ms` is the processing of the 20 ms frame that ended a turn (the turn model and the last
decode, side by side), on top of the 200-232 ms of silence that the pause takes."""
import asyncio
import copy
import dataclasses
import json
import logging
import os
import pathlib
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import listen_audio  # noqa: E402
from test_listen_hotwords import port_of_ssentencepiece  # noqa: E402

pytestmark = pytest.mark.models
# The names the boost recovers in the names fixture (seda splits them without it: "kara osmanoğlu",
# "kılıç arslan"); "Talas" it did not (heard "falan" with or without, 2026-10-29; at score 2.5 the
# boost also turned "şubemize" into "çöbemize", so the score stays 1.5).
RECOVERED = {"Selin Karaosmanoğlu": "karaosmanoğlu", "Zeynep Kılıçarslan": "kılıçarslan"}
HOTWORDS = [*RECOVERED, "Talas"]


@pytest.fixture(scope="module")
def ears():
    for module in ("sherpa_onnx", "onnxruntime", "soxr"):
        pytest.importorskip(module)
    models = pathlib.Path(os.environ.get("LISTEN_MODELS", "/models"))
    if not (models / "seda-v0.1" / "tokens.txt").is_file():
        pytest.skip("the listen models are not in LISTEN_MODELS")
    from jeeta_listen import build_ears

    return build_ears()


def with_cfg(ears, **changes):
    e = copy.copy(ears)
    e.cfg = dataclasses.replace(ears.cfg, **changes)
    return e


def call(ears, pcm, words=(), tail_ms=3500):
    """Feeds `pcm` (and `tail_ms` of line silence) in 20 ms frames; returns the events and how long
    the frame that produced each took, and the processing time over the audio time."""
    from jeeta_listen import Session

    s = Session(ears, list(words))
    pcm = pcm + listen_audio.alaw_decode(listen_audio.alaw_encode(np.zeros(tail_ms * 8, dtype=np.int16)))
    events, cpu = [], 0.0
    for i in range(0, len(pcm), 320):
        started = time.monotonic()
        got = s.feed(pcm[i:i + 320])
        took = time.monotonic() - started
        cpu += took
        events += [dict(e, took_ms=int(took * 1000)) for e in got]
    return events, cpu / (len(pcm) / 16000)


def finals(events):
    return [e for e in events if e["type"] in ("final", "unheard")]


def words_wrong(text, reference):
    a, b = reference.split(), text.split()
    d = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(b) + 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] != b[j - 1]))
    return d[len(b)]


def test_the_models_load_and_line_hiss_is_not_speech(ears):
    from jeeta_listen import self_test

    self_test(ears)
    hiss = np.random.default_rng(3).normal(0, 18, 8000 * 4)
    pcm = listen_audio.alaw_decode(listen_audio.alaw_encode(np.rint(hiss).astype(np.int16)))
    events, _ = call(ears, pcm, tail_ms=0)
    assert events == []


def test_a_turkish_sentence_end_to_end(ears):
    events, rtf = call(ears, listen_audio.fixture("yarin"))
    (final,) = finals(events)
    assert final["type"] == "final" and final["endpoint_by"] == "smart_turn"
    assert words_wrong(final["text"], "evet yarın saat on dörtte geliyorum") <= 1, final["text"]
    assert final["endpoint_ms"] - final["speech_end_ms"] <= 300
    assert [e["type"] for e in events if e["type"] != "partial"] == ["speech_start", "speech_end", "final"]
    print(f"\nTIMING yarin turn_end_ms={final['took_ms']} stt_ms={final['stt_ms']} "
          f"endpoint_after_speech_ms={final['endpoint_ms'] - final['speech_end_ms']} rtf={rtf:.3f}")


def test_a_pause_between_two_sentences_ends_the_first_turn(ears):
    events, rtf = call(ears, listen_audio.fixture("pause"))
    first, second = finals(events)
    assert "merhaba" in first["text"] and "ayşe" in first["text"], first["text"]
    assert "perşembe" in second["text"], second["text"]
    for f in (first, second):
        assert f["endpoint_by"] == "smart_turn" and f["endpoint_ms"] - f["speech_end_ms"] <= 300
    print(f"\nTIMING pause turn_end_ms={first['took_ms']},{second['took_ms']} rtf={rtf:.3f}")


def test_the_fallback_ends_a_turn_the_model_calls_incomplete(ears):
    events, _ = call(with_cfg(ears, smart_turn_threshold=1.01), listen_audio.fixture("yarin"))
    (final,) = finals(events)
    assert final["endpoint_by"] == "fallback" and "yarın" in final["text"]
    assert 1500 <= final["endpoint_ms"] - final["speech_end_ms"] <= 1540
    print(f"\nTIMING fallback turn_end_ms={final['took_ms']} stt_ms={final['stt_ms']}")


def test_digits_keep_a_turn_open_across_a_pause_the_fallback_would_end(ears):
    events, _ = call(with_cfg(ears, smart_turn_threshold=1.01), listen_audio.fixture("digits"), tail_ms=4000)
    (final,) = finals(events)
    assert "otuz iki" in final["text"] and "sıfır sekiz" in final["text"], final["text"]
    assert 2800 <= final["endpoint_ms"] - final["speech_end_ms"] <= 2840, "it ends on a number too"


def test_hotwords_recover_names_and_leave_other_sentences_alone(ears):
    def heard(name, words=()):
        return " | ".join(f["text"] for f in finals(call(ears, listen_audio.fixture(name), words)[0]))

    plain, biased = heard("names"), heard("names", HOTWORDS)
    assert ears.asr.hotwords_ok
    for word in RECOVERED.values():
        assert word in biased.split() and word not in plain.split(), word
    print(f"\nHOTWORDS recovered {len(RECOVERED)}/{len(HOTWORDS)}; talas heard: {'talas' in biased.split()}")
    for name in ("yarin", "pause"):
        assert heard(name, HOTWORDS) == heard(name), name


def test_the_cut_sherpa_onnx_makes_is_ours_over_the_models_vocabulary(ears):
    import hotwords

    pieces = hotwords.load_pieces(os.path.join(os.environ.get("LISTEN_MODELS", "/models"), "seda-v0.1", "tokens.txt"))
    words = ["jeeta", "figurunica", "karaosmanoğlu", "kılıçarslan", "talas", "ayşe", "yılmaz", "istanbul",
             "ahmet", "mehmet", "zeynep", "atölye", "pera", "esenyurt", "gümüşdere", "hümeyra", "çağlayangil",
             "öğretmen", "şemsettin", "ığdır", "wxq"]
    for word in words:
        assert ears.asr.vocab.pieces(word) == port_of_ssentencepiece(word, pieces), word


def test_most_words_the_model_writes_are_cut_as_we_cut_hotwords(ears):
    asr = ears.asr
    agree = total = 0
    for name in ("yarin", "pause", "digits", "names"):
        x8 = np.frombuffer(listen_audio.fixture(name), dtype="<i2").astype(np.float32) / 32768.0
        import soxr

        stream = asr.stream("")
        asr.accept(stream, soxr.resample(x8, 8000, 16000, quality="HQ").astype(np.float32))
        asr.finish(stream)
        tokens = [("▁" + t[1:]) if t.startswith(" ") else t for t in asr.rec.get_result_all(stream).tokens]
        word = []
        for t in tokens + ["▁"]:
            if t.startswith("▁") and word:
                total += 1
                agree += asr.vocab.pieces("".join(word)[1:]) == word
                word = []
            word.append(t)
    print(f"\nHOTWORDS cut agreement {agree}/{total}")
    assert total >= 30 and agree / total >= 0.85


def test_a_spoken_name_and_its_hotword_reach_no_log(ears, caplog, capfd):
    # The canary: names as hotwords and in the speech, through the real stack and the protocol over
    # a WebSocket, with the service's own logging at debug level; native stderr is captured too.
    import websockets

    import jeeta_listen

    caplog.set_level(logging.DEBUG)
    handler = jeeta_listen.configure_logging("debug")
    quiet = logging.getLogger("canary-client")
    quiet.setLevel(logging.WARNING)
    pcm = listen_audio.fixture("names") + b"\x00\x00" * 8000 * 3

    async def run():
        pool = ThreadPoolExecutor(max_workers=2)
        slots = jeeta_listen.Slots()
        async with jeeta_listen.open_server(("tcp", "127.0.0.1", 0),
                                            lambda ws: jeeta_listen.connection(ws, ears, pool, slots)) as server:
            port = server.sockets[0].getsockname()[1]
            async with websockets.connect(f"ws://127.0.0.1:{port}", logger=quiet) as ws:
                await ws.recv()
                await ws.send(json.dumps({"type": "start", "hotwords": [*HOTWORDS, "Studio 54", ":9"]}))
                for i in range(0, len(pcm), 320):
                    await ws.send(pcm[i:i + 320])
                texts = []
                while len(texts) < 3:
                    m = json.loads(await asyncio.wait_for(ws.recv(), 20))
                    if m["type"] == "final":
                        texts.append(m["text"])
                return texts

    try:
        texts = asyncio.run(run())
    finally:
        logging.getLogger().removeHandler(handler)
        logging.getLogger("jeeta-listen").setLevel(logging.NOTSET)
    out, err = capfd.readouterr()
    logged = (caplog.text + out + err).lower()
    assert "final:" in logged and "a call started: 3 hotwords (2 dropped)" in logged
    for piece in ["selin", "zeynep", "karaosmanoğlu", "kılıçarslan", "talas", "studio", "randevum", "şubemize"]:
        assert piece not in logged, piece
    assert any("kılıçarslan" in t for t in texts)
