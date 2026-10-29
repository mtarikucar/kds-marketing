"""When a turn starts, pauses, resumes and ends, from VAD probabilities alone (32 ms chunks)."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from endpoint import CHUNK_MS, EndpointConfig, Endpointer, dictating  # noqa: E402

VOICED, SILENT = 0.9, 0.1


def feed(e, prob, chunks):
    out = []
    for _ in range(chunks):
        out += e.feed(prob)
    return out


def speaking(cfg=None, chunks=20):
    e = Endpointer(cfg or EndpointConfig())
    feed(e, SILENT, 3)
    feed(e, VOICED, chunks)
    return e


def test_speech_starts_after_the_minimum_and_reports_its_onset():
    e = Endpointer(EndpointConfig())
    assert feed(e, SILENT, 3) == []
    assert feed(e, VOICED, 6) == []  # 192 ms < 200 ms
    assert feed(e, VOICED, 1) == [("speech_start", 3 * CHUNK_MS)]


def test_a_broken_run_starts_over():
    e = Endpointer(EndpointConfig())
    feed(e, VOICED, 6)
    feed(e, SILENT, 1)
    assert feed(e, VOICED, 6) == []
    assert feed(e, VOICED, 1) == [("speech_start", 7 * CHUNK_MS)]


def test_a_pause_reports_the_end_of_speech_and_a_complete_verdict_ends_the_turn():
    e = speaking()  # speech from 96 ms to 736 ms
    assert feed(e, SILENT, 6) == []  # 192 ms < 200 ms
    assert feed(e, SILENT, 1) == [("pause", 736)]
    assert e.verdict(False) == []
    assert e.verdict(True) == [("finalize", {"speech_end_ms": 736, "endpoint_ms": 960, "by": "smart_turn"})]
    assert e.state == "idle"


def test_an_incomplete_turn_ends_after_the_fallback_silence():
    e = speaking(EndpointConfig(fallback_ms=1500))
    feed(e, SILENT, 7)
    assert e.verdict(False) == []
    assert feed(e, SILENT, 39) == []  # 46 chunks: 1472 ms of silence
    assert feed(e, SILENT, 1) == [("finalize", {"speech_end_ms": 736, "endpoint_ms": 2240, "by": "fallback"})]


def test_while_digits_are_dictated_the_fallback_is_longer():
    e = speaking(EndpointConfig(fallback_ms=1500, digits_fallback_ms=2800))
    feed(e, SILENT, 7)
    e.dictating = True
    assert feed(e, SILENT, 80) == []  # 87 chunks: 2784 ms
    assert feed(e, SILENT, 1)[0][1]["endpoint_ms"] == 736 + 88 * CHUNK_MS


def test_speech_back_in_the_pause_resumes_the_turn_at_its_onset():
    e = speaking()
    feed(e, SILENT, 7)  # paused at 960 ms
    assert feed(e, VOICED, 6) == []
    assert feed(e, VOICED, 1) == [("resume", 960)]
    assert e.verdict(True) == [], "a verdict on a pause that has ended is ignored"
    feed(e, VOICED, 5)
    assert feed(e, SILENT, 7) == [("pause", 960 + 12 * CHUNK_MS)]


def test_a_click_in_the_pause_neither_resumes_nor_ends_the_turn_early():
    e = speaking(EndpointConfig(fallback_ms=1500))
    feed(e, SILENT, 7)
    e.verdict(False)
    assert feed(e, VOICED, 2) == []
    assert feed(e, SILENT, 37) == []  # the fallback counts from the end of speech: 1472 ms so far
    assert feed(e, SILENT, 1)[0][0] == "finalize"


def test_speech_that_begins_just_before_the_fallback_resumes_the_turn_instead():
    e = speaking(EndpointConfig(fallback_ms=1500))
    feed(e, SILENT, 7)
    e.verdict(False)
    feed(e, SILENT, 38)  # 1440 ms of silence: two chunks before the fallback
    assert feed(e, VOICED, 6) == [], "the deadline passes while speech is starting"
    assert feed(e, VOICED, 1) == [("resume", 736 + 45 * CHUNK_MS)]


def test_once_speech_runs_it_continues_down_to_the_release():
    e = speaking()
    assert feed(e, 0.40, 10) == [], "0.40 >= 0.5 - 0.15: still speech"
    assert feed(e, 0.30, 7) == [("pause", 736 + 10 * CHUNK_MS)]
    idle = Endpointer(EndpointConfig())
    assert feed(idle, 0.40, 20) == [], "the release does not start speech"


def test_the_echo_guard_raises_the_threshold_and_the_minimum():
    e = Endpointer(EndpointConfig())
    e.guarded = True
    assert feed(e, 0.55, 20) == []
    assert feed(e, VOICED, 7) == []  # 224 ms < 250 ms while guarded
    assert feed(e, VOICED, 1) == [("speech_start", 20 * CHUNK_MS)]


def test_a_turn_is_cut_at_its_longest():
    e = Endpointer(EndpointConfig(max_turn_ms=3200))
    feed(e, VOICED, 7)  # onset 0
    out = feed(e, VOICED, 93)
    assert out == [("finalize", {"speech_end_ms": 3168, "endpoint_ms": 3200, "by": "fallback"})]
    assert e.state == "idle"
    assert feed(e, VOICED, 7) == [("speech_start", 3200)], "speech that goes on is the next turn"


def test_a_new_turn_after_a_final_starts_from_scratch():
    e = speaking(EndpointConfig(digits_fallback_ms=2800))
    feed(e, SILENT, 7)
    e.dictating = True
    assert feed(e, SILENT, 81)[0][0] == "finalize"  # 88 chunks of silence: 2816 ms
    assert e.dictating is False
    assert feed(e, VOICED, 7) == [("speech_start", 736 + 88 * CHUNK_MS)]


def test_dictation_is_a_number_word_at_the_end_of_numbers_being_read_out():
    assert dictating("numaram sıfır beş yüz otuz iki")
    assert dictating("saat on dört")
    assert dictating("sıfır beş yüz otuz iki dört yüz on kuş sıfır"), "one misheard digit: two of the last three"
    assert dictating("sıfır beş yüz otuz kuş evet iki"), "four or more numbers in the turn"
    assert not dictating("iki")
    assert not dictating("evet iki"), "one number answering a question is not dictation"
    assert not dictating("üç kişi evet iki")
    assert not dictating("evet iki kişi")
    assert not dictating("toplam iki yüz elli lira")
    assert not dictating("")


def test_while_digits_are_dictated_a_complete_verdict_is_not_taken():
    e = speaking(EndpointConfig(fallback_ms=1500, digits_fallback_ms=2800))
    feed(e, SILENT, 7)
    e.dictating = True
    assert e.verdict(True) == [], "a digit group sounds finished"
    assert feed(e, SILENT, 80) == []
    assert feed(e, SILENT, 1)[0][1]["by"] == "fallback"


def test_the_guard_outlasts_the_playback_by_its_tail():
    e = Endpointer(EndpointConfig(guard_tail_ms=400))
    e.playback(True, 0)
    feed(e, SILENT, 10)  # 320 ms
    e.playback(False, 320)
    assert feed(e, 0.55, 13) == [], "the line's echo of the last sound: guarded until 720 ms"
    assert e.guarded is True, "the chunk from 704 ms straddles the end of the tail"
    assert feed(e, 0.55, 7) == [("speech_start", 736)], "0.55 starts a run once the tail is over"
    assert e.guarded is False


def test_playing_again_within_the_tail_keeps_the_guard():
    e = Endpointer(EndpointConfig(guard_tail_ms=400))
    e.playback(True, 0)
    e.playback(False, 0)
    feed(e, SILENT, 5)
    e.playback(True, 160)
    feed(e, SILENT, 20)
    assert e.guarded is True and e.guard_until_ms is None
    e2 = Endpointer(EndpointConfig())
    e2.playback(False, 0)
    assert e2.guarded is False and e2.guard_until_ms is None, "a stop without a start changes nothing"


def test_a_started_run_continues_down_to_the_release():
    e = Endpointer(EndpointConfig())
    feed(e, VOICED, 1)
    assert feed(e, 0.40, 5) == []
    assert feed(e, 0.40, 1) == [("speech_start", 0)], "0.40 >= 0.5 - 0.15 once the run has begun"
    idle = Endpointer(EndpointConfig())
    assert feed(idle, 0.40, 20) == [], "but 0.40 never begins one"


def test_a_second_stop_does_not_stretch_the_tail():
    e = Endpointer(EndpointConfig(guard_tail_ms=400))
    e.playback(True, 0)
    e.playback(False, 0)
    e.playback(False, 300)
    assert e.guard_until_ms == 400
