# jeeta-voice-speak: EMA Lightning 1.1.2 behind Antalia-2 Mini's normaliser (plan V1-T3 B2).
# Runs with --network none, read-only, as uid/gid 1501 (jeeta-voice-svc:jeeta-voice on the host),
# serving /run/jeeta-voice/speak.sock. Build from this directory with speech/pytest.ini copied in.
#
# What is pinned, and how:
# - the base image by digest (python:3.12-slim-bookworm as published on 2026-10-29);
# - the packages by constraints.txt, the frozen set of the image the owner tested (B2 Step 7):
#   the build refuses to start without it, installs wheels only, and records every wheel's
#   sha256 in /app/wheels.installed (checked against wheels.sha256 once that lists them);
# - EMA's weights by SHA-256 and size (weights.lock): EMA() reads its repository's main branch and
#   takes no revision, so the build fetches them and refuses a mismatch, and the service checks
#   them again at every start. Antalia's normaliser is code only: no Antalia weights are fetched.
FROM python:3.12-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/models/hf HF_HUB_DISABLE_TELEMETRY=1
RUN groupadd --gid 1501 jeeta-voice \
 && useradd --uid 1501 --gid 1501 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin \
      jeeta-voice-svc
WORKDIR /app
COPY requirements.txt constraints.txt ./
RUN grep -qx 'ema-lightning==1.1.2' constraints.txt && grep -qE '^torch==[^ ]+\+cpu$' constraints.txt \
 || { echo "constraints.txt is not the owner-tested package set yet (B2 Step 7)"; exit 1; }
RUN pip install --no-cache-dir --only-binary=:all: --extra-index-url https://download.pytorch.org/whl/cpu \
      -r requirements.txt -c constraints.txt --report /tmp/pip-report.json
COPY pins.py weights.lock wheels.sha256 ./
RUN python pins.py wheels /tmp/pip-report.json --expect wheels.sha256 > wheels.installed \
 && rm /tmp/pip-report.json \
 && python pins.py fetch-weights
COPY respell.py respell.json jeeta_speak.py ./
# From here on nothing is downloaded; whatever a library caches goes to the run tmpfs.
ENV HF_HUB_OFFLINE=1 XDG_CACHE_HOME=/tmp/cache HOME=/tmp
# Fail the build, not the first call: the weights check, EMA's offline load and the readings the
# owner's test depended on (jeeta_speak.self_test).
RUN python jeeta_speak.py --self-test
COPY pytest.ini ./
COPY tests ./tests
USER 1501:1501
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=3 \
  CMD ["python", "jeeta_speak.py", "--health"]
CMD ["python", "jeeta_speak.py"]
