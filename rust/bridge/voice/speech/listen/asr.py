"""seda-v0.1 (atasoglu, Apache-2.0; its LM files CC BY-SA 4.0) on sherpa-onnx 2.0.1: a streaming
Zipformer2 transducer with 0.64 s chunks, modified beam search over 4 paths with the shipped RNN LM
(shallow fusion, scale 0.6) and its token bigram for LODR (scale -0.5), the scales the model card
tuned on FLEURS dev and sedalib 1.1.0 uses; one thread per decode, per-stream hotwords.

One recognizer serves every call, behind a lock: a stream is used by one thread at a time, and the
recognizer is not documented safe to decode from two. A stream is flushed with 0.9 s of silence
before its last decode, since a chunk is decoded only once it is full (one chunk and the encoder's
right context: sedalib's padding for this chunk size)."""
import atexit
import logging
import os
import shutil
import tempfile
import threading

import numpy as np

import hotwords

LOG = logging.getLogger("jeeta-listen.asr")
RATE = 16000
BEAM = 4
LM_SCALE = 0.6
LODR_SCALE = -0.5
HOTWORDS_SCORE = 1.5
TAIL_PADDING_S = 0.9
# Refusals of a stream's hotwords before no stream gets them (one may be the words, not the model).
HOTWORD_FAILURES = 3
FILES = {"tokens": "tokens.txt", "encoder": "encoder.int8.onnx", "decoder": "decoder.onnx",
         "joiner": "joiner.int8.onnx", "lm": "lm/rnnlm.int8.onnx", "lodr_fst": "lm/2gram.fst"}


def settings():
    """The decoding parameters, as data (part of the listen id)."""
    return {"beam": BEAM, "lm_scale": LM_SCALE, "lodr_scale": LODR_SCALE, "hotwords_score": HOTWORDS_SCORE,
            "tail_padding_s": TAIL_PADDING_S, "threads": 1}


class Seda:
    def __init__(self, model_dir):
        import sherpa_onnx

        path = {k: os.path.join(model_dir, v) for k, v in FILES.items()}
        pieces = hotwords.load_pieces(path["tokens"])
        self.vocab = hotwords.Vocab(pieces)
        # sherpa-onnx reads the vocabulary once, here; the file lives on the run tmpfs (and leaves
        # no trace in an image layer when the build's self-test makes it).
        self.vocab_dir = tempfile.mkdtemp(prefix="jeeta-listen-")
        atexit.register(shutil.rmtree, self.vocab_dir, ignore_errors=True)
        vocab_file = os.path.join(self.vocab_dir, "bpe.vocab")
        with open(vocab_file, "w", encoding="utf-8", newline="\n") as f:
            f.write(hotwords.vocab_text(pieces))
        self.rec = sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=path["tokens"], encoder=path["encoder"], decoder=path["decoder"], joiner=path["joiner"],
            num_threads=1, sample_rate=RATE, feature_dim=80, enable_endpoint_detection=False,
            decoding_method="modified_beam_search", max_active_paths=BEAM,
            hotwords_score=HOTWORDS_SCORE, modeling_unit="bpe", bpe_vocab=vocab_file,
            lm=path["lm"], lm_scale=LM_SCALE, lodr_fst=path["lodr_fst"], lodr_scale=LODR_SCALE,
            provider="cpu", debug=False,
        )
        self.lock = threading.Lock()
        self.hotwords_ok = True
        self.hotword_failures = 0
        self.padding = np.zeros(int(TAIL_PADDING_S * RATE), dtype=np.float32)

    def stream(self, words):
        """A stream biased toward `words` (hotwords.prepare's string); this stream goes without
        them if the recognizer refuses, and every later one after HOTWORD_FAILURES refusals."""
        with self.lock:
            if words and self.hotwords_ok:
                try:
                    return self.rec.create_stream(hotwords=words)
                except (TypeError, RuntimeError, ValueError) as e:
                    self.hotword_failures += 1
                    if self.hotword_failures >= HOTWORD_FAILURES:
                        self.hotwords_ok = False
                    LOG.warning("the recognizer refused a stream's hotwords (%s, %d so far)%s", type(e).__name__,
                                self.hotword_failures, "; no more hotwords" if not self.hotwords_ok else "")
            return self.rec.create_stream()

    def _decode(self, stream):
        while self.rec.is_ready(stream):
            self.rec.decode_stream(stream)

    def accept(self, stream, samples16k):
        with self.lock:
            stream.accept_waveform(RATE, np.asarray(samples16k, dtype=np.float32))
            self._decode(stream)

    def _text(self, stream):
        r = self.rec.get_result(stream)
        return (r if isinstance(r, str) else getattr(r, "text", "")).strip()

    def text(self, stream):
        with self.lock:
            return self._text(stream)

    def finish(self, stream):
        with self.lock:
            stream.accept_waveform(RATE, self.padding)
            stream.input_finished()
            self._decode(stream)
            return self._text(stream)
