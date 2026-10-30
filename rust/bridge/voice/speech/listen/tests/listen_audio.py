"""Test audio: G.711 A-law (ITU-T, the codec NetGSM's line carries) and the fixtures.

The fixtures are sentences in the speak service's voice (EMA Lightning at 8 kHz), written as the line
delivers them: A-law bytes at 8 kHz, which the tests decode to PCM16 as the worker does
(make_fixtures.py writes them; fixtures.json holds their texts). No person's recording."""
import json
import pathlib

import numpy as np

FIXTURES = pathlib.Path(__file__).resolve().parent / "fixtures"
_SEG_END = np.array([0x1F, 0x3F, 0x7F, 0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF])


def alaw_encode(pcm16):
    """int16 samples -> A-law bytes."""
    x = np.asarray(pcm16, dtype=np.int32) >> 3
    mask = np.where(x >= 0, 0xD5, 0x55)
    x = np.where(x >= 0, x, -x - 1)
    seg = np.searchsorted(_SEG_END, x)
    quant = np.where(seg < 2, x >> 1, x >> np.maximum(seg, 1)) & 0xF
    code = np.where(seg >= 8, 0x7F, (np.minimum(seg, 7) << 4) | quant)
    return (code ^ mask).astype(np.uint8).tobytes()


def alaw_decode(data):
    """A-law bytes -> PCM16 little-endian bytes."""
    a = np.frombuffer(data, dtype=np.uint8).astype(np.int32) ^ 0x55
    t = (a & 0xF) << 4
    seg = (a & 0x70) >> 4
    t = np.where(seg == 0, t + 8, t + 0x108)
    t = np.where(seg > 1, t << np.maximum(seg - 1, 0), t)
    return np.where(a & 0x80, t, -t).astype("<i2").tobytes()


def manifest():
    return json.loads((FIXTURES / "fixtures.json").read_text(encoding="utf-8"))


def fixture(name):
    """A fixture's PCM16 bytes at 8 kHz, as the worker hands them to the listen service."""
    return alaw_decode((FIXTURES / f"{name}.alaw").read_bytes())
