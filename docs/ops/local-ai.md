# Optional local classification and transcription

This service provides pretrained zero-shot classification and speech transcription for actions explicitly routed to `LOCAL`. It is optional: the normal Compose stack does not start it. It does not configure action enablement or routing in the application. The caller must enforce each action's enable/disable setting and choose its route before sending data. Disabling an action must prevent the request entirely. A local failure must not silently fall back to a paid API.

There is **zero per-call model API fee**. CPU time, RAM, disk, electricity, bandwidth for initial downloads, and server hosting still cost money. This is not a general text generation LLM; it cannot replace copywriting, rewriting, research, reasoning, image generation, or arbitrary MCP tools. Classification can suggest labels for human review. **Never use a label or score to automatically approve brand safety, compliance, or publication.** There is no quality guarantee, including for Turkish, dialects, noisy audio, or domain-specific labels. Evaluate on representative examples before routing an action here.

## Models and provenance

Verified from the publishers' model cards and repository metadata on 2026-09-17:

| Task | Model and licence | Pinned model revision |
| --- | --- | --- |
| Classification | [MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli](https://huggingface.co/MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli), MIT; multilingual NLI, including Turkish XNLI evaluation | `0a71e92a985b6e1ad1828cf67ce9c459639c1dca` |
| Transcription, default | [Systran/faster-whisper-base](https://huggingface.co/Systran/faster-whisper-base), MIT; multilingual Whisper conversion | `ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66` |
| Transcription, optional | [Systran/faster-whisper-small](https://huggingface.co/Systran/faster-whisper-small), MIT; multilingual Whisper conversion | `536b0662742c02347bc0e980a01041f333bce120` |

MiniLM is selected for lower CPU/RAM demand than the larger mDeBERTa alternative. See its model card for the speed/accuracy trade-off. [faster-whisper](https://github.com/SYSTRAN/faster-whisper/tree/v1.2.1) supports CPU `int8`; [upstream Whisper](https://github.com/openai/whisper#license) publishes the code and model weights under MIT. Keep the upstream licence notices when redistributing models or images. Model cards are retained in the cache. Direct library versions are pinned and were checked against [PyPI](https://pypi.org/) release metadata; CPU PyTorch uses its [official wheel index](https://download.pytorch.org/whl/cpu/torch/). Transitive dependencies and the Python base image are not a complete reproducible lockfile.

## Resource envelope

The overlay enforces one CPU, **2 GiB RAM with no extra swap allowance**, 96 processes/threads, a read-only root filesystem, an unprivileged user, and a 32 MiB temporary filesystem. One Uvicorn worker admits **one POST job at a time, including its upload**; another job receives `429` with `Retry-After: 1`. Health requests remain independent. Do not increase worker/replica counts or use reload mode: these bounds apply per container/process.

Native libraries use one CPU thread. MiniLM uses evaluation mode, a fixed seed and deterministic PyTorch operations. Whisper uses CPU `int8`, one worker, greedy decoding, zero temperature, and no previous-text conditioning. This is reproducible configuration, not a promise of identical floating-point results across different hardware or library versions.

Model imports and loading happen lazily in one subprocess, reused for later jobs. Both models may stay resident until the service stops or a worker error resets it. A **120-second wall-clock job deadline** includes model loading, permitted downloads, audio decoding, and inference. On timeout the subprocess is killed and reaped before the job slot is released (`504`); the next request starts a fresh worker. An out-of-memory worker exit returns `503` when the API process survives. If the whole container is killed, restart it explicitly; the overlay deliberately has no restart loop. These limits reduce exposure but do not guarantee that an already overloaded laptop remains responsive.

The 2 GiB limit is a ceiling, not measured usage or a performance promise. Leave additional host RAM for Docker, the application and the OS. Model cache disk usage is separate from the RAM limit and is not quota-limited by Compose; budget several GiB for images and cache, monitor disk space, and prefer `base` on constrained hosts. `small` costs more memory and CPU and may fail under the same ceiling. First calls are slower. Do not build or warm models on a machine without enough free resources; build/image-pull costs are outside the running container's limits.

## Explicit startup and downloads

Run these commands from the repository root **only when you intend to start local inference**. No model is downloaded or loaded by image build, service boot, or `/health`. With `LOCAL_AI_ALLOW_DOWNLOAD=0` (the default), all model access is cache-only and missing/incomplete weights return `503`. Setting the flag to exactly `1` at container creation authorizes lazy downloads on the first request for each model. An API request cannot turn downloading on, select another repository, change a revision, or execute remote model code. The flag is captured at boot; changing your shell requires container recreation.

```bash
# Keep this secret in your deployment secret store; use the same value in the caller.
export LOCAL_AI_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"

# Validate configuration only: no build, containers, or model downloads.
docker compose -f docker-compose.yml -f docker-compose.local-ai.yml --profile local-ai config --quiet

# Explicit operator opt-in, on a host with sufficient free resources.
export LOCAL_AI_ALLOW_DOWNLOAD=1
docker compose -f docker-compose.yml -f docker-compose.local-ai.yml --profile local-ai up -d --build --no-deps local-ai
```

The image installs CPU-only wheels. Model downloads go to the persistent `local_ai_models` volume and fetch only allowlisted files from the pinned repositories. MiniLM uses safetensors and `trust_remote_code=False`. Whisper requires its local tokenizer file before loading, preventing the library's fallback tokenizer download. The only outbound model traffic is to Hugging Face/download infrastructure when the boot flag permits it; uploaded text/audio is not sent to a model API. Initial downloads can exceed 120 seconds on a slow link: if necessary, recreate with `LOCAL_AI_TIMEOUT_SECONDS=600` for initialization, then restore 120. The maximum accepted deadline is 600 seconds.

After one successful classification and one short transcription have populated the selected models, recreate in cache-only mode:

```bash
export LOCAL_AI_ALLOW_DOWNLOAD=0
export LOCAL_AI_TIMEOUT_SECONDS=120
docker compose -f docker-compose.yml -f docker-compose.local-ai.yml --profile local-ai up -d --no-deps --force-recreate local-ai
```

Keep the token stable across recreation. To select multilingual `small`, set `LOCAL_AI_WHISPER_SIZE=small` and repeat explicit initialization for its separate cache. English-only `.en` variants, arbitrary model IDs and remote URLs are unsupported. Cache-only mode also sets Hugging Face/Transformers offline flags. For deployments requiring an egress firewall, provision the cache first and then apply the host's network policy.

The base overlay shares the default development Compose network: a backend on that network sets `LOCAL_AI_URL=http://local-ai:8000`. A host process sets `LOCAL_AI_URL=http://127.0.0.1:8099`. The host port binds **loopback only** and can be changed with `LOCAL_AI_PORT`. Bearer authentication is required for **every HTTP route**, including health; a missing token, fewer than 32 characters, non-ASCII characters, or whitespace prevents startup. Do not send this token to browsers.

The production stack uses the separate `kds_marketing_net` network. If running this overlay with `docker-compose.prod.yml`, attach the new service to that existing network after creation (and again after recreation):

```bash
# Use the same Compose file set for subsequent service lifecycle commands.
docker compose -f docker-compose.prod.yml -f docker-compose.local-ai.yml --profile local-ai up -d --build --no-deps local-ai
docker network connect --alias local-ai kds_marketing_net \
  "$(docker compose -f docker-compose.prod.yml -f docker-compose.local-ai.yml --profile local-ai ps -q local-ai)"
```

Production configuration must already supply its normal environment files/secrets. This overlay does not alter backend environment variables or production networks. The caller's existing LOCAL routing configuration must point to the reachable base URL and supply `LOCAL_AI_TOKEN`. Route only classification/transcription actions that match these contracts.

## API contract and examples

`GET /health` returns liveness and configured model IDs, **not model readiness or quality**. It does not warm or probe weights:

```bash
curl --fail-with-body -H "Authorization: Bearer $LOCAL_AI_TOKEN" \
  http://127.0.0.1:8099/health
```

```json
{"ok":true,"models":{"classify":"MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli","transcribe":"Systran/faster-whisper-base"}}
```

`POST /classify` takes JSON `{text:string, labels:string[]}` and returns `{label:string, score:number, model:string}`. Only these request fields are allowed. The text must be nonblank and at most 4,096 characters; provide 1–16 nonblank labels, each at most 96 characters, unique after trimming. The raw JSON body is capped at 32 KiB, including JSON escaping. The tokenizer fits each text/label pair into 512 tokens by truncating the text. Keep texts short or split them explicitly. For multiple candidates, the score is relative to those candidates; it is not a calibrated probability of correctness or a safety threshold. A single-candidate call uses NLI entailment-versus-contradiction scoring.

```bash
curl --fail-with-body -H "Authorization: Bearer $LOCAL_AI_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"text":"Yeni restoran menümüzü tanıtıyoruz.","labels":["restoran","spor","teknoloji"]}' \
  http://127.0.0.1:8099/classify
```

`POST /transcribe` takes a multipart **`file`** plus optional **`language`** code and returns `{text:string, language:string, model:string}`. Use `tr` for Turkish or omit language to detect it. Submit WAV, MP3, FLAC, OGG, WebM or MP4/M4A audio. Limits: **8 MiB file**, 8 MiB + 64 KiB total multipart body, **120 seconds of decoded audio**, and 32,768 output characters. Decoding counts actual samples instead of trusting duration metadata; overly long clips are rejected, not silently truncated. No playlists, remote audio URLs, or user-supplied filesystem paths are accepted. Uploaded filenames are ignored. Temporary uploads are removed on success and errors.

```bash
curl --fail-with-body -H "Authorization: Bearer $LOCAL_AI_TOKEN" \
  -F 'file=@/absolute/path/to/short-audio.wav' -F 'language=tr' \
  http://127.0.0.1:8099/transcribe
```

Upload reception has a separate 15-second deadline (`LOCAL_AI_UPLOAD_TIMEOUT_SECONDS`). Both byte limits are checked before JSON/multipart parsing, including chunked bodies without `Content-Length`. Extra multipart parts and unknown fields are rejected. Total request time may include both upload and inference deadlines; set caller timeouts accordingly. Retry `429` with backoff; handle `503` as unavailable and `504` as terminated work. Other errors: `401` authentication, `400` malformed requests/multipart, `408` upload deadline, `413` byte limit, `422` invalid inputs/audio/duration. Error responses use `{detail:string}` or FastAPI's validation-detail array. Invalid inputs never produce an approval result.

## Stop, rollback and tests

Stop and remove only this optional service; the application/database remain running and the cache remains available:

```bash
docker compose -f docker-compose.yml -f docker-compose.local-ai.yml --profile local-ai stop local-ai
docker compose -f docker-compose.yml -f docker-compose.local-ai.yml --profile local-ai rm -f local-ai
```

Disable LOCAL-routed actions or select another explicitly configured route before removal. Omit the overlay/profile on subsequent normal application starts. To reclaim cached model disk space, inspect the removed service's volume name and remove **only** its `local_ai_models` volume when no service uses it; never use `down -v` against the full application stack.

Lightweight tests need Python 3.12 and install HTTP/test libraries plus NumPy/PyAV for tiny audio fixtures. They do **not** install PyTorch, Transformers, faster-whisper, or any model weights, and do not start Docker or perform inference:

```bash
python3 -m venv /tmp/kds-local-ai-test-venv
/tmp/kds-local-ai-test-venv/bin/python -m pip install --only-binary=:all: -r local-inference/requirements-test.txt
cd local-inference
/tmp/kds-local-ai-test-venv/bin/python -m pytest tests -q
```

Tests exercise auth, HTTP contracts, byte/duration limits, bounded real audio decoding, multipart cleanup, concurrency, real lightweight subprocess cancellation/termination/recovery, and safe pinned model-loading options through model-library doubles. Full image builds, model downloads, and real inference/accuracy/performance validation are deliberately separate operator checks on suitable hardware.

The `local-inference` CI job runs this lightweight suite on Python 3.12 without installing model libraries or downloading weights.
