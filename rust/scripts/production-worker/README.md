# Bounded external media worker

This is an opt-in external supervisor for **image analysis and single-image cropping**. It is not a general autonomous publisher or a video editor. It connects to Jeeta's existing HTTP MCP endpoint; application claim/revision/lease checks remain authoritative.

Supported input is a static JPEG, PNG or WebP. GIF, video, multi-source jobs, edit and poster requests remain unclaimed. Crop creates a real PNG using Pillow; the original is unchanged. AI analysis does not invent capture dates, create confirmed events, or grant share permission. Derived output has no share decision and still passes through existing human/policy controls.

## Runtime boundary

The supervisor alone owns `JEETA_WORKER_API_KEY`. Its fixed MCP allowlist includes work check-in and material read/analysis/production/upload operations. No publication, approval, permissions, connector, team or API-key administration tools exist in the allowlist. This is necessary because the application's current `studio.work` permission also covers publication operations.

The model receives a normalized image, user crop instruction (as untrusted data), and a strict output schema. It never receives the Jeeta key, URL, claim token or server environment. Codex user config is ignored; MCP servers and web search are disabled. Shell/unified execution, code mode, apps, plugins, browsers, computer use, skill discovery and multi-agent capabilities are disabled; its sandbox is read-only. Output is validated before the supervisor executes a fixed rectangular crop. No model-provided command, executable, path, URL or shell fragment is executed.

The CLI configuration was prepared against `codex-cli 0.166.0-alpha.1`. Flags and actual tool availability must be revalidated when upgrading Codex. The installed CLI and its existing model authentication remain trusted components. Read-only model execution does not make an untrusted/replaced CLI safe. This worker never copies authentication from the cloud chat to another machine.

## Configuration

Use a dedicated service account and private environment file (0600); do not put keys in CLI arguments, Git or logs.

| Variable | Meaning |
| --- | --- |
| `JEETA_MCP_URL` | `https://staging.jeetagrowth.com/mcp`, or explicit loopback HTTP for a disposable local proof |
| `JEETA_WORKER_API_KEY` | Dedicated Jeeta key with `workspace.read` and `studio.work`; add `strategy.read` only if a future supported worker actually needs it |
| `JEETA_WORKER_ENABLE_CODEX` | Must explicitly equal `1`; otherwise the worker stays offline |
| `JEETA_WORKER_CODEX_BIN` | Trusted installed executable, default `codex` from PATH |
| `JEETA_WORKER_MODEL` | Optional explicit model; service operator owns authentication/quota/model selection |
| `JEETA_WORKER_STATE_DIR` | Private service-owned 0700 directory, default `/var/lib/jeeta-production-worker` |
| `JEETA_WORKER_POLL_SECONDS` | 15–3600, default 60 |
| `JEETA_WORKER_MAX_BYTES` | Maximum input/output bytes; default 8 MiB, allowed 1 KiB–16 MiB |
| `JEETA_WORKER_MAX_MODEL_CALLS_PER_DAY` | 1–1000, default 20; reserves a call before launch, including failures, using UTC days |
| `JEETA_WORKER_MAX_CACHE_BYTES` | 32 MiB–1 GiB, default 128 MiB; reserves headroom and pauses new crop jobs when retained cache is full |
| `JEETA_WORKER_PREVIEW_ORIGINS` | Optional comma-separated exact trusted origins; default only the MCP origin |

The daily call count and two-minute model timeout are coarse guards, **not a currency budget**. No application budget reservation or provider billing integration is claimed. They are local to the state directory; do not configure multiple state directories against the same worker budget. Production must additionally set suitable provider limits and service resource limits.

The model subprocess inherits only PATH, its existing home/auth location, locale, proxy and CA trust variables. Jeeta, GitHub, and arbitrary application/provider secret environment variables are excluded. Configure the service account's model login separately using the model provider's supported workflow; an `OPENAI_API_KEY` inherited by the supervisor is deliberately not forwarded. Never reuse the cloud chat's private credential files for deployment.

Install Python 3.11+ and `requirements.txt` into the worker's own virtual environment. No application DB or sealing key is required. The included service file is an **example only**, not installed/enabled by this change. The service account's own Codex authentication must be accessible under its normal home path and compatible with its OS sandbox. Verify unprivileged sandbox support on the intended host.

## Commands

```sh
python3 worker.py --health
python3 worker.py --once --kind analysis --work-id MATERIAL_UUID
python3 worker.py --once --kind crop --work-id PRODUCTION_UUID
python3 worker.py --poll
```

Without `--poll`, at most one supported job is processed. `--kind` and `--work-id` narrow selection before claim; use both for controlled proofs. `--health` is local-only, makes no network/model call, and reports `offline` or `configured_not_verified`. It never reports an untested model as ready.

Stored model authentication (including a successful CLI login-status check) does not prove that inference authentication is still valid. Recognized authentication failures produce only `model_auth_unavailable`; bounded subprocess diagnostics are never logged or saved. Configure and verify the deployed service account's own authentication before enabling the worker. A crop transport/pixel proof using a fixed recipe does not establish model inference readiness.

An image analysis increments the material revision. For a subsequent crop test, create the production request using the **new current source revision after analysis completes**. This is intentional; old requests must fail when their source changes.

## Lifecycle and failure behavior

- A local `flock` prevents overlapping workers using the same state directory. Server claim leases additionally protect against different clients.
- The supervisor uses the server claim's token/revision and submits results only through existing completion tools. No Python-side substitute for application claims exists.
- Model work is capped at 120 seconds, below the existing 10-minute analysis/30-minute production leases. There is no heartbeat API. Long video or generative media jobs are unsupported here.
- Input is byte-limited, format-validated and capped at 20 million pixels. Animated input is refused. Model images are normalized and reduced to at most 2048 pixels; the original crop uses full validated image pixels.
- Preview URLs require the exact configured origin; redirects are refused and the Jeeta bearer key is never added to preview downloads. HTTP is permitted only for localhost/loopback. Extra origins are operator configuration, never model output.
- Crop recipes and adopted output IDs are cached privately. Deterministic upload/material request keys and cached recipes avoid another model call or duplicate upload when a claimed crop is retried after an uncertain completion. Never delete this state during an unresolved publication/production recovery.
- An uncertain MCP transport/completion result is not immediately marked failed. The next check-in and authoritative server lease/result settle it; no unconditional retry loop runs a new model call.
- Explicit model/schema failures submit fixed error codes. Failed application jobs remain failed until an authorized retry/new request; there is no infinite expensive retry loop.
- Unsupported jobs remain pending for a capable external worker. Logs say `idle` with unsupported count, rather than pretending to complete them.
- Output names, private URLs, claim tokens, model text, customer content and exception strings are not logged. Application audit records remain on Jeeta.

Private state can contain source-derived images and crop instructions. Successful analysis task directories and successful crop state are removed; failed/uncertain crop state is retained for recovery. New crop jobs pause with `worker_cache_full` when the configured cache bound plus per-job headroom would be exceeded; recovery of an existing cached job is still permitted. Low disk space pauses before claim.

Manual retention procedure: stop the service and acquire its state lock; inspect the corresponding production UUID through Jeeta; remove only that owned `crop-UUID` directory after the job is confirmed completed/cancelled or an operator has explicitly abandoned its failed recovery. Never remove unresolved/running jobs merely by age, never remove the daily budget file to reset a limit, and never delete the whole state directory to clear a warning. No automatic age-based deletion of uncertain work is implemented. Do not archive state as public CI evidence.

## Verification

```sh
python3 -m unittest discover -s rust/scripts/production-worker -p 'test_*.py' -v
```

Tests use a fake local HTTP MCP endpoint and fake CLI executables; no inference bill or social post is created. They cover authentication/session/SSE parsing, fixed tool boundaries, source revisions, real cropped pixel dimensions, output privacy fields, uncertain completion replay, unsupported jobs staying unclaimed, singleton locking, daily call caps, malformed model results and process-group timeouts.

Real model inference, server deployment and unattended operation are separate acceptance checks. Before enabling polling, perform an exact-ID local/staging analysis and crop proof, inspect the resulting pixels and metadata, verify the effective model tools are restricted, restart the worker during a controlled job and confirm recovery, and configure runtime authentication plus provider spending limits. A healthy chat environment is not evidence of an installed persistent worker.
