"""With the real models, inside the image on the host (B2 Step 7), with the unit's isolation:

  docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \\
    --user 1501:1501 --tmpfs /tmp:uid=1501,gid=1501,mode=0700,size=16m jeeta-voice-speak:<tag> \\
    python -m pytest -p no:cacheprovider -s -m models tests

Skipped where EMA Lightning or its weights are not installed (the dev machine, CI)."""
import pathlib
import sys

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


def test_the_same_sentence_sounds_the_same_each_time(mouth):
    # The worker caches a sentence's audio by its text: one text, one rendering.
    text = "Anladım."
    assert b"".join(mouth.chunks(text)) == b"".join(mouth.chunks(text))


def test_a_stream_closed_early_leaves_ema_ready_for_the_next(mouth):
    gen = mouth.chunks("Bu uzun bir cümle; ilk saniyesinden sonra kesiliyor ve geri kalanı hiç okunmuyor.")
    assert next(gen)
    gen.close()
    assert len(b"".join(mouth.chunks("Tamam."))) > 0
