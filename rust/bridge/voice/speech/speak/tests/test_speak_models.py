"""With the real models, inside the image on the host (B2 Step 5), with the unit's isolation:

  docker run --rm --pull never --network none --read-only --cap-drop ALL \\
    --security-opt no-new-privileges --user 1502:1501 --cpus 2 --memory 2g --memory-swap 2g \\
    --pids-limit 128 --tmpfs /tmp:uid=1502,gid=1501,mode=0700,size=16m,noexec,nosuid,nodev \\
    jeeta-voice-speak:<tag> python -m pytest -p no:cacheprovider -s -rs tests

Skipped where EMA Lightning or its weights are not installed (the dev machine, CI)."""
import asyncio
import json
import logging
import pathlib
import sys
from concurrent.futures import ThreadPoolExecutor

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

pytestmark = pytest.mark.models


@pytest.fixture(scope="module")
def mouth():
    pytest.importorskip("ema_lightning")
    pytest.importorskip("antalia_mini")
    import pins

    if any(pins.locate(name) is None for name in pins.FILES):
        pytest.skip("EMA Lightning's weights are not in the model cache")
    from jeeta_speak import build_mouth

    return build_mouth()


def test_the_mouth_speaks_and_reads_times_the_way_the_owner_heard(mouth):
    from jeeta_speak import measure, self_test

    self_test(mouth)
    pcm = b"".join(mouth.chunks("Merhaba, ben Jeeta'nın dijital asistanıyım."))
    assert len(pcm) // 2 > 8000  # more than a second of 8 kHz audio
    for text in ["Merhaba.", "Bir saniye, hemen bakıyorum.", "Salı saat 14:00'e randevunuz var.",
                 "Görüşmemiz hizmet kalitesi için yazıya dökülmektedir."]:
        first, total, audio = measure(mouth, text)
        print(f"\nTIMING chars={len(text)} first_ms={first} synth_ms={total} audio_ms={audio}")
        assert audio > 0 and first is not None


def test_the_voice_id_without_the_model_is_the_loaded_ones(mouth):
    from jeeta_speak import voice_id

    assert voice_id() == mouth.voice_id


def test_each_brand_reaches_the_model_as_respelled(mouth):
    from jeeta_speak import tr_lower

    for written, said in mouth.respeller.table.items():
        reading = mouth.model_text(f"Bize {written} üzerinden ulaşabilirsiniz.")
        assert f" {tr_lower(said)} " in f" {reading} ", (written, reading)


def test_numbers_survive_the_sentence_cut(mouth):
    sentences = mouth.sentences("Toplam 1.250,50 TL. Randevunuz 3 Kasım saat 09:30'da.")
    assert sentences == [
        "toplam bin iki yüz elli lira elli kuruş.",
        "randevunuz üç kasım saat dokuz otuzda.",
    ]


ABBREVIATED = {
    "dr": "Yarın Dr. Ahmet Yılmaz sizi arayacak.", "sn": "Sn. Ahmet Yılmaz sizi arıyoruz.",
    "av": "Av. Ayşe Demir dosyayı inceledi.", "prof": "Prof. Ayşe Demir ders verecek.",
    "doç": "Doç. Ali Kaya katılacak.", "yrd": "Yrd. Doç. Ali Kaya katılacak.", "no": "Daire No. 5 sizin mi?",
    "tel": "Tel. sıfır beş yüz otuz iki arayın.", "vb": "Kalem, defter vb. ürünler var.",
    "vs": "Kalem, defter vs. ürünler var.", "ltd": "Figurunica Ltd. Şti. sizi arıyor.",
    "şti": "Atölye Şti. adına arıyorum.", "cad": "Bağdat Cad. üzerindeyiz.", "sok": "Lale Sok. içinde bulunuyor.",
    "mah": "Moda Mah. içinde bulunuyor.", "apt": "Gül Apt. önünde bekliyoruz.",
    "bul": "Atatürk Bul. üzerindeyiz.", "st": "Çarşı St. yanında bekliyoruz.",
}


def test_no_sentence_is_cut_after_one_of_the_workers_abbreviations(mouth):
    from jeeta_speak import ABBREVIATIONS

    assert set(ABBREVIATED) == ABBREVIATIONS
    for word, text in ABBREVIATED.items():
        for written in (text, text.replace(f"{word.capitalize()}.", f"{word}.")):
            assert len(mouth.sentences(written)) == 1, (word, mouth.sentences(written))


def test_the_same_sentence_sounds_the_same_each_time(mouth):
    # The worker caches a sentence's audio by its text: one text, one rendering.
    text = "Anladım."
    assert b"".join(mouth.chunks(text)) == b"".join(mouth.chunks(text))


async def serve_and(mouth, clients):
    """Serves the real mouth as the service does and runs `clients(url)`."""
    import jeeta_speak

    pool = ThreadPoolExecutor(max_workers=len(mouth.voices))
    async with jeeta_speak.open_server(("tcp", "127.0.0.1", 0), lambda ws: jeeta_speak.session(ws, mouth, pool)) as s:
        return await clients(f"ws://127.0.0.1:{s.sockets[0].getsockname()[1]}")


async def synthesise(ws, sid, text):
    await ws.send(json.dumps({"type": "synth", "id": sid, "text": text}))
    pcm = b""
    while True:
        m = await ws.recv()
        if isinstance(m, bytes):
            pcm += m
        elif json.loads(m)["type"] == "done":
            return pcm


def test_concurrent_streams_sound_as_they_do_alone(mouth):
    # The live sentence and the pre-synthesis come on two connections at once; each synthesis takes
    # an EMA instance of its own (one instance batches its streams, and a batched stream's audio
    # differs in its last bits), so each must get exactly the audio of the same sentence alone.
    import websockets

    texts = ["Bir saniye, hemen bakıyorum.", "Görüşmemiz hizmet kalitesi için yazıya dökülmektedir."]
    alone = {t: b"".join(mouth.chunks(t)) for t in texts}
    assert len(mouth.voices) >= 2
    for voice in mouth.voices[1:]:
        assert {t: b"".join(mouth.chunks(t, voice)) for t in texts} == alone, "the instances are one voice"

    async def clients(url):
        async def one(order, n):
            async with websockets.connect(url, logger=logging.getLogger("canary-client")) as ws:
                await ws.recv()
                return [(t, await synthesise(ws, f"{n}:{k}", t)) for k, t in enumerate(order * 3)]

        a, b = await asyncio.gather(one(texts, 0), one(texts[::-1], 1))
        return a + b

    results = asyncio.run(serve_and(mouth, clients))
    assert len(results) == 12
    for text, pcm in results:
        assert pcm == alone[text], text


def test_a_stream_closed_early_leaves_ema_ready_for_the_next(mouth):
    gen = mouth.chunks("Bu uzun bir cümle; ilk saniyesinden sonra kesiliyor ve geri kalanı hiç okunmuyor.")
    assert next(gen)
    gen.close()
    assert len(b"".join(mouth.chunks("Tamam."))) > 0


def test_a_spoken_name_and_number_reach_no_log(mouth, caplog, capfd):
    # The canary: a name and a phone number through the real stack (respelling, Antalia, EMA, the
    # session over a WebSocket), with the service's own logging at debug level.
    import websockets

    import jeeta_speak

    secret = "Ayşe Yılmaz 0532 412 33 08"
    spoken = mouth.spoken(secret)
    caplog.set_level(logging.DEBUG)
    handler = jeeta_speak.configure_logging("debug")
    quiet = logging.getLogger("canary-client")
    quiet.setLevel(logging.WARNING)

    async def run():
        pool = ThreadPoolExecutor(max_workers=2)
        async with jeeta_speak.open_server(("tcp", "127.0.0.1", 0),
                                           lambda ws: jeeta_speak.session(ws, mouth, pool)) as server:
            port = server.sockets[0].getsockname()[1]
            async with websockets.connect(f"ws://127.0.0.1:{port}", logger=quiet) as ws:
                await ws.recv()
                await ws.send(json.dumps({"type": "synth", "id": "c:0", "text": secret}))
                while True:
                    m = await ws.recv()
                    if isinstance(m, str) and json.loads(m)["type"] != "hello":
                        return json.loads(m)

    try:
        done = asyncio.run(run())
    finally:
        logging.getLogger().removeHandler(handler)
        logging.getLogger("jeeta-speak").setLevel(logging.NOTSET)
    assert done["type"] == "done" and done["audio_ms"] > 1000
    out, err = capfd.readouterr()
    logged = (caplog.text + out + err).lower()
    assert "done:" in logged
    for piece in ["ayşe", "yılmaz", "0532", "412", "33 08", spoken.lower(), "beş yüz otuz iki"]:
        assert piece not in logged, piece
