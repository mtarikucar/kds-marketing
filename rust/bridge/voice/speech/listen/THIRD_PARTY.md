# Third-party parts of the listen image

Everything below is used unmodified: the model files are fetched at build by URL and SHA-256
(`models.lock`) and the packages installed from hashed wheels (`requirements.lock`). The image runs
on the Jeeta host only and is not distributed; the notices travel with it at `/app/THIRD_PARTY.md`.
Checked on 2026-10-29 against each source (model cards, wheel metadata and LICENSE files).

## Models

| Files (under `/models`) | Source, revision | Author | Licence |
|---|---|---|---|
| `seda-v0.1/encoder.int8.onnx`, `decoder.onnx`, `joiner.int8.onnx`, `tokens.txt` | https://huggingface.co/atasoglu/seda-v0.1 at `5cbbda1b34bde5e3004e79b137dc3871587ea282` | atasoglu | Apache-2.0 (https://www.apache.org/licenses/LICENSE-2.0) |
| `seda-v0.1/lm/rnnlm.int8.onnx`, `lm/2gram.fst` (the language model and its bigram, trained on Turkish Wikipedia) | the same repository and revision | atasoglu | CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/); used as published, not adapted |
| `smart-turn/smart-turn-v3.2-cpu.onnx` | https://huggingface.co/pipecat-ai/smart-turn-v3 at `f766f81d3cfdf7737ac64aad813d91bbfd56bf93` | Daily (pipecat-ai) | BSD-2-Clause, notice below |
| `silero-vad/silero_vad.onnx` | the member `silero_vad/data/silero_vad.onnx` of `silero_vad-6.2.3-py3-none-any.whl` (PyPI, sha256 `7b7f5436cfcb02fae583a05b512ea96467fd449fe54cb49a5e4f06c51a1e43b8`) | Silero Team | MIT, notice below |

seda-v0.1's acoustic model was trained on Mozilla Common Voice (CC0) and the ISSAI Turkish Speech
Corpus (CC BY 4.0: Mussakhojayeva, Dauletbek, Yeshpanov and Varol, "Multilingual Speech Recognition
for Turkic Languages", Information 14(2):74, 2023), as its model card states.

## Code that follows others' arithmetic

- `features.py` computes Whisper's log-mel features the way `transformers.WhisperFeatureExtractor`
  does (Hugging Face, Apache-2.0) and as Pipecat's numpy port does (`_whisper_features.py`, BSD-2-
  Clause, Copyright (c) 2024-2026, Daily; notice below).
- `hotwords.Vocab` makes the cut of simple-sentencepiece 0.7's `Ssentencepiece::Encode`
  (https://github.com/pkufool/simple-sentencepiece, Apache-2.0, Wei Kang), which sherpa-onnx uses.

## Packages (`requirements.lock`)

| Package | Version | Licence |
|---|---|---|
| sherpa-onnx, sherpa-onnx-core | 2.0.1 | Apache-2.0 |
| onnxruntime | 1.31.1 | MIT |
| soxr (python-soxr, with libsoxr and PFFFT inside) | 1.1.0 | LGPL-2.1-or-later (libsoxr LGPL-2.1-or-later; PFFFT BSD-like); its licence files ship in the wheel's `soxr-1.1.0.dist-info/licenses/`. Linked dynamically and unmodified; LGPL's source and relinking terms apply if the image is ever distributed |
| numpy | 2.5.4 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| websockets | 17.3 | BSD-3-Clause |
| protobuf | 7.36.2 | BSD-3-Clause |
| flatbuffers | 25.12.19 | Apache-2.0 |
| packaging | 26.3 | Apache-2.0 OR BSD-2-Clause |
| pytest, pluggy, iniconfig | 8.4.2, 1.7.0, 2.3.1 | MIT |
| Pygments | 2.21.0 | BSD-2-Clause |

## Test audio

`tests/fixtures/*.alaw` are synthetic speech, not a recording of anyone: the speak service's voice,
EMA Lightning 1.1.2 (Canberk Aslan, Apache-2.0; its voice was itself designed from a text
description, with no person's recording), after antalia-mini 1.0.1's normaliser (PatientDesk AI,
Apache-2.0). Apache-2.0 sets no terms on what the software produces. As EMA's model card asks of
audio that others hear: Bu ses yapay zekâ ile üretilmiştir (this voice is AI-generated).

## Notices

### Smart Turn v3.2 (BSD 2-Clause License)

Copyright (c) 2024–2025, Daily

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

### Pipecat's Whisper features, which features.py follows (BSD 2-Clause License)

Copyright (c) 2024–2026, Daily

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

### Silero VAD

MIT License

Copyright (c) 2020-present Silero Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
