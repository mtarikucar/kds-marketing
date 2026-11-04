"""Smart Turn's input, the Whisper log-mel features, computed without transformers: held to the
values transformers 5.21.0 computed for the same audio (fixtures/whisper_features.json; on
2026-10-29 the largest difference over the whole 80 x 800 array was 1.2e-7)."""
import json
import pathlib
import sys

import numpy as np
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import features  # noqa: E402

FIXTURE = pathlib.Path(__file__).resolve().parent / "fixtures" / "whisper_features.json"


def signal(seconds):
    """Speech-like and deterministic: a gliding voiced tone with harmonics, a syllable-rate
    envelope that stops 0.6 s before the end, and a hiss (the fixture's input)."""
    t = np.arange(int(16000 * seconds)) / 16000.0
    f0 = 120 + 40 * np.sin(2 * np.pi * 0.7 * t)
    phase = 2 * np.pi * np.cumsum(f0) / 16000.0
    voiced = sum(np.sin(k * phase) / k for k in range(1, 12))
    envelope = 0.5 * (1 + np.sin(2 * np.pi * 4 * t)) * (t < seconds - 0.6)
    hiss = 0.02 * np.sin(2 * np.pi * 3137.0 * t * t + 5 * np.sin(2 * np.pi * 11 * t))
    return (0.3 * envelope * voiced + hiss).astype(np.float32)


def test_the_features_are_the_reference_implementations():
    cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
    assert set(cases) == {"speechlike_5s", "speechlike_9s"}
    for name, case in cases.items():
        mel = features.log_mel(features.last_seconds(signal(case["seconds"])))
        assert mel.shape == (80, 800) and mel.dtype == np.float32
        got = mel[:, case["frames"]].T
        assert np.abs(got - np.array(case["values"], dtype=np.float32)).max() < 2e-5, name
        assert abs(float(mel.mean()) - case["mean"]) < 1e-5
        assert abs(float(mel.min()) - case["min"]) < 1e-5 and abs(float(mel.max()) - case["max"]) < 1e-5


def test_the_last_eight_seconds_are_kept_and_a_short_turn_is_padded_at_the_start():
    short = np.ones(16000, dtype=np.float32)
    x = features.last_seconds(short)
    assert len(x) == features.SAMPLES and not x[:-16000].any() and x[-16000:].all()
    long = np.arange(10 * 16000, dtype=np.float32)
    assert np.array_equal(features.last_seconds(long), long[-features.SAMPLES:])


def test_only_eight_seconds_are_accepted():
    with pytest.raises(ValueError):
        features.log_mel(np.zeros(16000, dtype=np.float32))


def test_silence_and_a_loud_tone_stay_in_range():
    silent = features.log_mel(np.zeros(features.SAMPLES, dtype=np.float32))
    assert np.isfinite(silent).all()
    t = np.arange(features.SAMPLES) / 16000.0
    tone = features.log_mel(np.sin(2 * np.pi * 440 * t).astype(np.float32))
    assert np.isfinite(tone).all() and tone.max() - tone.min() <= 2.0 + 1e-6, "the floor is 8 below the top, /4"


def test_the_filters_are_slaney_triangles_up_to_eight_kilohertz():
    f = features.FILTERS
    assert f.shape == (201, 80) and (f >= 0).all()
    assert all(np.count_nonzero(f[:, m]) > 0 for m in range(80))
    assert np.argmax(f[:, 0]) < np.argmax(f[:, 40]) < np.argmax(f[:, 79])
