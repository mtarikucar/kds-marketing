"""The mouth around EMA, with fakes: respelling then normalising, sentences, PCM16 framing, the
batch size, the start-up self-test and the warnings hook. No model, no torch."""
import logging
import pathlib
import sys
import warnings

import numpy as np
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import jeeta_speak  # noqa: E402
from jeeta_speak import SENTENCE_GAP, Mouth, self_test, set_batch, split_sentences, to_pcm16  # noqa: E402
from respell import Respeller  # noqa: E402


class FakeTTS:
    """EMA's surface as the mouth uses it: stream(text, sample_rate, seed), _frontend, _batch_size."""

    def __init__(self, chunks=None, frontend=lambda t: t):
        self.calls = []
        self.closed = []
        self.chunks = chunks if chunks is not None else [np.array([0.5, -0.25], dtype=np.float32)]
        self._frontend = frontend
        self._batch_size = None

    def stream(self, text, sample_rate, seed):
        self.calls.append((text, sample_rate, seed))
        try:
            for c in self.chunks:
                yield c
        finally:
            self.closed.append(text)


def lower(text):
    return text.replace("I", "ı").replace("İ", "i").lower()


def good_normalizer(text):
    return lower(text.replace("14:00'e", "on dörde"))


def mouth(tts=None, normalize=good_normalizer, table=None):
    return Mouth(Respeller(table if table is not None else {"Jeeta": "Cita"}), normalize, tts or FakeTTS(), seed=0)


def test_text_is_respelled_before_it_is_normalised():
    m = mouth()
    assert m.spoken("Jeeta'nın asistanıyım.") == "cita'nın asistanıyım."


def test_one_sentence_is_one_stream_of_the_normalised_text_at_8k_with_the_fixed_seed():
    tts = FakeTTS()
    m = Mouth(Respeller({"Jeeta": "Cita"}), good_normalizer, tts, seed=7)
    pcm = b"".join(m.chunks("Merhaba, ben Jeeta'nın dijital asistanıyım."))
    assert tts.calls == [("merhaba, ben cita'nın dijital asistanıyım.", 8000, 7)]
    assert pcm == to_pcm16([0.5, -0.25])


def test_sentences_are_streamed_one_by_one_with_a_quarter_second_between():
    tts = FakeTTS()
    pcm = b"".join(mouth(tts).chunks("Yarın sizi arayacağız. Size uygun mu acaba?"))
    assert [c[0] for c in tts.calls] == ["yarın sizi arayacağız.", "size uygun mu acaba?"]
    one = to_pcm16([0.5, -0.25])
    assert pcm == one + SENTENCE_GAP + one
    assert len(SENTENCE_GAP) == 2 * 2000


def test_samples_become_pcm16_little_endian_rounded_and_clipped():
    pcm = to_pcm16(np.array([0.5, -1.5, 1.0, 0.0, -0.5], dtype=np.float32))
    assert np.frombuffer(pcm, dtype="<i2").tolist() == [16384, -32767, 32767, 0, -16384]
    assert to_pcm16(np.zeros(0, dtype=np.float32)) == b""


def test_closing_the_chunks_closes_emas_stream():
    tts = FakeTTS(chunks=[np.zeros(80, dtype=np.float32)] * 5)
    gen = mouth(tts).chunks("Bir iki üç dört.")
    next(gen)
    gen.close()
    assert tts.closed == ["bir iki üç dört."]


def test_empty_or_unspeakable_text_gives_no_audio():
    tts = FakeTTS()
    assert list(mouth(tts, normalize=lambda t: "").chunks("☕")) == []
    assert tts.calls == []


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (
            "doktor ahmet bey yarın on otuzda sizi arayacak. profesör doktor ayşe hanım da katılacak.",
            ["doktor ahmet bey yarın on otuzda sizi arayacak.", "profesör doktor ayşe hanım da katılacak."],
        ),
        ("evet. tamam. yarın görüşürüz.", ["evet. tamam. yarın görüşürüz."]),
        ("saat dokuzda mı, dokuz otuzda mı?", ["saat dokuzda mı, dokuz otuzda mı?"]),
        (
            "fiyat bin iki yüz doksan dokuz lira. kampanya üç kasıma kadar sürüyor... ne dersiniz?",
            ["fiyat bin iki yüz doksan dokuz lira.", "kampanya üç kasıma kadar sürüyor... ne dersiniz?"],
        ),
        ("harika! yarın sizi arayacağız.", ["harika! yarın sizi arayacağız."]),
        ("bir iki üç dört! beş altı yedi sekiz.", ["bir iki üç dört!", "beş altı yedi sekiz."]),
        ("  ", []),
    ],
)
def test_sentences_of_a_normalised_text(text, expected):
    # The inputs are antalia-mini 1.0.1's readings of the written sentences (dates, prices, times
    # and abbreviations already words), as produced on 2026-10-29.
    assert split_sentences(text) == expected


def test_the_batch_size_is_fixed_on_emas_attribute():
    tts = FakeTTS()
    set_batch(tts, 2)
    assert tts._batch_size == 2

    class Changed:
        pass

    with pytest.raises(SystemExit):
        set_batch(Changed(), 2)


def test_the_self_test_passes_on_the_owners_readings():
    self_test(mouth(table={"Jeeta": "Cita", "Google": "gugıl", "Instagram": "instagram"}))


def test_the_self_test_refuses_normalizer_tr_s_reading_of_the_clock():
    def normalizer_tr(text):
        return lower(text.replace("14:00'e", "on dört iki nokta sıfır sıfır kesme e"))

    with pytest.raises(SystemExit, match="14:00'e"):
        self_test(mouth(normalize=normalizer_tr))

    def half_right(text):
        return lower(text.replace("14:00'e", "on dörde iki nokta sıfır sıfır"))

    with pytest.raises(SystemExit, match="14:00'e"):
        self_test(mouth(normalize=half_right))


def test_the_self_test_refuses_a_spelling_the_model_does_not_receive():
    with pytest.raises(SystemExit, match="Google"):
        self_test(mouth(tts=FakeTTS(frontend=lambda t: t.replace("gugıl", "g")), table={"Google": "gugıl"}))


def test_the_self_test_needs_to_see_what_the_model_reads():
    with pytest.raises(SystemExit):
        self_test(mouth(tts=FakeTTS(frontend=None)))


def test_the_voice_id_follows_the_table_and_the_seed():
    a = jeeta_speak.voice_fingerprint({"ema-lightning": "1.1.2"}, {"ema.pt": "ab"}, 0, {"Jeeta": "Cita"})
    assert a == jeeta_speak.voice_fingerprint({"ema-lightning": "1.1.2"}, {"ema.pt": "ab"}, 0, {"Jeeta": "Cita"})
    assert a != jeeta_speak.voice_fingerprint({"ema-lightning": "1.1.2"}, {"ema.pt": "ab"}, 1, {"Jeeta": "Cita"})
    assert a != jeeta_speak.voice_fingerprint({"ema-lightning": "1.1.2"}, {"ema.pt": "ab"}, 0, {"Jeeta": "Ciita"})


def test_a_library_warning_reaches_the_log_without_its_message(caplog):
    caplog.set_level(logging.WARNING)
    with warnings.catch_warnings():
        warnings.simplefilter("always")
        warnings.showwarning = jeeta_speak._quiet_warning
        warnings.warn("text normaliser failed (KeyError: 'Ayşe 0532 111 22 33')", RuntimeWarning, stacklevel=1)
    assert "RuntimeWarning" in caplog.text
    assert "Ayşe" not in caplog.text and "0532" not in caplog.text
