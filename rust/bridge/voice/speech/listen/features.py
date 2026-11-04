"""Whisper's log-mel features as Smart Turn v3.2 reads them, in numpy alone.

The model card's reference computes them with `transformers.WhisperFeatureExtractor(chunk_length=8)`
(80 mel bins, 400-sample periodic Hann window, hop 160, Slaney mel scale and norm, log10, a floor
8 below the maximum, then (x + 4) / 4) on 8 s of 16 kHz audio normalised to zero mean and unit
variance. This is the same arithmetic without the transformers package, as Pipecat does since May
2026 (its `_whisper_features.py`); tests/test_listen_features.py holds it to values transformers
5.21.0 computed (tests/fixtures/whisper_features.json)."""
import numpy as np

RATE = 16000
SECONDS = 8
SAMPLES = RATE * SECONDS
N_FFT = 400
HOP = 160
N_MELS = 80


def _hz_to_mel(f):
    f = np.asarray(f, dtype=np.float64)
    linear = 3.0 * f / 200.0
    return np.where(f >= 1000.0, 15.0 + np.log(np.maximum(f, 1e-10) / 1000.0) * (27.0 / np.log(6.4)), linear)


def _mel_to_hz(m):
    m = np.asarray(m, dtype=np.float64)
    linear = 200.0 * m / 3.0
    return np.where(m >= 15.0, 1000.0 * np.exp((np.log(6.4) / 27.0) * (m - 15.0)), linear)


def mel_filters():
    """(N_FFT // 2 + 1, N_MELS) triangular filters, Slaney-normalised, 0 Hz to 8 kHz."""
    bins = np.linspace(0, RATE // 2, N_FFT // 2 + 1)
    edges = _mel_to_hz(np.linspace(_hz_to_mel(0.0), _hz_to_mel(RATE / 2), N_MELS + 2))
    diff = np.diff(edges)
    slopes = edges[None, :] - bins[:, None]
    down = -slopes[:, :-2] / diff[:-1]
    up = slopes[:, 2:] / diff[1:]
    filters = np.maximum(0.0, np.minimum(down, up))
    return filters * (2.0 / (edges[2:N_MELS + 2] - edges[:N_MELS]))[None, :]


WINDOW = np.hanning(N_FFT + 1)[:-1]  # periodic, as torch.hann_window
FILTERS = mel_filters()


def last_seconds(audio):
    """The last 8 s of 16 kHz audio, zero-padded at the start (the model card's input)."""
    x = np.asarray(audio, dtype=np.float32).reshape(-1)[-SAMPLES:]
    if len(x) < SAMPLES:
        x = np.concatenate([np.zeros(SAMPLES - len(x), dtype=np.float32), x])
    return x


def log_mel(audio):
    """(N_MELS, 800) float32 features of exactly 8 s of 16 kHz audio."""
    x = np.asarray(audio, dtype=np.float32).reshape(-1)
    if len(x) != SAMPLES:
        raise ValueError("log_mel takes exactly 8 s of 16 kHz audio")
    x = (x - x.mean()) / np.sqrt(x.var() + 1e-7)
    padded = np.pad(x.astype(np.float64), (N_FFT // 2, N_FFT // 2), mode="reflect")
    frames = np.lib.stride_tricks.sliding_window_view(padded, N_FFT)[::HOP]
    power = np.abs(np.fft.rfft(frames * WINDOW, axis=-1)) ** 2
    mel = np.log10(np.maximum(1e-10, power @ FILTERS)).T[:, :-1]
    mel = np.maximum(mel, mel.max() - 8.0)
    return ((mel + 4.0) / 4.0).astype(np.float32)
