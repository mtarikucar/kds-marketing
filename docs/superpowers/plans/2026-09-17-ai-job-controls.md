# AI job execution controls

**Goal:** Workspace owners can disable each AI cost surface and explicitly choose API, their connected MCP assistant, or an appropriate local pretrained model. No implicit paid fallback.

**Architecture:** Extend the existing workspace JSON policy without a schema migration. A shared action catalogue owns labels, supported providers and enablement. Gate at the actual paid invocation, not only the UI. Existing MCP conversation/research leases remain the durable lane for those jobs. Other tasks expose clear MCP-required outcomes rather than secretly calling a paid provider. Local classification and STT use an optional, token-authenticated CPU-limited service; text generation and brand safety retain their existing model quality contracts.

**Constraints:** Preserve unrelated workspace functions. API/MCP/local unavailable is explicit; no paid fallback. Do not equate MCP with free model inference. No production model downloads on the user's laptop. No database migration/seed. No AI authorship markers. Run focused tests sequentially with one worker.

- [x] Catalogue + policy tests: independent action switches, legacy category compatibility, provider validation.
- [x] Owner settings endpoint + workspace isolation and validation tests.
- [x] Invocation guards for text/stream, native research, media, STT and X; MCP conversation/research policy integration.
- [x] Local pretrained classification and transcription service + backend adapters, zero vendor-credit path, no automatic paid fallback.
- [x] Compact settings UI with availability, provider selection and save error handling.
- [x] Regression/type checks, runtime config documentation and review of limitations.

## Validation — 2026-09-17

- Backend regression scanned 673 suites sequentially in batches of 40: 8,415 passed, 37 skipped, one stale STT error-code assertion. The shared policy correctly returns `AI_PROVIDER_INVALID` for an unsupported persisted provider; that assertion was corrected. The subsequent STT, call-analysis, settings and real PostgreSQL policy checks all passed (41 tests).
- The PostgreSQL check exercises 37 policy combinations using transaction-local temporary tables and rolls back; no application data or schema is changed.
- MCP durable retry tests: 20 passed, including tool-result replay, uncertain-write blocking, actor isolation and bounded waits with invalid configuration.
- HTTP settings authorization and full Nest application startup: 16 passed.
- Frontend settings: 22 passed; targeted ESLint passed. Backend and frontend `tsc --noEmit` both passed.
- Optional local runtime: 70 tests passed without model weights, PyTorch or external inference. A separate lightweight CI lane now runs these tests. Workflow/Compose YAML parses and `git diff --check` passes.
- Independent review found no critical/high issues in the policy, settings, generic MCP queue or settings UI.

Runtime setup remains separate: no production deployment, Docker image build, model download or real connected-Claude inference was performed. Local model accuracy and throughput require representative real samples on the intended server. MCP uses client-initiated polling and does not wake a closed client. Operating instructions and retry limits are in [the execution guide](../../ops/ai-execution.md) and [local runtime guide](../../ops/local-ai.md).
