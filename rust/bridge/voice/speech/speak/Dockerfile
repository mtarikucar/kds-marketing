# jeeta-voice-speak: EMA Lightning 1.1.2 behind Antalia-2 Mini's normaliser (plan V1-T3 B2).
# Runs with --network none, read-only, as uid 1502 (jeeta-voice-speak) in gid 1501 (jeeta-voice),
# serving /run/jeeta-voice/speak.sock. Build from this directory with speech/pytest.ini copied in.
#
# What is pinned, and how (pins.py has the rules):
# - the base image by digest (python:3.12-slim-bookworm as published on 2026-10-29);
# - every package by version and sha256: torch.lock from PyTorch's CPU index alone and
#   requirements.lock from PyPI alone, --require-hashes --no-deps, wheels only, then `pip check`.
#   `pins.py check-lock` first holds the locks to wheels.sha256 (the first good build's record),
#   to constraints.txt (the frozen set of the image the owner tested) and to requirements.txt;
# - EMA's weights by SHA-256 and size (weights.lock): EMA() reads its repository's main branch and
#   takes no revision, so the build fetches them and refuses a mismatch, and the service checks
#   them again at every start. Antalia's normaliser is code only: no Antalia weights are fetched.
FROM python:3.12-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/models/hf HF_HUB_DISABLE_TELEMETRY=1
RUN groupadd --gid 1501 jeeta-voice \
 && useradd --uid 1502 --gid 1501 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin \
      jeeta-voice-speak
WORKDIR /app
COPY requirements.txt constraints.txt wheels.sha256 torch.lock requirements.lock pins.py ./
RUN python pins.py check-lock
RUN pip install --no-cache-dir --require-hashes --no-deps --only-binary=:all: \
      --index-url https://download.pytorch.org/whl/cpu -r torch.lock --report /tmp/torch.json \
 && pip install --no-cache-dir --require-hashes --no-deps --only-binary=:all: \
      --index-url https://pypi.org/simple -r requirements.lock --report /tmp/pypi.json \
 && pip check \
 && python pins.py wheels /tmp/torch.json /tmp/pypi.json --expect wheels.sha256 > wheels.installed \
 && rm /tmp/torch.json /tmp/pypi.json
COPY weights.lock ./
RUN python pins.py fetch-weights
COPY respell.py respell.json jeeta_speak.py ./
# From here on nothing is downloaded; whatever a library caches goes to the run tmpfs.
ENV HF_HUB_OFFLINE=1 XDG_CACHE_HOME=/tmp/cache HOME=/tmp
# Fail the build, not the first call: the weights check, EMA's offline load and the readings the
# owner's test depended on (jeeta_speak.self_test).
RUN python jeeta_speak.py --self-test
COPY pytest.ini ./
COPY tests ./tests
USER 1502:1501
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=3 \
  CMD ["python", "jeeta_speak.py", "--health"]
CMD ["python", "jeeta_speak.py"]
