# M1b Bağlayıcılar (Meta, NetGSM, X connectors) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give tenants real connections to Meta (Facebook Pages, Instagram, Messenger, WhatsApp Cloud, Meta Ads, lead-gen), NetGSM (SMS, Netsantral PBX, İYS) and X: OAuth and credential flows that create connector-reach capabilities with sealed configuration, probes that verify them, scheduled token refresh, signed webhook intake with deduplicated inbound events, hardened egress (fixed hosts, DNS guard, boot-time rebuild), and the agent/panel surfaces to connect, probe and watch health. Sending, publishing, replying and budget moves through these connections are M2/M3 use cases; this plan delivers the connections and the raw operation ports they will call.

**Architecture:** One pure domain crate `jt_connector` (error taxonomy, credential shapes, OAuth state and PKCE, webhook signature math, inbound event model). `jt_app` gains the `Connector` port family and the connection/probe/webhook use cases. One adapter crate per provider under `crates/adapters/connectors/{jt_meta,jt_netgsm,jt_x}` — each talks to the outside world ONLY through `jt_outbound::Egress` with `EgressScope::Connector(name)` (archtest-enforced). A driving adapter `jt_webhook` receives provider callbacks. The binary gains a deterministic scheduler (token refresh, probes, NetGSM delivery-report and inbox polling) and rebuilds the egress tenant-host tier from live capabilities at boot. Everything stays inside M0/M1a rules: tenant tables under FORCE RLS, reversible migrations, ledger on every mutation, twin rule, status/strategy gates, secrets sealed per workspace and never returned.

**Tech Stack:** as M0/M1a plus `hmac`/`sha2` (already present), `base64` (present), `url` (present), `rand` (present); provider testing with an in-process axum mock server (no live calls in CI). No new HTTP client anywhere.

**Spec:** `docs/superpowers/specs/2026-10-22-jeeta-rust-yeniden-yazim-design.md` §4.2 rule 1 (kanal bağlayıcıları içeride), §4.3 (adapters, egress allowlist two tiers), §4.4 (webhook kapısı), §6.1 (ulaşım yolu "bağlayıcı": kimlik bilgileri mühürlü), §6.4 (bağlayıcı doğrulama = sistemin deneme çağrısı; `ulaşılamıyor`; "yeniden bağla"), §10 (saklama: webhook ham gövdesi 30 gün), §11 (webhook'lar imza doğrular, tekilleştirir, ham gövdeyi saklar, işlemi kuyruğa atar), §13 M1 row ("ilk bağlayıcılar: Meta (Instagram, Facebook, WhatsApp Cloud, Messenger, Ads), NetGSM (SMS, santral), X; OAuth akışları"), B10. Provider facts come from the local reference map `docs/reports/v2-reference/rust-rewrite-research/04-connector-map-meta-netgsm-x.md` (v1 endpoints, scopes, signatures, gotchas) — every provider URL, scope list, header and payload shape in this plan is taken from it.

## Global Constraints

All M0 and M1a Global Constraints apply. Additions:

- **No provider adapter may hold an HTTP client.** `jt_meta`, `jt_netgsm`, `jt_x` depend on `jt_outbound` and call `Egress::send(EgressScope::Connector("meta"|"netgsm"|"x"), request)`; `cargo deny` keeps `reqwest` wrapped by `jt_outbound` only; `jt_archtest` asserts the three connector crates do not list `reqwest`.
- **Fixed hosts per connector** (`jt_outbound::FIXED_HOSTS`): `meta` → `graph.facebook.com`, `graph.instagram.com`, `api.instagram.com`, `rupload.facebook.com`; `netgsm` → `api.netgsm.com.tr`, `whatsappapi.netgsm.com.tr`, `sesdosya.netgsm.com.tr`, `crmsntrl.netgsm.com.tr:9111`; `x` → `api.twitter.com`, `api.x.com`. Nothing else. Netsantral's plain-`http` click-to-call endpoint is the ONE exception to https-only: allowed solely for host `crmsntrl.netgsm.com.tr` with port 9111 under `EgressScope::Connector("netgsm")` (explicit allow in `jt_outbound`, tested, documented as a provider limitation).
- **Credentials are sealed** with `SecretBox` into `capabilities.connector_sealed`; never returned by any use case, tool, route, ledger payload or log; `connector_public` holds only non-secret facts (external ids, names, scopes, expiry, hosts).
- **Webhooks:** verify before parse (Meta `X-Hub-Signature-256` HMAC-SHA256 of the raw body with the app secret, constant-time compare; NetGSM path token = hex HMAC-SHA256(workspace seal key, `"netgsm-hook:<workspace>:<purpose>"`), constant-time compare; both → 401/404 on failure), dedupe by `(workspace_id, connector, external_id)`, store the raw body for 30 days, acknowledge fast (Meta 200 immediately, processing after), process asynchronously.
- **Platform OAuth apps** (Meta app id/secret, Instagram app id/secret, X client id/secret, Meta webhook verify token) are platform configuration from the environment, never per tenant. Tenants connect THEIR accounts to the platform's apps (K3 + spec §6). NetGSM credentials are per tenant and entered by hand.
- **Every inbound event is a ledger-free record** (events table), but every connection change (connect, confirm assets, set credentials, probe result change, token refresh failure, retire) writes a ledger entry.
- **Deterministic jobs only** (spec §4.2 rule 2): the scheduler runs refresh, probe and poll on fixed intervals; it never decides content.
- **ConnectorError taxonomy** `Auth | Permission | Throttle | Transient | Permanent` is the only error shape adapters return; `Auth` marks the capability `unreachable` with evidence `reauth_required`; `Throttle` backs off; `Transient` retries (bounded); `Permanent` records and stops.
- **Tests never reach the internet:** every adapter test runs against an in-process axum mock bound to 127.0.0.1 with the mock's host allowed through the test-only loopback path; recorded provider responses live in `tests/fixtures/*.json`.
- **Status gate:** all `connector.*`, `webhook.*`, `events.*` use cases are strategy-Exempt (connecting accounts is part of consultation prerequisites) and NOT status-exempt (a pending-payment workspace cannot connect accounts); the exempt-prefix list grows by `connector.`, `events.`.

## Review Focus

1. **A webhook with a valid signature but for a workspace that no longer owns the account** (capability retired or re-connected elsewhere) — must be stored as an unrouted event (or dropped with a log) and never attached to another tenant. Pinned in Task 9.
2. **Replayed webhook** (same `mid`/`wamid`/`gorevid` twice) — exactly one event row; the second delivery is acknowledged and ignored. Pinned in Task 3 and Task 9.
3. **Expired or revoked token discovered by a probe** — capability flips to `unreachable` with `reauth_required`, the panel shows "Yeniden bağla", `work.pending` lists it, and nothing else about the workspace changes. Pinned in Task 8.
4. **OAuth state replay or cross-workspace completion** — a state token used twice, after 10 minutes, or by a session of another workspace is refused; nothing is created. Pinned in Task 2 and Task 8.
5. **Boot with a retired connector capability that still names hosts** — after boot the egress tenant tier contains hosts of live connector capabilities only. Pinned in Task 4.

---

## File Structure

```
rust/
  migrations/0005_connectors.up.sql / .down.sql   inbound_events, oauth_pending, probe_runs
  crates/
    domain/jt_connector/src/{lib.rs,error.rs,credential.rs,oauth.rs,webhook.rs,event.rs,health.rs}
    jt_app/src/ports.rs                           + Connector, OAuthProvider, ConnectorRegistry, InboundEventRepo, OAuthPendingRepo, ProbeRunRepo, PlatformAppConfig
    jt_app/src/usecases/{connector.rs,webhook.rs,events.rs,jobs.rs}
    adapters/jt_outbound/src/{fixed_hosts.rs,dns_guard.rs,tenant_rebuild.rs}
    adapters/connectors/jt_meta/src/{lib.rs,graph.rs,oauth.rs,assets.rs,publish.rs,insights.rs,messaging.rs,whatsapp.rs,ads.rs,leadgen.rs,webhook.rs,probe.rs}
    adapters/connectors/jt_netgsm/src/{lib.rs,rest.rs,sms.rs,report.rs,inbox.rs,santral.rs,iys.rs,balance.rs,webhook.rs,probe.rs,rate.rs}
    adapters/connectors/jt_x/src/{lib.rs,oauth.rs,post.rs,media.rs,metrics.rs,probe.rs}
    adapters/jt_webhook/src/{lib.rs,meta.rs,netgsm.rs,raw.rs}
    adapters/jt_panel_http/src/routes/{connector.rs,events.rs,oauth_callback.rs}
    adapters/jt_mcp/src/tools/{connector.rs,events.rs}
    jt_testkit/src/mock_provider.rs                in-process axum mock with scripted responses
    jt_archtest/tests/connectors.rs                no reqwest in connector crates; fixed hosts exact; every connector crate reachable only via Egress
  bin/jeeta/src/{scheduler.rs,config.rs (+provider app env)}
  panel/src/pages/{ConnectPage.tsx, OAuthCallbackPage.tsx, EventsPage.tsx}, CapabilitiesPage (connect/probe/health)
```

---

### Task 1: Domain crate `jt_connector`

**Files:** create the crate (domain allowlist + `jt_tenancy`, `jt_capability`, `jt_ledger`), tests `tests/rules.rs`.

**Interfaces:**
- `pub enum Provider { Meta, Netgsm, X }` with `key()` (`"meta"|"netgsm"|"x"`) and `pub fn provider_for_kind(kind_key: &str) -> Option<Provider>` (meta: `instagram, facebook_page, whatsapp_cloud, instagram_dm, messenger, meta_ads, review_facebook`; netgsm: `sms_line, netgsm_pbx`; x: `x`).
- `pub enum ConnectorError { Auth { reason: String }, Permission { reason }, Throttle { retry_after: Option<Duration> }, Transient { reason }, Permanent { reason } }` (thiserror; `reason` never contains credentials: constructors run a redaction pass with `jt_ledger::REDACTED_KEYS` on JSON-looking text).
- `pub enum Credential { OAuth { access_token, refresh_token: Option<String>, expires_at: Option<OffsetDateTime>, scopes: Vec<String> }, PageToken { page_id, token }, WhatsAppCloud { phone_number_id, token, waba_id: Option<String> }, NetgsmSms { usercode, password, msgheader }, NetgsmPbx { username, password, trunk: Option<String>, pbxnum: Option<String> }, NetgsmIys { usercode, password, brand_code } }` — `Serialize/Deserialize` (for sealing only), masked `Debug`, `fn kind(&self) -> &'static str`, `fn expires_soon(&self, now, within: Duration) -> bool`.
- OAuth: `pub struct OAuthState { pub workspace_id, pub provider, pub kind_key: String, pub issued_at, pub nonce: [u8;16], pub pkce_verifier: Option<String> }` with `pub fn sign(&self, key: &[u8;32]) -> String` (base64url(payload) + "." + hex HMAC-SHA256) and `pub fn verify(token: &str, key, now) -> Result<OAuthState, OAuthError>` (TTL 10 min, constant-time compare; errors `Expired | BadSignature | Malformed`); `pub fn pkce_pair(random: [u8;48]) -> (verifier, challenge_s256)`.
- Webhook math: `pub fn meta_signature_ok(app_secret: &[u8], raw: &[u8], header: &str) -> bool` (`sha256=` + hex HMAC, constant-time); `pub fn netgsm_hook_token(seal_key: &[u8;32], workspace: WorkspaceId, purpose: &str) -> String` (hex HMAC-SHA256 over `"netgsm-hook:<ws>:<purpose>"`), `pub fn netgsm_token_ok(expected, given) -> bool` constant-time.
- Events: `pub struct InboundEvent { pub id: InboundEventId, pub workspace_id, pub provider, pub capability_id: Option<CapabilityId>, pub external_id: String, pub kind: EventKind /* Message | Status | LeadGen | CallEvent | Consent | Unknown(String) */, pub payload: serde_json::Value, pub received_at, pub processed_at: Option<_> }` + `pub fn dedupe_key(provider, external_id) -> String`.
- Health: `pub struct ProbeResult { pub ok: bool, pub latency_ms: u32, pub error: Option<ConnectorError>, pub facts: serde_json::Value /* non-secret facts to store in connector_public */ }` and `pub fn status_after_probe(prev: StoredStatus, r: &ProbeResult) -> StoredStatus` (ok → Verified; `Auth`/`Permission` → Unreachable; `Throttle`/`Transient` → unchanged; `Permanent` → Unreachable).

- [ ] Tests: `provider_for_every_connector_kind`, `state_round_trip_and_expiry_and_tamper` (Review Focus 4 math), `pkce_challenge_is_s256_base64url`, `meta_signature_constant_time_examples` (vector from a known app secret/body), `netgsm_token_matches_reference_vector`, `status_after_probe_table`, `credential_debug_is_masked`, `error_reason_is_redacted`.
- [ ] Commit `feat(connector): provider taxonomy, credentials, oauth state, webhook math and events`

---

### Task 2: Ports, migration 0005, repos, fakes

**Files:** `ports.rs`, `migrations/0005_connectors.{up,down}.sql`, `jt_pg/src/repos/{events.rs,oauth_pending.rs,probe_runs.rs}`, fakes.

**Interfaces:**
- SQL (tenant tables, FORCE RLS, composite FK to capabilities where referenced): `inbound_events(id uuid pk, workspace_id, provider text, capability_id uuid null, external_id text not null, kind text not null, payload jsonb not null, raw bytea null, received_at timestamptz not null, processed_at timestamptz null, unique (workspace_id, provider, external_id))` + index `(workspace_id, processed_at, received_at)`; `oauth_pending(id uuid pk, workspace_id, provider text, kind_key text, state_hash text unique, started_by uuid, assets_sealed bytea null, assets_public jsonb not null default '[]', expires_at timestamptz not null, created_at)`; `probe_runs(id uuid pk, workspace_id, capability_id uuid not null, at timestamptz, ok bool, error_kind text null, latency_ms int, facts jsonb)` + index `(capability_id, at desc)` + append-only trigger. Raw bodies: a scheduled job deletes `raw` older than 30 days (`update … set raw = null where received_at < now() - interval '30 days'` — the table itself is append-only except this column; implement as a `BEFORE UPDATE` trigger allowing only `raw`/`processed_at` changes).
- Ports: `InboundEventRepo { insert_if_new(InboundEvent, raw: Option<Vec<u8>>) -> Result<Option<InboundEventId>> (None = duplicate); list_pending(limit) ; mark_processed(id, at); purge_raw_before(cutoff) -> u64 }`, `OAuthPendingRepo { insert; find_by_state_hash; set_assets(id, sealed, public); delete(id); purge_expired(now) }`, `ProbeRunRepo { append(ProbeRun); latest(capability_id) -> Option; list(capability_id, limit) }`, `PlatformAppConfig` (read-only port implemented by the binary from env): `meta_app() -> Option<MetaApp { app_id, app_secret, verify_token, login_config_id: Option, whatsapp_config_id: Option }>`, `instagram_app()`, `x_app() -> Option<XApp { client_id, client_secret }>`, `public_base_url() -> Url`.
- `Connector` port family (in `jt_app::ports::connectors`): `#[async_trait] trait Connector { fn provider(&self) -> Provider; async fn probe(&self, cred: &Credential, public: &Value) -> ProbeResult; async fn refresh(&self, cred: &Credential) -> Result<Option<Credential>, ConnectorError>; }`; operation traits (implemented per provider where applicable; consumed by M2/M3): `SmsSender { send(cred, to, text, reference) -> Result<SendReceipt { provider_id }, ConnectorError> }`, `Publisher { publish(cred, public, PublishRequest) -> Result<PublishReceipt { external_id, url: Option }, _> }`, `InsightsReader { post_metrics(..); account_metrics(..) }`, `MessagingSender { send_text(cred, public, recipient_id, text) }`, `AdBudgetWriter { set_daily_budget(cred, entity_id, minor); list_adsets(..); insights(..) }`, `LeadGenFetcher { fetch(cred, leadgen_id) }`, `Telephony { click_to_call(cred, from_ext, to) ; hangup(..) }`, `ConsentSync { add(cred, rows) }`. `ConnectorRegistry { fn connector(&self, provider) -> Arc<dyn Connector>; fn sms(&self, provider) -> Option<Arc<dyn SmsSender>>; … }`. `OAuthProvider { fn authorize_url(&self, app, redirect, state, pkce_challenge: Option<&str>) -> Url; async fn exchange(&self, app, redirect, code, pkce_verifier) -> Result<Credential, ConnectorError>; async fn list_assets(&self, cred) -> Result<Vec<Asset { kind_key, external_id, name, credential: Credential, public: Value }>, ConnectorError>; }`.
- Fakes: in-memory repos; `ScriptedConnector` implementing all traits with scripted results; `ScriptedOAuth`.

- [ ] Tests: migrations round trip (23 tables), `duplicate_inbound_event_is_ignored` (Review Focus 2 at the repo), `oauth_pending_state_hash_is_unique_and_purgeable`, `probe_runs_append_only`, `raw_purge_touches_only_raw_column`, RLS visibility for the three tables, fakes contract tests.
- [ ] Commit `feat(pg): inbound events, oauth pending, probe runs and the connector ports`

---

### Task 3: Egress hardening — fixed hosts, DNS guard, tenant rebuild, plain-http exception

**Files:** `jt_outbound/src/{fixed_hosts.rs,dns_guard.rs,tenant_rebuild.rs,client.rs}`, tests.

**Interfaces:**
- `FIXED_HOSTS` filled exactly per Global Constraints; `Egress::new` validates and panics on a bad entry (existing).
- DNS guard: a custom `reqwest::dns::Resolve` that resolves via the system resolver and REFUSES addresses failing `validate_public_address` (same ranges as `validate_public_host`), unless the scope is a fixed connector host (provider hosts are trusted by name but still refused if they resolve to private space — fail closed) — `cfg(test)` loopback exception preserved.
- `pub fn allow_plain_http(scope: &EgressScope, host: &str, port: u16) -> bool`: only `Connector("netgsm")` + `crmsntrl.netgsm.com.tr:9111`.
- `pub async fn rebuild_tenant_hosts(egress: &Egress, uow: &dyn UnitOfWork) -> Result<RebuildReport { workspaces, hosts }, AppError>`: for every workspace (PlatformTx list) and every non-retired connector-reach capability, allow `connector_public["hosts"]` (validated public); called at boot by Task 11; `TenantHostRegistry` gains `rebuild_from(ws, hosts: Vec<String>)` (replace semantics).
- The DNS guard above is the resolution-time check that M1a's `public_host.rs` docs promise "with the first tenant-tier caller"; once it lands, update that module doc and the README egress note (M1a says no resolution-time check exists yet).
- **SMTP/IMAP socket guard (note for the M2 mail connector):** the DNS guard lives in the `reqwest` resolver, so it covers HTTP only. The mail connector (M2) opens raw TCP/TLS sockets to tenant-declared SMTP/IMAP hosts outside `reqwest`; it must resolve through the same `validate_public_address` check (one shared resolver function in `jt_outbound`, not a copy) and refuse a private answer before `connect`, with a test `mail_socket_refuses_a_public_name_resolving_to_private_space`. Record this as a Global Constraint of M2.

- [ ] Tests: `fixed_hosts_are_exactly_the_documented_set`, `dns_guard_refuses_a_public_name_resolving_to_private_space` (mock resolver), `plain_http_only_for_netsantral`, `rebuild_drops_retired_hosts_and_keeps_live_ones` (Review Focus 5), existing egress tests green.
- [ ] Commit `feat(outbound): provider hosts, dns guard, netsantral exception and tenant-host rebuild`

---

### Task 4: Connection use cases (OAuth, credentials, confirm assets, probe, retire hook)

**Files:** `jt_app/src/usecases/connector.rs`, catalog rows, tests.

**Interfaces** (all require `CapabilitiesManage` unless noted; strategy-Exempt; not status-exempt):
- `start_oauth(deps, ctx, StartOAuth { kind_key }) -> StartOut { authorize_url, pending_id, expires_at }`: provider from kind; platform app must be configured (`CONFLICT("provider app not configured")`); state signed with the workspace seal key (via `SecretBox`-derived HMAC key: add `SecretBox::hmac_key(ws) -> [u8;32]` to the port) carrying PKCE for X; inserts `oauth_pending`; ledger `connector.oauth_started {provider, kind_key}`.
- `complete_oauth(deps, CompleteOAuth { state, code, principal: &Principal }) -> PendingAssetsOut { pending_id, assets: Vec<AssetPublic> }` — panel-only (the callback route): verify state (TTL, signature, workspace = the principal's current workspace else `FORBIDDEN`; Review Focus 4), exchange code → credential, `list_assets`, seal the asset credentials into `oauth_pending.assets_sealed`, return public facts; a reused state → `FORBIDDEN` (pending row deleted after first use or on confirm); ledger `connector.oauth_completed {provider, assets: n}`.
- `confirm_assets(deps, ctx, ConfirmAssets { pending_id, selected: Vec<external_id> }) -> Vec<CapabilityOut>`: for each selected asset create a capability via `capabilities::declare`-equivalent internal path with `reach = Connector`, `external_id`, `connector_public` (name, scopes, expiry, hosts of the provider), sealed credential; duplicates (same kind+external_id live) → `CONFLICT`; then run `probe` on each; delete pending; ledger `connector.connected {kind_key, external_id}` per capability.
- `set_credentials(deps, ctx, SetCredentials { capability_id (existing Declared connector capability) | kind_key + name (create), credential: CredentialInput /* NetGSM shapes or a pasted Meta token */ }) -> CapabilityOut`: validate shape; seal; probe; ledger `connector.credentials_set {kind_key}` (never the values).
- `probe(deps, ctx, capability_id) -> ProbeOut { result, status }` (`WorkspaceRead` for agents — their check of the hands — and humans): open sealed credential, call `Connector::probe`, append `probe_runs`, apply `status_after_probe`, update `connector_public.health = {ok, at, latency_ms, error_kind}`, evidence `{text: "probe", refs: [run id]}`; on `Auth` → status Unreachable + `connector_public.reauth_required = true` (Review Focus 3); ledger `connector.probe {ok, error_kind?}` only when the status CHANGED.
- `health(deps, ctx) -> Vec<ConnectorHealth { capability_id, kind_key, name, status, last_probe_at, ok, error_kind, token_expires_at }>` (`WorkspaceRead`).
- `reconnect(deps, ctx, capability_id) -> StartOut` (OAuth kinds: new state bound to the existing capability; confirm replaces the sealed credential; NetGSM: use `set_credentials`).
- Retire hook: `capabilities::retire` already revokes hosts; additionally clears `connector_sealed` (`set_sealed(None)`) — add to the existing retire path.
- `CapabilityRepo::set_sealed` stamps `updated_at` (the row's `updated_at = at`, so the method takes the time: `set_sealed(id, sealed, at)`); M1a's version writes only `connector_sealed`, so a credential change is invisible in `updated_at`. Pg + fakes + the repo contract test.
- `work.pending` gains `ReconnectConnector { capability_id, name }` (status Unreachable with `reauth_required`) at priority 1.

Catalog rows (Exempt, not status-exempt): `connector.start_oauth` (`jeeta.connector.start_oauth`, `POST /api/connectors/oauth/start`, Write), `connector.complete_oauth` (panel_only, `GET /api/connectors/oauth/callback/{provider}`), `connector.confirm_assets` (`jeeta.connector.confirm_assets`, `POST /api/connectors/oauth/{pending_id}/confirm`, Write), `connector.set_credentials` (`jeeta.connector.set_credentials`, `POST /api/connectors/credentials`, Write), `connector.probe` (`jeeta.connector.probe`, `POST /api/connectors/{capability_id}/probe`, Write), `connector.health` (`jeeta.connector.health`, `GET /api/connectors/health`, Read), `connector.reconnect` (`jeeta.connector.reconnect`, `POST /api/connectors/{capability_id}/reconnect`, Write).

- [ ] Tests (fakes + ScriptedOAuth/ScriptedConnector): one per rule, incl. `state_cannot_be_reused_or_completed_by_another_workspace` (Review Focus 4), `probe_auth_failure_marks_unreachable_and_pending_lists_reconnect` (Review Focus 3), `confirm_seals_credentials_and_outputs_never_contain_them`, `set_credentials_rejects_malformed_shapes`, `retire_clears_sealed_config`, `set_sealed_stamps_updated_at`.
- [ ] Commit `feat(connector): oauth, credentials, asset confirmation, probes and health use cases`

---

### Task 4b: Edit use cases for capabilities and budget items

M1a can declare a capability and open a budget item but never edit them; connecting accounts (Task 4) makes renaming and re-capping routine. Same gates and conventions as M1a's capability use cases (lock first, ledger without secrets, both surfaces, strict bodies/args).

**Files:** `jt_app/src/usecases/{capabilities.rs,budget.rs}`, `jt_capability` validators, catalog rows, `jt_mcp/src/tools/{capabilities.rs,budget.rs}`, `jt_panel_http/src/routes/{capabilities.rs,budget.rs}`, panel pages, tests.

**Interfaces:**
- `capability.update(deps, ctx, id, UpdateCapability { name?, description?, external_id? })` (`CapabilitiesManage`): validated as at declaration; a retired capability `CONFLICT`; a changed `external_id` held by another live capability of the kind `CONFLICT`; ledger `capability.update {fields, name?, external_id?}` (the names of the changed fields, and the new `name` and `external_id` when they changed; never the description text); `jeeta.capability.update`, `PATCH /api/capabilities/{capability_id}`, Write.
- `budget.items.update(deps, ctx, id, UpdateBudgetItem { name?, cap?, period? })` (`BudgetManage`): kind and unit never change; a cap below what is already spent in the period is allowed (spend stays recorded, the item reads over cap); ledger `budget.items.update {name?, cap?, period?, previous: {...}}`; `jeeta.budget.items_update`, `PATCH /api/budget/items/{budget_item_id}`, Write.
- `budget.items.retire(deps, ctx, id, confirm)` (`BudgetManage`, `confirm: true` else `VALIDATION`): the item stops taking links and spend (`CONFLICT` "budget item is retired"), its links are removed in the same transaction, its spend history stays; needs a `retired_at` column (migration 0005 or later, reversible); ledger `budget.items.retire {links_removed}`; `jeeta.budget.items_retire`, `POST /api/budget/items/{budget_item_id}/retire`, Destructive (joins the `confirm` list of §4.4).

- [ ] Tests: `update_changes_only_the_named_fields_and_ledgers_them`, `update_refuses_a_retired_capability_and_a_taken_external_account`, `budget_item_update_keeps_kind_unit_and_spend`, `retired_budget_item_takes_no_links_or_spend`, twin parity for the three tools.
- [ ] Commit `feat(capabilities): edit capabilities and budget items; retire budget items`

---

### Task 5: Meta adapter (`jt_meta`)

**Files:** the crate; `tests/` with a mock Graph server and fixtures.

**Interfaces/behaviour (from the v1 map):**
- Graph base `https://graph.facebook.com/v19.0` (version from `MetaApp.graph_version`, default v19.0); every call with a user/page token adds `appsecret_proof = hex HMAC-SHA256(token, app_secret)` (also on `paging.next`); never throws on provider errors — maps `{code, type, error_subcode}` to `ConnectorError`: 401/code 190/`OAuthException`/subcodes 458,459,460,463,464,467 → `Auth`; codes 3,10,200,803 → `Permission`; 4,17,32,613 → `Throttle`; 5xx/timeouts → `Transient`; else `Permanent`.
- OAuth (Facebook Login): authorize `https://www.facebook.com/v19.0/dialog/oauth` with scopes for FACEBOOK-family kinds (`pages_show_list, pages_manage_posts, pages_read_engagement, business_management, pages_messaging, pages_manage_metadata, instagram_basic, instagram_manage_messages, instagram_content_publish, whatsapp_business_management, whatsapp_business_messaging, ads_read, read_insights, instagram_manage_insights`) or `config_id` when `login_config_id` is set; exchange `GET /oauth/access_token?client_id&client_secret&redirect_uri&code` then `?grant_type=fb_exchange_token` (long-lived). `list_assets`: pages (`/me/accounts?fields=id,name,access_token` → `facebook_page` + `messenger` assets with the Page token), IG business accounts (`/{page}?fields=instagram_business_account{id,username}` → `instagram` + `instagram_dm`), ad accounts (`/me/adaccounts` with `account_status==1` → `meta_ads`), WhatsApp numbers (`/me/businesses` → `/owned_whatsapp_business_accounts` → `/phone_numbers` → `whatsapp_cloud`).
- Instagram Login (kind `instagram` when the tenant chooses IG-only): authorize `https://www.instagram.com/oauth/authorize` scopes `instagram_business_basic, instagram_business_content_publish`; exchange `POST https://api.instagram.com/oauth/access_token` (strip trailing `#_`) then `GET graph.instagram.com/access_token?grant_type=ig_exchange_token`; refresh `GET graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token`; no appsecret_proof on `graph.instagram.com`.
- WhatsApp embedded signup completion: `exchange` with code → `POST /{waba}/subscribed_apps` (best effort) → `POST /{phone_number_id}/register {messaging_product:"whatsapp", pin:"000000"}` (best effort).
- Probe per kind: page → `GET /{page}?fields=id,name` + `GET /{page}/subscribed_apps`; instagram → `GET /{ig}?fields=id,username`; whatsapp → `GET /{phone_number_id}?fields=verified_name,quality_rating`; meta_ads → `GET /act_{id}?fields=id,name,account_status`; facts stored into `connector_public`.
- Page subscription on confirm: `POST /{page}/subscribed_apps?subscribed_fields=messages,message_echoes,messaging_postbacks,message_reactions,leadgen`.
- Operation traits: `Publisher` (FB feed/photos/videos, multi-photo attached_media, IG container → poll `status_code` ≤30×3s → `media_publish`; IG Login variant on graph.instagram.com), `InsightsReader` (post/page/media/account insights endpoints as mapped), `MessagingSender` (`POST /me/messages` with Page token; `messaging_type: RESPONSE`), `WhatsApp` send (`POST /{phone_number_id}/messages`), `LeadGenFetcher` (`GET /{leadgen_id}?fields=field_data,form_id,ad_id,campaign_id,campaign_name,created_time`), `AdBudgetWriter` (`GET /act_{id}/adsets?fields=…daily_budget,lifetime_budget`, `POST /{entity} {daily_budget: minor}` / `{status}`, `GET /act_{id}/insights?level=campaign&time_increment=1&limit=500` following `paging.next`).
- Webhook parsing (`webhook.rs`, pure): `object=whatsapp_business_account` → per change by `value.metadata.phone_number_id`; `object=page|instagram` → by `entry.id`; produce `InboundEvent`s: WhatsApp `messages[]` (text/button/interactive/referral) with `external_id = wamid`, `statuses[]` → `Status`; Messenger/IG `messaging[]` (`is_echo` → outbound echo kind; `mid`), `delivery.mids` → Status; `changes[field=leadgen]` → `LeadGen { leadgen_id }`. Routing key for the use case: `(provider, external account id)` → capability lookup by `external_id`.

- [ ] Tests (mock server; fixtures): OAuth exchange + long-lived; `list_assets` composes pages/IG/ads/WA; `appsecret_proof_present_on_every_call_including_paging`; error mapping table; probe facts; IG container polling; Messenger send body; WhatsApp send body; webhook parsing for each payload fixture; `webhook_signature_mismatch_is_rejected`.
- [ ] Commit `feat(meta): graph client, oauth, assets, probes, publish, insights, messaging, ads and webhook parsing`

---

### Task 6: NetGSM adapter (`jt_netgsm`)

**Behaviour (from the map):** REST v2 with HTTP Basic (`usercode:password`); `SmsSender`: `POST /sms/rest/v2/send {msgheader, messages:[{msg, no, referansID}], encoding, iysfilter}` → `jobid`; delivery reports `POST /sms/rest/v2/report {jobids ≤ 50}` (poll job in Task 10); inbox backup `GET /sms/rest/v2/inbox?startdate&stopdate` (ALWAYS with both dates; `ddMMyyyyHHmm` Turkish local time); balance probe `POST /balance {stip:3}`; msgheader check `GET /sms/rest/v2/msgheader`; `Telephony` via `http://crmsntrl.netgsm.com.tr:9111/{username}/{verb}?username&password&…` (`originate`, `linkup`, `hangup`; correlate by `crm_id`; `caller_record`/`called_record` flags only when the workspace policy allows recording); CDR `POST /netsantral/report {usercode,password,startdate,stopdate}`; `ConsentSync` İYS `POST /iys/add` (≤500 rows) / `/iys/search`; error codes `20,30,40,50,51,60,70,80,85,100` mapped (80 → `Throttle`; 30 → `Auth` with the "credentials or IP allowlist" hint; network/5xx → `Transient`); retry only when NO response arrived (never on an unparseable response — duplicate billing risk); per-account sliding-window `RateBudgeter` (report 60/min, inbox 2/min, İYS 10/min, blacklist 120/min, statistics 2/min); credential scrubbing in all error text. Webhook parsing (pure): MO payload `{mesaj, ceptel, aboneno, gorevid, tarih}` (object, array, or `{messages|data}`; cap 100) → `Message` events with `external_id = "netgsm-mo:<gorevid>"`; events hook (Inbound_call/Answer/Hangup/cdr) → `CallEvent`; İYS hook rows (ONAY/RET × MESAJ/ARAMA/EPOSTA) → `Consent`; voice/autocall reports → `Status`. Probe for `sms_line`: balance + msgheader approved; for `netgsm_pbx`: statistics or a cheap `queuestats`.

- [ ] Tests: request bodies and Basic auth; date formatting; error-code table; `no_retry_after_an_unparseable_response`; rate budgeter windows; MO/events/İYS parsing fixtures; probe facts.
- [ ] Commit `feat(netgsm): sms, reports, inbox, balance, netsantral, iys and webhook parsing`

---

### Task 7: X adapter (`jt_x`)

**Behaviour:** OAuth 2.0 authorization code + PKCE S256, confidential client: authorize `https://twitter.com/i/oauth2/authorize` scopes `tweet.read tweet.write users.read offline.access media.write`; token `POST https://api.twitter.com/2/oauth2/token` form + `Authorization: Basic b64(client_id:client_secret)` with `code, redirect_uri, client_id, code_verifier`; refresh with `refresh_token, client_id` (rotating refresh token → `Credential` replaced; compare-and-swap handled by the use case); account `GET /2/users/me` → `external_id`; `Publisher`: media upload `POST https://api.x.com/2/media/upload` multipart `{media, media_category: tweet_image}` (images ≤4, ≤5 MB each, fetched through Egress from the asset store URL — M3 supplies bytes), post `POST /2/tweets {text ≤280, media:{media_ids}}`; `InsightsReader`: `GET /2/tweets/{id}?tweet.fields=public_metrics`, `GET /2/users/me?user.fields=public_metrics`; 401 → `Auth`, 403 → `Permission`, 429 → `Throttle(retry_after from headers)`; probe = `users/me`.

- [ ] Tests: PKCE flow bodies; refresh rotation returns a new credential; post body; media upload multipart shape; error mapping incl. 429 retry-after; probe facts.
- [ ] Commit `feat(x): oauth with pkce, posting, media, metrics and probe`

---

### Task 8: Connection flows on both gates, panel connect UX, OAuth callback

**Files:** `jt_panel_http/src/routes/{connector.rs,oauth_callback.rs}`, `jt_mcp/src/tools/connector.rs`, panel `ConnectPage`/`OAuthCallbackPage`, Capabilities page "Bağla / Yeniden bağla / Probla" actions, health badges; `ConnectorRegistry` real implementation in the binary wiring the three adapters.

- OAuth callback route is public (no session required? NO: it REQUIRES the tenant session cookie — the state is bound to the workspace; the human who started the flow completes it in the same browser); returns the pending selection JSON and the panel shows a checkbox list of assets → `confirm_assets`.
- MCP `jeeta.connector.start_oauth` returns the URL for the agent to hand to the owner (the agent cannot complete OAuth); `jeeta.connector.set_credentials` lets the agent enter NetGSM credentials the owner gave it (ledger notes the agent did so).
- Twin parity: `connector.health`.

- [ ] Tests: HTTP `owner_connects_netgsm_by_credentials_and_probe_marks_verified` (mock provider), `oauth_round_trip_creates_capabilities_from_selected_assets` (ScriptedOAuth), `callback_with_foreign_state_is_forbidden` (Review Focus 4), MCP `agent_gets_an_authorize_url_but_cannot_complete`, panel smoke tests; parity.
- [ ] Commit `feat(connector): panel and MCP connection flows with the real provider registry`

---

### Task 9: Webhook gate (`jt_webhook`) and inbound events

**Files:** `jt_webhook/src/{lib.rs,meta.rs,netgsm.rs,raw.rs}`, `jt_app/src/usecases/{webhook.rs,events.rs}`, routes/tools for events, migration-free.

- Routes: `GET /hooks/meta` (hub.challenge echo when `hub.verify_token` matches), `POST /hooks/meta` (raw body ≤1 MB; signature check BEFORE anything; respond `200 EVENT_RECEIVED` immediately; spawn processing), `POST /hooks/netgsm/{workspace_id}/{token}/{purpose}` (`purpose ∈ mo|events|iys|voice-report|autocall-report`; token check; 202; synchronous dedupe+insert; 503 only when the insert fails so NetGSM redelivers). Processing: parse → for each event resolve the capability by `(provider, external account id)` across workspaces via a `PlatformRepos::capability_by_external(provider kinds, external_id)` lookup (platform-wide marker) → if no live capability → store under a platform "unrouted" table? NO: drop with a `warn!` and a metric counter (Review Focus 1; no tenant row may be written) → else `insert_if_new` in the tenant (dedupe; Review Focus 2) with raw body.
- Use cases: `events.pending(deps, ctx, limit, before) -> Vec<InboundEventOut>` (`WorkspaceRead`; `jeeta.events.pending`, `GET /api/events/pending`), `events.ack(deps, ctx, ids) -> u32` (`jeeta.events.ack`, `POST /api/events/ack`, Write; ledger `events.acked {n}`), `events.list(...)` recent incl. processed. M2/M3 will consume events into conversations/measurements; until then the agent can read them.
- `work.pending` gains `InboundEvents { count }` at priority 2 when unprocessed events exist.

- [ ] Tests: Meta GET verify; POST bad signature → 401 and nothing stored; valid WhatsApp message fixture → one event; replay → still one (Review Focus 2); event for an unknown account → nothing stored, warn (Review Focus 1); NetGSM MO with bad token → 404; good token → 202 + event; `netgsm_insert_failure_returns_503`; `events.pending`/`ack` on both gates; raw purge job.
- [ ] Commit `feat(webhook): signed intake for meta and netgsm with deduplicated inbound events`

---

### Task 10: Scheduler — token refresh, probes, NetGSM polls, raw purge

**Files:** `bin/jeeta/src/scheduler.rs`, `jt_app/src/usecases/jobs.rs`, tests.

- Jobs (tokio interval tasks, each under a Postgres advisory lock so a second instance does not double-run): `refresh_tokens` hourly (credentials with `expires_at` within 7 days or X always; rotate; failure `Auth` → Unreachable + `reauth_required` + ledger `connector.refresh_failed`), `probe_all` every 15 min for connector capabilities not probed in the last hour (bounded concurrency 4), `netgsm_dlr_poll` every minute (job ids from `SendReceipt`s recorded by M2 — in M1b the table `sms_jobs` does not exist yet; implement the job skeleton reading from an `OutboundJobRepo` port with a no-op fake; M2 fills), `netgsm_inbox_poll` hourly (2-hour window, both dates) producing events, `purge_raw_bodies` daily (30 days), `purge_oauth_pending` hourly.
- Boot: `rebuild_tenant_hosts` before serving.
- Config: `JEETA_JOBS_ENABLED` (default true), intervals overridable for tests.

- [ ] Tests: each job unit-tested with fakes (`refresh_marks_unreachable_on_auth_error`, `probe_all_skips_recent`, `inbox_poll_always_sends_both_dates`), advisory-lock test on pg (`second_runner_skips_while_first_holds`), boot rebuild test (Review Focus 5 end to end).
- [ ] Commit `feat(jobs): token refresh, probes, netgsm polling and purges under advisory locks`

---

### Task 11: Binary wiring, config, archtests, docs, smoke

- Config: `JEETA_META_APP_ID/SECRET`, `JEETA_META_VERIFY_TOKEN`, `JEETA_META_LOGIN_CONFIG_ID`, `JEETA_META_WHATSAPP_CONFIG_ID`, `JEETA_META_GRAPH_VERSION`, `JEETA_INSTAGRAM_APP_ID/SECRET`, `JEETA_X_CLIENT_ID/SECRET`, `JEETA_PUBLIC_BASE_URL` (for redirect URIs and webhook URLs; required when any provider app is configured); provider apps optional — when absent the related kinds answer `CONFLICT("provider app not configured")` and the panel says so.
- Archtests: connector crates have no `reqwest`; `FIXED_HOSTS` equals the documented set; every connector crate's outbound calls go through `Egress` (grep for `reqwest::Client` outside jt_outbound → none); exempt prefixes `connector.`, `events.`; tool count (47 + 7 + 3 = 57).
- README: connecting accounts (OAuth needs the platform apps; redirect URIs to register: `${PUBLIC_BASE_URL}/api/connectors/oauth/callback/{meta|instagram|x}`; webhook URLs to register: `${PUBLIC_BASE_URL}/hooks/meta`, NetGSM hook URL pattern with the per-workspace token shown in the panel), probes, health, reconnect, events for agents, jobs and their intervals, the Netsantral plain-http exception, the Meta app review note (spec §14: sahibin işi).
- Spec amendments "(M1b uygulamasında kesinleşti)": §4.3 fixed hosts list; §4.4 webhook kapısı details; §6.4 probe semantics; §11 raw body retention/purge; events as the hand-off to M2/M3.
- Smoke: boot with mock providers? Not possible live; record a local smoke with the in-process mocks via tests, and a manual `jeeta serve` with NetGSM credentials ONLY if the owner supplies a sandbox (otherwise state so).

- [ ] Commit `docs(rust): M1b connectors, webhooks, jobs and provider configuration`; push; draft PR.

---

## Self-review notes

- Coverage of §13 M1 row's connector half: OAuth flows (T4/T5/T7/T8), Meta kinds (T5), NetGSM SMS + santral (T6), X (T7), B10 (many instances: one capability per asset; two NetGSM lines are two capabilities with distinct external ids = msgheader/username — T4 confirm dedupe uses external_id).
- Spec §11 webhook rules: verify, dedupe, raw retention, async (T9, T2, T10). §6.4 probe (T4). §4.3 two-tier egress (T3).
- Review Focus pinned: 1→T9, 2→T2/T9, 3→T4/T10, 4→T1/T4/T8, 5→T3/T10.
- Rulings embedded to ledger when executed: plain-http exception for Netsantral; OAuth callback requires the tenant session; unrouted webhook events are dropped with a warning (never stored cross-tenant); operation traits delivered but their use cases are M2/M3; platform OAuth apps are platform config.
