"""The session over fake engines: a turn is opened at speech start with its preroll, cut into
segments at its pauses (each decoded while the turn model judges), and reported final (or unheard)
with its audio positions; the echo guard, the dictation fallback and the hotwords reach the parts
that use them."""
import pathlib
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import listen_audio  # noqa: E402
from endpoint import EndpointConfig  # noqa: E402
from hotwords import MARK, Vocab  # noqa: E402
from jeeta_listen import PREROLL_MS, Ears, Session  # noqa: E402

VOCAB = Vocab([MARK, *"abcçdefgğhıijklmnoöprsştuüvyzwqx"])


class LevelVad:
    """Loud audio is speech (0.9), a middling level is doubtful (0.55), quiet is not (0.1)."""

    def prob(self, chunk):
        level = float(np.abs(chunk).mean())
        return 0.9 if level > 0.2 else 0.55 if level > 0.05 else 0.1


class FakeTurn:
    def __init__(self, p, delay=0.0):
        self.p, self.delay, self.calls = p, delay, []

    def complete_probability(self, audio):
        self.calls.append(len(audio))
        if self.delay:
            time.sleep(self.delay)
        if isinstance(self.p, Exception):
            raise self.p
        return self.p


class FakeAsr:
    """Each finished segment reads the next of `segments`; a partial reads `partial`."""

    vocab = VOCAB

    def __init__(self, segments, partial="", delay=0.0):
        self.segments, self.partial, self.delay = list(segments), partial, delay
        self.streams = []
        self.busy = threading.Event()

    def stream(self, words):
        s = {"hotwords": words, "fed": []}
        self.streams.append(s)
        return s

    def accept(self, stream, samples):
        stream["fed"].append(len(samples))

    def text(self, stream):
        return self.partial

    def finish(self, stream):
        if self.delay:
            time.sleep(self.delay)
        return self.segments.pop(0) if self.segments else ""


def ears(asr, turn, cfg=None, judges=None):
    return Ears(LevelVad, turn, asr, lambda: (lambda x: np.repeat(x, 2)), cfg, judges=judges)


def frames(level, ms):
    return [np.full(160, int(level * 32767), dtype="<i2").tobytes() for _ in range(ms // 20)]


LOUD, MIDDLING, QUIET = 0.5, 0.1, 0.0


def run(session, pcm_frames):
    events = []
    for f in pcm_frames:
        events += session.feed(f)
    return events


def kinds(events):
    return [e["type"] for e in events if e["type"] != "partial"]


def test_a_complete_turn_is_reported_final_with_its_positions():
    s = Session(ears(FakeAsr(["evet perşembe uygun"]), FakeTurn(0.9)), ["Jeeta"])
    events = run(s, frames(QUIET, 1000) + frames(LOUD, 600) + frames(QUIET, 400))
    assert kinds(events) == ["speech_start", "speech_end", "final"]
    start, end, final = [e for e in events if e["type"] != "partial"]
    assert start["audio_ms"] == 992  # the first voiced 32 ms chunk
    assert end["audio_ms"] == final["speech_end_ms"] == 1600
    assert final == {"type": "final", "text": "evet perşembe uygun", "speech_end_ms": 1600, "endpoint_ms": 1824,
                     "endpoint_by": "smart_turn", "stt_ms": final["stt_ms"]}
    assert isinstance(final["stt_ms"], int)


def test_the_turn_is_decoded_from_half_a_second_before_its_onset():
    asr = FakeAsr(["evet"])
    s = Session(ears(asr, FakeTurn(0.9)), [])
    run(s, frames(QUIET, 1000) + frames(LOUD, 600) + frames(QUIET, 400))
    (stream,) = asr.streams
    onset, declared = 992, 1216  # the onset, and where speech was declared (seven voiced chunks)
    first = stream["fed"][0]
    assert abs(first - (declared - onset + PREROLL_MS) * 16) <= 320, "preroll + speech so far, at 16 kHz"


def test_the_turn_model_reads_the_turn_from_its_preroll_on():
    turn = FakeTurn(0.9)
    run(Session(ears(FakeAsr(["evet"]), turn), []), frames(QUIET, 1000) + frames(LOUD, 600) + frames(QUIET, 400))
    received = 1840  # the pause is found at 1824 ms, in the frame that ends at 1840 ms
    assert turn.calls == [(received - 992 + PREROLL_MS) * 16]


def test_no_words_is_reported_unheard():
    s = Session(ears(FakeAsr([""]), FakeTurn(0.9)), [])
    events = run(s, frames(LOUD, 600) + frames(QUIET, 400))
    assert events[-1] == {"type": "unheard", "audio_ms": 832}
    assert s.stats["unheard"] == 1 and s.stats["turns"] == 1


def test_an_incomplete_turn_waits_for_the_fallback():
    s = Session(ears(FakeAsr(["şey salı günü"]), FakeTurn(0.1)), [])
    events = run(s, frames(LOUD, 600) + frames(QUIET, 1400))
    assert "final" not in kinds(events)
    events = run(s, frames(QUIET, 400))
    final = events[-1]
    assert final["type"] == "final" and final["endpoint_by"] == "fallback"
    assert final["endpoint_ms"] - final["speech_end_ms"] == 1504


def test_speech_after_an_incomplete_pause_is_the_same_turn_in_a_new_segment():
    asr = FakeAsr(["şey", "salı günü olur"])
    s = Session(ears(asr, FakeTurn(0.1)), [])
    run(s, frames(LOUD, 600) + frames(QUIET, 400))
    events = run(s, frames(LOUD, 600) + frames(QUIET, 1600))
    assert kinds(events) == ["resume", "speech_end", "final"]
    assert events[-1]["text"] == "şey salı günü olur"
    first, second = asr.streams
    resume_onset = events[0]["audio_ms"]
    gap_ms = resume_onset - 608  # the first segment's speech ended at 608 ms
    assert second["fed"][0] <= (gap_ms + 300) * 16, "the new segment never re-reads decoded speech"


def test_a_number_read_out_in_four_groups_is_one_turn_though_each_group_sounds_finished():
    groups = ["numaram sıfır beş yüz otuz iki", "dört yüz", "on iki", "otuz üç sıfır sekiz"]
    s = Session(ears(FakeAsr(groups), FakeTurn(0.9)), [])
    events = []
    for _ in groups:
        events += run(s, frames(LOUD, 600) + frames(QUIET, 1200))
    assert "final" not in kinds(events)
    events += run(s, frames(QUIET, 1800))
    finals = [e for e in events if e["type"] == "final"]
    assert len(finals) == 1 and finals[0]["text"] == " ".join(groups)
    assert finals[0]["endpoint_by"] == "fallback" and finals[0]["endpoint_ms"] - finals[0]["speech_end_ms"] == 2816


def test_an_answer_that_ends_in_numbers_waits_for_the_digits_fallback():
    s = Session(ears(FakeAsr(["saat on dört"]), FakeTurn(0.9)), [])
    events = run(s, frames(LOUD, 600) + frames(QUIET, 3200))
    assert events[-1]["type"] == "final" and events[-1]["endpoint_ms"] - events[-1]["speech_end_ms"] == 2816


def test_while_digits_are_dictated_the_turn_waits_longer():
    s = Session(ears(FakeAsr(["numaram sıfır beş yüz otuz iki", "dört yüz on iki", "tamam mı"]), FakeTurn(0.1)), [])
    run(s, frames(LOUD, 600))
    events = run(s, frames(QUIET, 2000))
    assert "final" not in kinds(events), "1.5 s would have ended it"
    events = run(s, frames(LOUD, 600) + frames(QUIET, 2000))
    assert "final" not in kinds(events), "'on iki' is still a number being read out"
    events = run(s, frames(LOUD, 600) + frames(QUIET, 1600))
    assert events[-1]["text"] == "numaram sıfır beş yüz otuz iki dört yüz on iki tamam mı"
    assert events[-1]["endpoint_ms"] - events[-1]["speech_end_ms"] == 1504, "no number at the end: 1.5 s"


def test_partials_carry_the_turn_so_far_and_only_when_they_change():
    asr = FakeAsr(["şey"], partial="salı")
    s = Session(ears(asr, FakeTurn(0.1)), [])
    events = run(s, frames(LOUD, 1000))
    partials = [e for e in events if e["type"] == "partial"]
    assert partials == [{"type": "partial", "text": "salı"}]
    run(s, frames(QUIET, 400))
    events = run(s, frames(LOUD, 600))
    assert {"type": "partial", "text": "şey salı"} in events


def test_hotwords_are_cleaned_and_open_every_segment():
    asr = FakeAsr(["a", "b"])
    s = Session(ears(asr, FakeTurn(0.1)), ["Ayşe Yılmaz", "Studio 54", "AYŞE YILMAZ"])
    assert (s.kept, s.dropped) == (1, 2)
    run(s, frames(LOUD, 600) + frames(QUIET, 400) + frames(LOUD, 600))
    assert [st["hotwords"] for st in asr.streams] == ["ayşe yılmaz", "ayşe yılmaz"]


def test_the_echo_guard_ignores_a_middling_level_while_the_bridge_plays_and_just_after():
    s = Session(ears(FakeAsr(["x"]), FakeTurn(0.9)), [])
    s.playback(True)
    assert run(s, frames(MIDDLING, 1000)) == []
    s.playback(False)
    assert run(s, frames(MIDDLING, 400)) == [], "the guard's 400 ms tail"
    events = run(s, frames(MIDDLING, 400))
    assert kinds(events)[:1] == ["speech_start"] and events[0]["audio_ms"] >= 1400


def test_a_failing_turn_model_leaves_the_turn_to_the_fallback(caplog):
    s = Session(ears(FakeAsr(["salı"]), FakeTurn(RuntimeError("Ayşe"))), [])
    events = run(s, frames(LOUD, 600) + frames(QUIET, 2000))
    assert events[-1]["endpoint_by"] == "fallback"
    assert "the turn model failed: RuntimeError" in caplog.text and "Ayşe" not in caplog.text


def test_the_turn_model_and_the_decode_run_side_by_side():
    judges = ThreadPoolExecutor(max_workers=1)
    try:
        s = Session(ears(FakeAsr(["evet"], delay=0.15), FakeTurn(0.9, delay=0.15), judges=judges), [])
        run(s, frames(LOUD, 600) + frames(QUIET, 180))
        started = time.monotonic()
        events = run(s, frames(QUIET, 60))
        took = time.monotonic() - started
    finally:
        judges.shutdown()
    assert kinds(events) == ["speech_end", "final"]
    assert took < 0.27, f"{took:.2f} s: the two waited for each other"


def test_a_turn_is_cut_at_its_longest_and_speech_that_goes_on_starts_the_next():
    asr = FakeAsr(["uzun bir konuşma", "devamı"])
    s = Session(ears(asr, FakeTurn(0.9), EndpointConfig(max_turn_ms=3200)), [])
    events = run(s, frames(LOUD, 4000))
    assert kinds(events) == ["speech_start", "final", "speech_start"]
    assert events[1]["endpoint_by"] == "fallback" and events[1]["text"] == "uzun bir konuşma"
    assert sum(sum(st["fed"]) for st in asr.streams) == 4000 * 16, "no frame is decoded twice"


def test_a_pause_never_feeds_the_next_segment_what_the_last_one_had():
    asr = FakeAsr(["şey", "salı"])
    s = Session(ears(asr, FakeTurn(0.1)), [])
    run(s, frames(QUIET, 1000) + frames(LOUD, 600) + frames(QUIET, 300) + frames(LOUD, 600) + frames(QUIET, 400))
    first, second = asr.streams
    assert sum(first["fed"]) + sum(second["fed"]) <= (2900 - 492) * 16


def test_stt_ms_is_the_time_the_last_decode_took():
    s = Session(ears(FakeAsr(["evet"], delay=0.1), FakeTurn(0.9)), [])
    final = run(s, frames(LOUD, 600) + frames(QUIET, 400))[-1]
    assert 80 <= final["stt_ms"] < 1000, "a 100 ms decode (Windows' clock ticks in 15.6 ms)"


def test_hotwords_that_are_not_a_list_are_none():
    s = Session(ears(FakeAsr(["evet"]), FakeTurn(0.9)), "Jeeta")
    assert (s.hotwords, s.kept, s.dropped) == ("", 0, 1)
    assert run(s, frames(LOUD, 600) + frames(QUIET, 400))[-1]["type"] == "final"


def test_after_a_failure_the_turn_is_dropped_closed_and_positions_keep_counting():
    s = Session(ears(FakeAsr(["x", "y"]), FakeTurn(0.9)), [])
    assert s.drop_turn() == [], "nothing open, nothing to close"
    run(s, frames(LOUD, 600))
    assert s.drop_turn() == [{"type": "unheard", "audio_ms": 576}], "the bridge must not wait for a final"
    assert s.drop_turn() == []
    events = run(s, frames(QUIET, 400) + frames(LOUD, 600) + frames(QUIET, 400))
    assert kinds(events) == ["speech_start", "speech_end", "final"]
    assert events[0]["audio_ms"] == 992 and events[-1]["text"] == "x"


def test_odd_frame_sizes_are_carried_over_to_the_next_vad_chunk():
    s = Session(ears(FakeAsr(["evet"]), FakeTurn(0.9)), [])
    pcm = b"".join(frames(LOUD, 600) + frames(QUIET, 400))
    events = []
    for i in range(0, len(pcm), 266):
        events += s.feed(pcm[i:i + 266])
    assert kinds(events) == ["speech_start", "speech_end", "final"]
    assert events[0]["audio_ms"] == 0


def test_g711_alaw_decodes_as_the_standard_table():
    assert listen_audio.alaw_decode(bytes([0xD5, 0x55, 0x2A, 0xAA])) == np.array(
        [8, -8, -32256, 32256], dtype="<i2").tobytes()
    x = np.array([0, 1000, -1000, 32767, -32768], dtype=np.int16)
    back = np.frombuffer(listen_audio.alaw_decode(listen_audio.alaw_encode(x)), dtype="<i2")
    assert np.all(np.abs(back.astype(int) - x.astype(int)) <= np.maximum(16, np.abs(x.astype(int)) // 16))


def test_a_failure_in_the_last_decode_still_closes_the_turn():
    class FailingFinish(FakeAsr):
        def finish(self, stream):
            raise RuntimeError("Ayşe")

    # At the 30 s cut (here 3.2 s) the decode runs after the endpointer has ended the turn.
    s = Session(ears(FailingFinish([]), FakeTurn(0.9), EndpointConfig(max_turn_ms=3200)), [])
    with pytest.raises(RuntimeError):
        run(s, frames(LOUD, 4000))
    assert s.endpointer.state == "idle", "the endpointer had already ended the turn"
    assert s.drop_turn() == [{"type": "unheard", "audio_ms": 3200}]
