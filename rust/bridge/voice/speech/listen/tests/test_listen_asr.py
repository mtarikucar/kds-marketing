"""The recognizer as asr.Seda builds it, over a stand-in for sherpa-onnx: the pinned decoding
(beam 4, LM 0.6 with LODR -0.5, hotwords 1.5 cut as "bpe" over the vocabulary it writes), the
flush before the last decode, and hotwords refused for one stream before they are given up."""
import pathlib
import sys
import types

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import asr  # noqa: E402
import hotwords  # noqa: E402

TOKENS = "<blk> 0\n<sos/eos> 1\n<unk> 2\n▁ 3\na 4\nb 5\n▁ab 6\n"


class FakeStream:
    def __init__(self, words):
        self.words, self.fed, self.finished = words, [], False

    def accept_waveform(self, rate, samples):
        self.fed.append((rate, len(samples)))

    def input_finished(self):
        self.finished = True


class FakeRecognizer:
    def __init__(self, kwargs, refuse=0):
        self.kwargs, self.refuse, self.streams = kwargs, refuse, []

    def create_stream(self, hotwords=None):
        if hotwords is not None and self.refuse:
            self.refuse -= 1
            raise RuntimeError("refused")
        self.streams.append(FakeStream(hotwords))
        return self.streams[-1]

    def is_ready(self, stream):
        return False

    def decode_stream(self, stream):
        raise AssertionError("never ready")

    def get_result(self, stream):
        return " evet "


@pytest.fixture
def seda(tmp_path, monkeypatch):
    made = {}

    def from_transducer(**kwargs):
        made["rec"] = FakeRecognizer(kwargs)
        made["vocab"] = pathlib.Path(kwargs["bpe_vocab"]).read_text(encoding="utf-8")
        return made["rec"]

    fake = types.ModuleType("sherpa_onnx")
    fake.OnlineRecognizer = types.SimpleNamespace(from_transducer=from_transducer)
    monkeypatch.setitem(sys.modules, "sherpa_onnx", fake)
    (tmp_path / "tokens.txt").write_text(TOKENS, encoding="utf-8")
    return asr.Seda(str(tmp_path)), made, tmp_path


def test_the_pinned_decoding_reaches_the_recognizer(seda):
    _, made, d = seda
    kw = made["rec"].kwargs
    assert {k: kw[k] for k in ("decoding_method", "max_active_paths", "lm_scale", "lodr_scale", "hotwords_score",
                               "modeling_unit", "num_threads", "sample_rate", "feature_dim",
                               "enable_endpoint_detection", "provider", "debug")} == {
        "decoding_method": "modified_beam_search", "max_active_paths": 4, "lm_scale": 0.6, "lodr_scale": -0.5,
        "hotwords_score": 1.5, "modeling_unit": "bpe", "num_threads": 1, "sample_rate": 16000, "feature_dim": 80,
        "enable_endpoint_detection": False, "provider": "cpu", "debug": False}
    for key, name in [("tokens", "tokens.txt"), ("encoder", "encoder.int8.onnx"), ("decoder", "decoder.onnx"),
                      ("joiner", "joiner.int8.onnx"), ("lm", "lm/rnnlm.int8.onnx"), ("lodr_fst", "lm/2gram.fst")]:
        assert pathlib.Path(kw[key]) == d / name, key
    assert made["vocab"] == hotwords.vocab_text(["▁", "a", "b", "▁ab"])


def test_the_settings_are_the_pins():
    assert asr.settings() == {"beam": 4, "lm_scale": 0.6, "lodr_scale": -0.5, "hotwords_score": 1.5,
                              "tail_padding_s": 0.9, "threads": 1}


def test_the_last_decode_is_flushed_with_0_9_s_of_silence(seda):
    s, made, _ = seda
    stream = s.stream("")
    s.accept(stream, [0.0] * 320)
    assert s.finish(stream) == "evet"
    assert stream.fed == [(16000, 320), (16000, 14400)] and stream.finished


def test_a_refused_stream_goes_without_hotwords_and_three_refusals_give_them_up(seda, caplog):
    s, made, _ = seda
    rec = made["rec"]
    rec.refuse = 1
    assert s.stream("ayşe yılmaz").words is None, "this stream without"
    assert s.hotwords_ok and s.stream("ayşe yılmaz").words == "ayşe yılmaz", "the next one with"
    rec.refuse = 3
    for _ in range(2):
        assert s.stream("ayşe").words is None
    assert not s.hotwords_ok and s.hotword_failures == 3
    rec.refuse = 0
    assert s.stream("ayşe").words is None, "given up: no more hotwords"
    assert "refused a stream's hotwords" in caplog.text and "ayşe" not in caplog.text.lower()
