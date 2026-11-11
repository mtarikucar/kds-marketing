"""Silero VAD (the ONNX file the silero-vad 6.2.3 wheel ships, MIT) at 8 kHz: 256-sample chunks with
the 32 samples before each as context, as its reference wrapper (silero_vad.utils_vad.OnnxWrapper)
feeds them. One ONNX session for every call; each call keeps its own recurrent state."""
import numpy as np

RATE = 8000
CHUNK = 256
CONTEXT = 32


def load(path, threads=1):
    import onnxruntime as ort

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = threads
    opts.inter_op_num_threads = 1
    opts.log_severity_level = 3
    return ort.InferenceSession(path, sess_options=opts, providers=["CPUExecutionProvider"])


class SileroVad:
    def __init__(self, session):
        self.session = session
        self.sr = np.array(RATE, dtype=np.int64)
        self.reset()

    def reset(self):
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.context = np.zeros((1, CONTEXT), dtype=np.float32)

    def prob(self, chunk):
        """The probability that this chunk of 256 samples (float32 in [-1, 1]) is speech."""
        x = np.concatenate([self.context, np.asarray(chunk, dtype=np.float32).reshape(1, CHUNK)], axis=1)
        out, self.state = self.session.run(None, {"input": x, "state": self.state, "sr": self.sr})
        self.context = x[:, -CONTEXT:]
        return float(out[0][0])
