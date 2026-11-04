# jeeta-voice-listen: Silero VAD, Smart Turn v3.2 and seda-v0.1 on sherpa-onnx (plan V1-T3 B3).
# Runs with --network none, read-only, as uid 1501 (jeeta-voice-svc) in gid 1501 (jeeta-voice),
# serving /run/jeeta-voice/listen.sock. Build from this directory with speech/pytest.ini copied in.
#
# What is pinned, and how (listen_pins.py has the rules):
# - the base image by digest (python:3.12-slim-bookworm as published on 2026-10-29, as the speak
#   image's);
# - every package by version and sha256: requirements.lock from PyPI alone, --require-hashes
#   --no-deps, wheels only, then `pip check`. `listen_pins.py check-lock` first holds the lock to
#   wheels.sha256 (the bootstrap's record), to constraints.txt (the frozen resolution) and to
#   requirements.txt;
# - every model file by URL, SHA-256 and size (models.lock): seda-v0.1 and Smart Turn v3.2 at fixed
#   Hugging Face revisions, Silero VAD's ONNX file from inside the silero-vad 6.2.3 wheel (never
#   installed: it requires torch). The build fetches and checks them; the service checks them again
#   at every start.
FROM python:3.12-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337
# One BLAS thread: numpy's OpenBLAS would start a spinning thread per host CPU for the turn model's
# small mel product, and under the unit's CPU quota they doubled the time a turn took to end
# (measured in B3: 511 ms against 253 ms for one turn at --cpus 1.5).
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
RUN groupadd --gid 1501 jeeta-voice \
 && useradd --uid 1501 --gid 1501 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin \
      jeeta-voice-svc
WORKDIR /app
COPY requirements.txt constraints.txt wheels.sha256 requirements.lock listen_pins.py ./
RUN python listen_pins.py check-lock
RUN pip install --no-cache-dir --require-hashes --no-deps --only-binary=:all: \
      --index-url https://pypi.org/simple -r requirements.lock --report /tmp/pypi.json \
 && pip check \
 && python listen_pins.py wheels /tmp/pypi.json --expect wheels.sha256 > wheels.installed \
 && rm /tmp/pypi.json
COPY models.lock ./
RUN python listen_pins.py fetch-models /models
COPY endpoint.py hotwords.py features.py vad.py turn.py asr.py jeeta_listen.py ./
COPY THIRD_PARTY.md ./
# From here on nothing is downloaded; the recognizer's hotword vocabulary goes to the run tmpfs.
ENV LISTEN_MODELS=/models HOME=/tmp XDG_CACHE_HOME=/tmp/cache
# Fail the build, not the first call: the models check, their load and the self-test.
RUN python jeeta_listen.py --self-test
COPY pytest.ini ./
COPY tests ./tests
USER 1501:1501
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD ["python", "jeeta_listen.py", "--health"]
CMD ["python", "jeeta_listen.py"]
