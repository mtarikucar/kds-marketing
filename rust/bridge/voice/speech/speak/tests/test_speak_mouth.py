"""The mouth around EMA, with fakes: respelling then normalising, sentences, PCM16 framing, the
batch size, the start-up self-test, the voice id, the watchdog and the logging rules. No model, no
torch."""
import asyncio
import io
import logging
import pathlib
import sys
import threading
import warnings
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import jeeta_speak  # noqa: E402
from jeeta_speak import (  # noqa: E402
    APPROVED_TEXTS, SENTENCE_GAP, Mouth, TooLong, Watchdog, env_int, self_test, set_batch, split_sentences,
    to_pcm16,
)
from respell import Respeller  # noqa: E402

FOLD = str.maketrans("âîûÂÎÛ", "aiuAIU")


def ema_like(text):
    """EMA's frontend on Antalia's readings, as far as the approved texts need: the circumflex
    folded (ema_lightning/frontend.py's alphabet), everything else kept."""
    return text.translate(FOLD)


class FakeTTS:
    """EMA's surface as the mouth uses it: stream(text, sample_rate, seed), _frontend, _batch_size."""

    def __init__(self, chunks=None, frontend=ema_like):
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


def mouth(tts=None, normalize=good_normalizer, table=None, residue=None):
    table = table if table is not None else {"Jeeta": "Cita"}
    return Mouth(Respeller(table), normalize, tts or FakeTTS(), seed=0, residue=residue)


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


def test_samples_become_pcm16_little_endian_rounded_clipped_and_finite():
    with warnings.catch_warnings():
        warnings.simplefilter("error")  # no "invalid value encountered in cast": NaN never reaches the cast
        pcm = to_pcm16(np.array([0.5, -1.5, 1.0, 0.0, -0.5, np.nan, np.inf, -np.inf], dtype=np.float32))
    assert np.frombuffer(pcm, dtype="<i2").tolist() == [16384, -32767, 32767, 0, -16384, 0, 32767, -32767]
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


def test_a_text_that_swells_past_the_cap_once_normalised_is_refused():
    m = mouth(normalize=lambda t: "dokuz " * 1000)
    with pytest.raises(TooLong):
        list(m.chunks("9" * 1000))


def test_symbols_the_normaliser_left_unread_are_counted_without_the_text(caplog):
    caplog.set_level(logging.WARNING)
    m = mouth(residue=lambda t: len(jeeta_speak.RESIDUE.findall(t)))
    m.spoken("Ayşe 0532 #1 %5 a/b c+d 9:30")
    assert m.residual_symbols == 9 + 4 + 1  # nine digits, # % / +, and the clock's colon
    assert "symbols unread" in caplog.text and "Ayşe" not in caplog.text and "0532" not in caplog.text
    assert jeeta_speak.RESIDUE.findall("Mahalle: Atatürk") == [], "a colon between words is punctuation"


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
        # antalia-mini 1.0.1 leaves a lowercase "sn.", "tel." and "st." as written (2026-10-29)
        ("sayın müşterimiz sn. ahmet yılmaz sizi arıyoruz.", ["sayın müşterimiz sn. ahmet yılmaz sizi arıyoruz."]),
        ("bize her gün tel. sıfır beş yüz otuz iki ile ulaşın.", ["bize her gün tel. sıfır beş yüz otuz iki ile ulaşın."]),
        ("dükkanımız çarşı st. yanında, sizi bekliyoruz.", ["dükkanımız çarşı st. yanında, sizi bekliyoruz."]),
        ("  ", []),
    ],
)
def test_sentences_of_a_normalised_text(text, expected):
    # The inputs are antalia-mini 1.0.1's readings of the written sentences (dates, prices, times
    # and abbreviations already words), as produced on 2026-10-29.
    assert split_sentences(text) == expected


def test_no_cut_after_any_of_the_workers_abbreviations():
    for word in jeeta_speak.ABBREVIATIONS:
        text = f"bunu yarın {word}. ahmet yılmaz ile konuşacağız."
        assert split_sentences(text) == [text], word


def test_the_batch_size_is_fixed_on_emas_attribute():
    tts = FakeTTS()
    set_batch(tts, 2)
    assert tts._batch_size == 2

    class Changed:
        pass

    with pytest.raises(SystemExit):
        set_batch(Changed(), 2)


def test_knobs_are_read_strictly(monkeypatch):
    monkeypatch.setenv("SPEAK_X", "7")
    assert env_int("SPEAK_X", 1, 1, 9) == 7
    assert env_int("SPEAK_UNSET", 3, 1, 9) == 3
    for bad in ("x", "", "0", "10", "1.5"):
        monkeypatch.setenv("SPEAK_X", bad)
        with pytest.raises(SystemExit):
            env_int("SPEAK_X", 1, 1, 9)


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

    def apostrophe_read(text):
        return lower(text.replace("14:00'e", "on dörde kesme e"))

    with pytest.raises(SystemExit, match="14:00'e"):
        self_test(mouth(normalize=apostrophe_read))


def test_the_self_test_refuses_a_spelling_the_model_does_not_receive():
    with pytest.raises(SystemExit, match="Google"):
        self_test(mouth(tts=FakeTTS(frontend=lambda t: ema_like(t).replace("gugıl", "g")), table={"Google": "gugıl"}))


def test_the_self_test_refuses_a_frontend_that_changes_an_approved_text():
    def drops_apostrophes(t):
        return ema_like(t).replace("'", " ")

    with pytest.raises(SystemExit, match="approved-text self-test failed: text 0"):
        self_test(mouth(tts=FakeTTS(frontend=drops_apostrophes)))

    def reads_kesme(t):
        return ema_like(t).replace("cita'nın", "cita kesme nın")

    with pytest.raises(SystemExit, match="approved-text"):
        self_test(mouth(tts=FakeTTS(frontend=reads_kesme)))


def test_the_self_test_needs_to_see_what_the_model_reads():
    with pytest.raises(SystemExit):
        self_test(mouth(tts=FakeTTS(frontend=None)))


def test_the_approved_texts_are_the_policys():
    # The defaults of jt_calls (opening.rs, phrases.rs) with "Jeeta" as the workspace; the
    # repository test test_speak_image.py checks each against the Rust source.
    assert len(APPROVED_TEXTS) == 14 and APPROVED_TEXTS[0] == "Merhaba, ben Jeeta'nın dijital asistanıyım."


def test_the_voice_id_follows_every_knob_the_table_and_the_rules(monkeypatch):
    knobs = {"seed": 0, "threads": 2, "batch": 2}
    base = jeeta_speak.voice_fingerprint({"ema-lightning": "1.1.2"}, {"ema.pt": "ab"}, knobs, {"Jeeta": "Cita"})
    assert base == jeeta_speak.voice_fingerprint({"ema-lightning": "1.1.2"}, {"ema.pt": "ab"}, dict(knobs),
                                                 {"Jeeta": "Cita"})
    for change in ({"seed": 1}, {"threads": 1}, {"batch": 1}):
        assert base != jeeta_speak.voice_fingerprint({"ema-lightning": "1.1.2"}, {"ema.pt": "ab"},
                                                     {**knobs, **change}, {"Jeeta": "Cita"}), change
    assert base != jeeta_speak.voice_fingerprint({"ema-lightning": "1.1.2"}, {"ema.pt": "ab"}, knobs, {"Jeeta": "Ciita"})
    assert base != jeeta_speak.voice_fingerprint({"ema-lightning": "1.1.3"}, {"ema.pt": "ab"}, knobs, {"Jeeta": "Cita"})
    for name, value in (("MIN_SENTENCE_WORDS", 4), ("SENTENCE_GAP_MS", 300), ("PIPELINE_VERSION", 2),
                        ("ABBREVIATIONS", frozenset({"dr"}))):
        monkeypatch.setattr(jeeta_speak, name, value)
        assert base != jeeta_speak.voice_fingerprint({"ema-lightning": "1.1.2"}, {"ema.pt": "ab"}, knobs,
                                                     {"Jeeta": "Cita"}), name
        monkeypatch.undo()


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def test_the_watchdog_ends_a_stuck_synthesis_or_a_stalled_loop():
    clock, exits = Clock(), []
    dog = Watchdog(60, clock=clock, exit=exits.append)
    token = dog.begin()
    clock.t = 59
    dog.heartbeat()
    assert not dog.check() and exits == []
    dog.end(token)
    clock.t = 200
    dog.heartbeat()
    assert not dog.check(), "an ended wait does not count"
    dog.begin()
    clock.t = 261
    dog.heartbeat()
    assert dog.check() and exits == [70]

    clock, exits = Clock(), []
    dog = Watchdog(60, clock=clock, exit=exits.append)
    clock.t = 61
    assert dog.check() and exits == [70], "no heartbeat from the loop for over a minute"


def test_the_watchdog_brackets_each_chunk_wait(monkeypatch):
    seen = []

    class Recording(Watchdog):
        def begin(self):
            seen.append("begin")
            return super().begin()

        def end(self, token):
            seen.append("end")
            super().end(token)

    monkeypatch.setattr(jeeta_speak, "_watchdog", Recording(60))

    async def one():
        loop = asyncio.get_running_loop()
        return await jeeta_speak._next_chunk(loop, ThreadPoolExecutor(1), iter([b"x"]))

    chunk = asyncio.run(one())
    assert chunk == b"x" and seen == ["begin", "end"]


def test_only_the_services_records_reach_its_log(capsys):
    handler = jeeta_speak.configure_logging("info")
    stream = io.StringIO()
    handler.setStream(stream)
    hooks = sys.excepthook, threading.excepthook, warnings.showwarning
    try:
        logging.getLogger("jeeta-speak").info("listening")
        logging.getLogger("antalia_mini").warning("text normaliser failed (Ayşe Yılmaz 0532)")
        jeeta_speak.WS_LOG.error("connection handler failed: Ayşe")
        logging.getLogger("torch").info("anything")
        with warnings.catch_warnings():
            warnings.simplefilter("always")
            warnings.showwarning = jeeta_speak._quiet_warning
            warnings.warn("text normaliser failed (KeyError: 'Ayşe 0532 111 22 33')", RuntimeWarning, stacklevel=1)
        try:
            raise ValueError("Ayşe Yılmaz 0532")
        except ValueError:
            jeeta_speak._quiet_exception(*sys.exc_info())
    finally:
        logging.getLogger().removeHandler(handler)
        logging.getLogger("jeeta-speak").setLevel(logging.NOTSET)
        sys.excepthook, threading.excepthook, warnings.showwarning = hooks
    out = stream.getvalue()
    assert "INFO jeeta-speak listening" in out
    assert "withheld a record (WARNING) from antalia_mini" in out
    assert "withheld a record (ERROR) from speak.websocket" in out
    assert "RuntimeWarning at" in out and "uncaught ValueError at test_speak_mouth.py:" in out
    assert "torch" not in out
    assert "Ayşe" not in out and "0532" not in out and "Yılmaz" not in out
