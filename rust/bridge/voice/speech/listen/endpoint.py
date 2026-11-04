"""When a caller's turn starts and ends (design addendum section 6), from Silero VAD probabilities,
one per 32 ms chunk of 8 kHz audio. Pure: the turn model's verdict and whether the words so far
look like digits being dictated are handed in.

Events: ("speech_start", onset_ms) once speech has lasted the minimum; ("pause", speech_end_ms)
after `stop_ms` of silence, when the turn model should judge the turn; ("resume", onset_ms) when
speech comes back during the pause and lasts the minimum; ("finalize", {...}) when the turn ends: on
the model's "complete", after `fallback_ms` of silence, or when a turn runs past `max_turn_ms`.
While digits are being dictated (`dictating`) the model's "complete" is not taken and the silence
must last `digits_fallback_ms`: callers pause between digit groups, and a group sounds finished.
Times are audio positions in milliseconds since the stream began, at 32 ms steps; the onset is the
start of the first voiced chunk, the end of speech the end of the last one.

A chunk starts a run at `threshold` or above (`guarded_threshold` while the bridge plays something:
the echo guard); once a run has started, and while speech runs, a chunk stays voiced down to that
less `release`, as Silero's reference does (its neg_threshold). The guard outlasts the playback by
`guard_tail_ms` of audio, the line's echo of the last sound."""
from dataclasses import dataclass

CHUNK_MS = 32
# Turkish number words as seda writes them (lowercase, spoken form).
NUMBER_WORDS = frozenset([
    "sıfır", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz", "on", "yirmi", "otuz",
    "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan", "yüz", "bin", "milyon", "çift",
])


def dictating(text):
    """True when the words so far end in a number word and look like a number being read out (a
    phone number, an amount, a date), which callers pause in: two of the last three words are number
    words, or the turn holds four or more, so one misheard digit does not end the dictation."""
    words = text.split()
    if not words or words[-1] not in NUMBER_WORDS:
        return False
    numbers = [w in NUMBER_WORDS for w in words]
    return sum(numbers[-3:]) >= 2 or sum(numbers) >= 4


@dataclass(frozen=True)
class EndpointConfig:
    threshold: float = 0.5
    guarded_threshold: float = 0.6
    release: float = 0.15
    min_speech_ms: int = 200
    guarded_min_speech_ms: int = 250
    guard_tail_ms: int = 400
    stop_ms: int = 200
    fallback_ms: int = 1500
    digits_fallback_ms: int = 2800
    max_turn_ms: int = 30000
    smart_turn_threshold: float = 0.5


class Endpointer:
    def __init__(self, cfg=None):
        self.cfg = cfg or EndpointConfig()
        self.guarded = False
        self.guard_until_ms = None  # the end of the guard's tail, once the playback has stopped
        self.dictating = False
        self.audio_ms = 0
        self.state = "idle"
        self.run_ms = 0  # voiced audio in the current run, before it counts as speech
        self.run_onset_ms = 0
        self.onset_ms = 0  # the turn's onset
        self.speech_end_ms = 0

    def playback(self, active, at_ms):
        """The bridge started (or stopped) playing at audio position `at_ms`: the guard is raised at
        once and lowered `guard_tail_ms` after the stop."""
        if active:
            self.guarded, self.guard_until_ms = True, None
        elif self.guarded and self.guard_until_ms is None:
            self.guard_until_ms = at_ms + self.cfg.guard_tail_ms

    def _start_threshold(self):
        return self.cfg.guarded_threshold if self.guarded else self.cfg.threshold

    def _min_speech_ms(self):
        return self.cfg.guarded_min_speech_ms if self.guarded else self.cfg.min_speech_ms

    def _run(self, prob):
        """Counts a run of voiced chunks; True once it has lasted the minimum speech."""
        floor = self._start_threshold() - (self.cfg.release if self.run_ms else 0.0)
        if prob < floor:
            self.run_ms = 0
            return False
        if self.run_ms == 0:
            self.run_onset_ms = self.audio_ms - CHUNK_MS
        self.run_ms += CHUNK_MS
        return self.run_ms >= self._min_speech_ms()

    def feed(self, prob):
        if self.guard_until_ms is not None and self.audio_ms >= self.guard_until_ms:
            self.guarded, self.guard_until_ms = False, None
        self.audio_ms += CHUNK_MS
        cfg = self.cfg
        if self.state == "idle":
            if self._run(prob):
                self.state = "speaking"
                self.onset_ms = self.run_onset_ms
                self.speech_end_ms = self.audio_ms
                self.run_ms = 0
                return [("speech_start", self.onset_ms)]
            return []
        if self.audio_ms - self.onset_ms >= cfg.max_turn_ms:
            return [self._finalize("fallback")]
        if self.state == "speaking":
            if prob >= self._start_threshold() - cfg.release:
                self.speech_end_ms = self.audio_ms
            elif self.audio_ms - self.speech_end_ms >= cfg.stop_ms:
                self.state = "paused"
                return [("pause", self.speech_end_ms)]
            return []
        # paused
        if self._run(prob):
            self.state = "speaking"
            self.speech_end_ms = self.audio_ms
            self.run_ms = 0
            return [("resume", self.run_onset_ms)]
        wait = cfg.digits_fallback_ms if self.dictating else cfg.fallback_ms
        if self.run_ms == 0 and self.audio_ms - self.speech_end_ms >= wait:
            return [self._finalize("fallback")]
        return []

    def verdict(self, complete):
        """The turn model's verdict on the pause just reported; not taken while digits are
        dictated, when the longer silence decides."""
        if self.state == "paused" and complete and not self.dictating:
            return [self._finalize("smart_turn")]
        return []

    def _finalize(self, by):
        event = ("finalize", {"speech_end_ms": self.speech_end_ms, "endpoint_ms": self.audio_ms, "by": by})
        self.state = "idle"
        self.run_ms = 0
        self.dictating = False
        return event
