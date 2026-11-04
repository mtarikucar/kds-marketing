"""Smart Turn v3.2 (smart-turn-v3.2-cpu.onnx, int8, BSD-2): the probability that the caller has
finished, from the turn's last 8 s at 16 kHz, zero-padded at the start, as the model card's
reference (and Pipecat's LocalSmartTurnAnalyzerV3) computes it. The ONNX session is stateless and
shared by every call."""
import numpy as np

import features


class SmartTurn:
    def __init__(self, path, threads=1):
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = threads
        opts.log_severity_level = 3
        self.session = ort.InferenceSession(path, sess_options=opts, providers=["CPUExecutionProvider"])

    def complete_probability(self, audio16k):
        x = features.log_mel(features.last_seconds(audio16k))[None, :, :]
        out = self.session.run(None, {"input_features": x})
        p = float(np.asarray(out[0]).reshape(-1)[0])
        if not 0.0 <= p <= 1.0:
            raise ValueError("Smart Turn gave no probability")
        return p
