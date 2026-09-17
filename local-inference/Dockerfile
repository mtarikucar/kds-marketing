FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    LOCAL_AI_ALLOW_DOWNLOAD=0 \
    LOCAL_AI_CACHE_DIR=/models/hub \
    HF_HOME=/models \
    HF_HUB_DISABLE_TELEMETRY=1 \
    HF_HUB_DISABLE_XET=1 \
    TOKENIZERS_PARALLELISM=false \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    NUMEXPR_NUM_THREADS=1 \
    CUDA_VISIBLE_DEVICES=""

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY requirements*.txt ./
# Wheels only: no source compilation, CUDA dependencies, or model downloads.
RUN pip install --no-cache-dir --only-binary=:all: -r requirements-torch-cpu.txt \
    && pip install --no-cache-dir --only-binary=:all: -r requirements.txt \
    && groupadd --gid 10001 inference \
    && useradd --uid 10001 --gid 10001 --no-create-home inference \
    && mkdir -p /models/hub \
    && chown -R 10001:10001 /models

COPY local_ai ./local_ai
USER 10001:10001
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "local_ai.service:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--limit-concurrency", "8", "--timeout-keep-alive", "5", "--timeout-graceful-shutdown", "5", "--h11-max-incomplete-event-size", "16384", "--no-access-log", "--no-proxy-headers"]
