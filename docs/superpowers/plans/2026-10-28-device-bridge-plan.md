# Device bridge — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** an agent connected to Jeeta controls a physical Android phone through a Rust bridge on the PC the phone
is plugged into, with iOS added later behind the same contract.

**Architecture:** spec `docs/superpowers/specs/2026-10-28-device-bridge-design.md` (read it first). Server:
pure domain crate `jt_devices`, shared wire crate `jt_device_protocol`, a `device_commands` queue on a bridge
kernel extracted from the voice bridge, MCP tools for agents, panel-only routes for the bridge. Client: binary
crate `jeeta-device-bridge` with a `PhoneDriver` trait and an `AndroidAdbDriver`.

**Tech stack:** Rust (axum, sqlx/Postgres with FORCE RLS, tokio), React panel (vitest), adb.

**Global constraints (same as every Rust plan here):** hexagonal boundaries (`jt_archtest`); catalog rows,
handlers, permissions, status gates and exact-set tests change together (`crates/jt_app/tests/catalog.rs` pins
the row count, 157 before this plan); migrations are repeatable `up`/`down` pairs, ENABLE + FORCE RLS on every
tenant table (`crates/jt_archtest/tests/sql_scoping.rs`); English identifiers, TR + EN panel copy with parity;
`tracing` never carries command args, typed text, observations, phone numbers or file contents (the ledger does
carry the full command — owner, spec §5.5); no deploy or push to shared branches from a worker. Rust crates that
depend on `jt_pg` do not build tests on Windows: CI on Linux is the check; `jt_app` clippy locally needs
`--features tokio/time`. The bridge crate must build and test on Windows.

**Per-task loop:** write the named failing tests → run them (red) → implement → run the crate's tests (green) →
`cargo fmt --all -- --check` and `cargo clippy -p <crate> --all-targets -- -D warnings` → commit. Once per PR:
`cargo test --locked --workspace` in CI, `pnpm --dir panel test` when the panel is touched.

**Base and branches:** every task branches from the latest `origin/feat/rust-panel-money-inputs` and lands by PR
into it. D0 waits for voice V1-T2 (agent call session) to merge, since it reshapes the same bridge code.

---

## File structure

| Path | New/changed | Responsibility |
|---|---|---|
| `rust/crates/domain/jt_devices/src/{lib,command,lifecycle,observation,features}.rs` | new | command vocabulary + validation, lifecycle, observation model, feature names (pure) |
| `rust/crates/domain/jt_device_protocol/src/lib.rs` | new | wire types server ⇄ bridge (pure, versioned) |
| `rust/crates/jt_app/src/usecases/bridges/{mod,kernel}.rs` | new (D0) | shared register/heartbeat/lease/redeliver/signals/health for every bridge |
| `rust/crates/jt_app/src/usecases/calls/bridge.rs` | changed (D0) | voice bridge on the kernel, behaviour unchanged |
| `rust/crates/jt_app/src/usecases/devices/{mod,bridge,agent}.rs` | new | bridge use cases; agent use cases |
| `rust/crates/jt_app/src/ports/devices.rs` | new | `DeviceCommandRepo` port |
| `rust/crates/adapters/jt_pg/src/repos/devices.rs` | new | Postgres impl |
| `rust/crates/jt_testkit/src/fakes/devices.rs` | new | in-memory impl for tests |
| `rust/migrations/00NN_device_bridge.{up,down}.sql` | new | `device_commands`, role backfill (NN = next free) |
| `rust/crates/domain/jt_tenancy/src/role.rs` | changed | `devices.work`, `devices.manage`, `devices.bridge` |
| `rust/crates/jt_app/src/catalog.rs` | changed | rows (§D1-T5, D1-T6) |
| `rust/crates/adapters/jt_panel_http/src/routes/device_bridge.rs` + `routes/devices.rs` | new | routes |
| `rust/crates/adapters/jt_mcp/src/tools/devices.rs` | new | MCP tools |
| `rust/crates/jt_app/src/usecases/jobs.rs` | changed | `DeviceBridgeHealth` (or kernel's shared health job), `DeviceCommandExpiry`, `DeviceFilePurge` |
| `rust/bridge/device/{Cargo.toml,src/{main,config,client,loop}.rs,src/driver/{mod,android/{mod,adb,observe,commands}}.rs}` | new | the PC-side program |
| `rust/bridge/device/tests/{fixtures/*.xml,android_driver.rs,loop.rs}` | new | driver + loop tests |
| `rust/panel/src/pages/capabilities/PhoneCard.tsx` (+ test), `src/api/devices.ts`, i18n | new/changed | panel |
| `docs/operations/device-bridge.md` | new | install, pairing, ADBKeyBoard, troubleshooting |
| `.github/workflows/rust.yml` | changed | Windows build of the bridge |

---

## Contracts (defined in D1-T1/T2; every later task uses exactly these names)

```rust
// jt_devices::command
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DeviceCommand {
    Observe { #[serde(default)] screenshot: bool },
    Tap { x: u32, y: u32 },
    TapOn { #[serde(flatten)] target: ElementTarget, #[serde(default)] exact: bool },
    LongPress { x: u32, y: u32, ms: u32 },
    Swipe { x1: u32, y1: u32, x2: u32, y2: u32, ms: u32 },
    Text { value: String },
    Key { key: DeviceKey },
    OpenUrl { url: String },
    LaunchApp { app_id: String },
    Shell { argv: Vec<String> },          // the bridge quotes each argument for the device shell
    PushFile { file_id: Uuid, dest: String },
    PullFile { path: String },
    Screenshot {},                        // an EMPTY STRUCT variant: wire form {"kind":"screenshot"}, extra fields refused
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ElementTarget { Text(String), Id(String), Desc(String) }
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceKey { Back, Home, Enter, AppSwitch, Delete, VolumeUp, VolumeDown, Power }
impl DeviceKey {
    pub const ALL: &[DeviceKey];                       // declaration order
    pub fn key(self) -> &'static str;                  // the serde name, e.g. "app_switch"
    pub fn from_key(key: &str) -> Option<DeviceKey>;
}
pub const MAX_TEXT_CHARS: usize = 4000;                // a text value, and a tap_on target
pub const MAX_SWIPE_MS: u32 = 5000;
pub const MAX_LONG_PRESS_MS: u32 = 10_000;
pub const MAX_SHELL_ARGS: usize = 64;
pub const MAX_ARG_CHARS: usize = 4096;
pub const MAX_SHELL_TOTAL_CHARS: usize = 16_384;       // all shell args, plus one separator per arg
pub const MAX_URL_CHARS: usize = 8192;
pub const MAX_APP_ID_CHARS: usize = 256;
pub const MAX_PATH_CHARS: usize = 4096;                // push_file dest, pull_file path
impl DeviceCommand {
    pub const KINDS: &[&str];                          // the 13 wire tags, also the feature names for the kinds
    pub fn kind(&self) -> &'static str;                // "observe", "tap", "tap_on", … "screenshot"
    // Bounds and well-formedness only (no NUL in any string that becomes a process argument:
    // shell args, url, app_id, dest, path, target, text); NO access policy (spec §1).
    pub fn validate(&self) -> Result<(), CommandError>;
}
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum CommandError { #[error("{field}: {reason}")] Invalid { field: &'static str, reason: &'static str } }

// jt_devices::lifecycle
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandStatus { Queued, Leased, Done, Failed, Expired, Canceled }
impl CommandStatus {
    pub const ALL: &[CommandStatus];                   // declaration order
    pub fn key(self) -> &'static str;                  // the serde name, e.g. "leased"
    pub fn from_key(key: &str) -> Option<CommandStatus>;
    pub fn is_final(self) -> bool;                     // Done|Failed|Expired|Canceled = never leased again, nobody waits;
                                                       // NOT "immutable": see the late-result rule below
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailReason { DeviceOffline, ElementNotFound, UnicodeUnsupported, UnsupportedOnPlatform,
    UnsupportedByBridge, AdbError, ScreenBusy, Timeout, BridgeError,
    #[serde(other)] Unknown }                          // last: a newer bridge's new reason must not reject a batch
impl FailReason {
    pub const ALL: &[FailReason];                      // includes Unknown
    pub fn key(self) -> &'static str;                  // the serde name; Unknown = "unknown"
    pub fn from_key(key: &str) -> Option<FailReason>;  // a name no variant owns is None (only the wire is forgiving)
}
pub const REDELIVER_AFTER: Duration = Duration::seconds(10);
pub const DEFAULT_EXPIRES_IN: Duration = Duration::minutes(5);
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleEvent { Leased, Done, Failed, Expired, Canceled }
impl LifecycleEvent { pub const ALL: &[LifecycleEvent]; pub fn key(self) -> &'static str; }
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("a {} command cannot be {}", .from.key(), .event.key())]   // wire names: "a done command cannot be canceled"
pub struct LifecycleError { pub from: CommandStatus, pub event: LifecycleEvent }
pub fn next_status(current: CommandStatus, event: LifecycleEvent, ever_leased: bool)
    -> Result<CommandStatus, LifecycleError>;      // ever_leased = the row's leased_at is set
// Rules of next_status:
//   Queued  -> Leased | Failed | Expired | Canceled          (Queued -> Done is Err: a command finishes only after a lease)
//   Leased  -> Leased (redelivery) | Done | Failed | Expired | Canceled
//   Expired -> Done | Failed     \  ONLY if ever_leased. A bridge's result is the truth even after the fact: it
//   Canceled -> Done | Failed    /  REPLACES the status; such a command is never leased again. A command that
//                                   ended in the queue (never leased) refuses any result.
//   Done, Failed: nothing (a recorded result is not replaced by another)

// jt_devices::observation
pub const MAX_ELEMENTS: usize = 300;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Observation { pub screen: Screen, pub foreground_app: Option<String>,
    pub elements: Vec<Element>, pub truncated: bool, pub screenshot_file_id: Option<Uuid> }
impl Observation {
    // Applies MAX_ELEMENTS (truncate + truncated = true); a screen within the cap is untouched and an
    // already-set `truncated` stays set. Both drivers end an observation with this.
    pub fn cap_elements(&mut self);
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Screen { pub w: u32, pub h: u32, pub rotation: u16 }
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Element { pub text: Option<String>, pub id: Option<String>, pub desc: Option<String>,
    pub class: Option<String>, pub bounds: [u32; 4], pub tap_point: [u32; 2],
    pub clickable: bool, pub editable: bool, pub focused: bool }

// jt_devices::features
pub const TEXT_UNICODE: &str = "text.unicode";   // a feature beyond the command kinds
pub fn supports(features: &[String], cmd: &DeviceCommand) -> bool; // kind listed; Text with non-ASCII also needs TEXT_UNICODE
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Platform { Android, Ios }
impl Platform {
    pub const ALL: &[Platform];
    pub fn key(self) -> &'static str;                  // "android" | "ios"
    pub fn from_key(key: &str) -> Option<Platform>;
}

// jt_device_protocol (PROTOCOL_VERSION = 1) -- final, as built. Re-exports from jt_devices: DeviceCommand, DeviceKey,
// ElementTarget, Element, Observation, Screen, Platform, FailReason, CommandError, supports, TEXT_UNICODE,
// MAX_ELEMENTS, MAX_TEXT_CHARS. serde_json is a normal dependency (decode_lenient).
pub const PROTOCOL_VERSION: u32 = 1;      pub const HEARTBEAT_S: u32 = 15;        pub const MAX_WAIT_S: u32 = 25;
pub const MAX_COMMANDS: u32 = 20;         pub const MAX_RESULTS: usize = 100;     pub const MAX_DETAIL_CHARS: usize = 300;
pub const MAX_OUTPUT_BYTES: usize = 65_536;   // per shell stream
pub const MAX_RESULTS_BODY_BYTES: usize = 2 * 1024 * 1024;   // the results route's body limit; the bridge splits batches
                                                             // by serialized size to stay under it (D1-T5 sets DefaultBodyLimit)
pub const MAX_ID_CHARS: usize = 128;      // bridge_id, serial, model, os_version
pub const MAX_VERSION_CHARS: usize = 64;  pub const MAX_PHONES: usize = 16;
pub const MAX_FEATURES: usize = 64;       pub const MAX_FEATURE_CHARS: usize = 64;   pub const MAX_SCREEN_PX: u32 = 20_000;

// `RegisterIn` and `PhoneReport` do NOT use deny_unknown_fields (the first register goes out before the bridge knows the
// server's protocol: a newer bridge's extra optional fields are ignored). Every other struct/enum here does.
// Observation / Screen / Element (jt_devices) also accept unknown fields.
// Derives on every struct: Clone, Debug, PartialEq, Serialize, Deserialize (LeasedCommand's Debug is manual and masks
// download_url). `time::serde::rfc3339` for timestamps.
pub struct RegisterIn { pub bridge_id: String, pub version: String, pub protocol: u32, pub phones: Vec<PhoneReport> }
pub struct PhoneReport { pub platform: Platform, pub serial: String, pub model: Option<String>,
    pub os_version: Option<String>, pub screen: Option<Screen>, pub features: Vec<String> }
pub struct RegisterOut { pub phones: Vec<RegisteredPhone>, #[serde(default)] pub refused: Vec<RefusedPhone>,
    pub heartbeat_s: u32, pub max_wait_s: u32, pub protocol: u32 }      // the SERVER's protocol; later bodies shaped to the bridge's
pub struct RegisteredPhone { pub serial: String, pub capability_id: Uuid }
pub struct RefusedPhone { pub platform: Platform, pub serial: String, pub reason: String }   // not registered, and why
pub struct CommandsQuery { pub wait_s: u32, pub limit: u32 }
pub struct LeasedCommand { pub id: Uuid, pub capability_id: Uuid, pub serial: String, pub command: DeviceCommand,
    pub expires_at: OffsetDateTime /* rfc3339; the bridge never judges it by its own clock */,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub download_url: Option<String> }
pub struct CommandsOut { pub commands: Vec<LeasedCommand> }
pub struct ResultIn { pub command_id: Uuid, pub outcome: Outcome, pub duration_ms: u32 }
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum Outcome { Done { result: CommandResult }, Failed { reason: FailReason, detail: String } }
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CommandResult { Observation(Observation), Done {} /* empty struct variant: refuses unknown fields */,
    Shell { exit_code: i32, stdout: String, stderr: String, #[serde(default)] truncated: bool },
    File { file_id: Uuid } }
pub struct ResultsIn { pub results: Vec<ResultIn> }          // 1..=100, and <= MAX_RESULTS_BODY_BYTES serialized
pub struct ResultsOut { pub applied: u32, pub duplicates: u32, pub unknown: u32 }   // sums to results.len()
pub struct FileOut { pub file_id: Uuid }

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ProtocolError { #[error("{field}: {reason}")] Invalid { field: &'static str, reason: &'static str } }
impl ProtocolError { pub fn field(&self) -> &'static str; }
// Server-side validation (what the bridge sent):
impl RegisterIn   { pub fn validate(&self) -> Result<(), ProtocolError>; }  // the BODY only: protocol >= 1, bridge_id, version,
                                                                              // <= 16 phones, no serial twice (serial alone: the
                                                                              // bridge routes by serial)
impl PhoneReport  { pub fn validate(&self) -> Result<(), ProtocolError>; }  // serial, model/os_version (<= 128, no NUL, may be
                                                                              // blank), screen (sides 1..=20_000, rotation in
                                                                              // {0,90,180,270}), features. A phone that fails is NOT
                                                                              // registered and is listed in RegisterOut.refused;
                                                                              // the heartbeat itself is not refused.
impl ResultsIn    { pub fn validate(&self) -> Result<(), ProtocolError>; }  // 1..=100; command_id once; no NUL in detail/stdout/
                                                                              // stderr/observation strings; detail <= 300 chars;
                                                                              // streams <= 65_536 bytes; observation: <= 300
                                                                              // elements, screen as above, strings <= 4000 chars
impl CommandsQuery { pub fn clamped(self) -> CommandsQuery; }               // wait_s 0..=25, limit 1..=20
impl RegisterOut  { pub fn new(phones: Vec<RegisteredPhone>, refused: Vec<RefusedPhone>) -> RegisterOut; }
// Constructors so the bridge builds valid results by construction:
impl Outcome       { pub fn failed(reason: FailReason, detail: &str) -> Outcome; }                 // NUL -> U+FFFD, <= 300 chars
impl CommandResult { pub fn shell(exit_code: i32, stdout: &[u8], stderr: &[u8]) -> CommandResult; } // lossy UTF-8, NUL -> U+FFFD,
                                                                              // each stream cut on a char boundary at 65_536 bytes,
                                                                              // `truncated` set when either was cut
// A poll is decoded command by command so one unreadable command does not poison the rest; the bridge fails each
// unreadable one by id with FailReason::UnsupportedByBridge:
impl CommandsOut   { pub fn decode_lenient(value: serde_json::Value) -> (Vec<LeasedCommand>, Vec<(Uuid, String)>); }
```

Rules of the vocabulary (written in the `jt_devices` crate docs too):
- **Growing it.** A new command kind needs a feature name (a bridge reports what it runs, and a command is queued
  only for a bridge that lists its kind). A new field on an existing kind needs a feature name too, and is
  `#[serde(default, skip_serializing_if = ...)]`, so an older bridge never sees it. A new VALUE of an existing enum
  field (a new `DeviceKey` or `ElementTarget` variant) counts as a new field: it needs a feature name (e.g.
  `key.camera`) that `supports` checks. A new `FailReason` needs nothing: an older reader takes it as `Unknown`. A new
  `Platform` needs a protocol bump (it is a stored key: no `Unknown` variant). Register is tolerant (unknown fields
  ignored); after it, each side sends only what the lower protocol defines.
- **Logging.** Log `DeviceCommand::kind()` and counts, never the `{:?}` of a command or an observation (typed text,
  shell arguments and screen text are in them). A failure `detail` can carry on-screen labels. `reqwest` errors carry
  the request URL (a signed download address): the bridge uses `without_url()` before logging one.
- **A tagged variant without fields is an empty struct variant** (`Screenshot {}`): serde ignores unknown fields on a
  unit variant of a tagged enum, so `deny_unknown_fields` would not hold. (`CommandResult::Done {}` is one.)
- **A refused results batch (422) is refused for good**: the bridge must not retry it as it is. It builds results with
  `Outcome::failed` / `CommandResult::shell` and `Observation::cap_elements`, so what it sends is valid by construction.

---

## D0 — bridge kernel (after V1-T2 merges)

### Task D0-T1: extract `usecases::bridges` from the voice bridge

**Files:** create `rust/crates/jt_app/src/usecases/bridges/{mod.rs,kernel.rs}`; modify
`rust/crates/jt_app/src/usecases/calls/bridge.rs`, `usecases/mod.rs`, `usecases/jobs.rs` (health job calls the
kernel); test `rust/crates/jt_app/tests/bridges_kernel.rs`.

**Interface:**
```rust
pub struct BridgeSpec {
    pub component: &'static str,           // "voice_bridge" / "device_bridge"
    pub permission: Permission,            // CallsBridge / DevicesBridge
    pub heartbeat_s: u32,                  // 15
    pub stale_after: Duration,             // 60 s
    pub unreachable_after: Duration,       // 10 min
    pub online_action: &'static str,       // "calls.bridge.online" / "devices.bridge.online"
    pub offline_action: &'static str,
    pub offline_work: WorkKind,            // VoiceBridgeOffline / DeviceBridgeOffline
}
pub fn ctx_for(spec: &BridgeSpec, p: &AgentPrincipal, now: OffsetDateTime) -> Ctx;     // exact-set key check
pub fn require_bridge(spec: &BridgeSpec, ctx: &Ctx) -> Result<(), AppError>;          // FORBIDDEN bridge_key_only
pub async fn heartbeat(d: &Deps, ctx: &Ctx, spec: &BridgeSpec, caps: &[CapabilityId]) -> Result<(), AppError>;
pub async fn mark_unreachable(d: &Deps, spec: &BridgeSpec, kind_key: &str, now: OffsetDateTime) -> JobReport;
pub async fn wait_for<T>(signals: &dyn BridgeSignals, key: SignalKey, wait: StdDuration,
    mut poll: impl FnMut() -> BoxFuture<'_, Result<Option<T>, AppError>>) -> Result<Option<T>, AppError>;
```
`BridgeSignals` is V1-T2's `CallSignals` generalized to a key `{workspace_id, topic}`; keep V1-T2's in-memory
impl and rename (or wrap) it — do not keep two registries.

- [ ] **Tests first:** `bridges_kernel.rs::{exact_permission_set_only, other_permission_refused, heartbeat_verifies_and_merges_facts, stale_then_unreachable_by_clock, online_after_unreachable_writes_ledger, wait_for_wakes_on_signal, wait_for_times_out_within_wait_plus_one}`.
- [ ] **Run:** CI (`jt_app` tests need Postgres); locally `cargo check -p jt_app --features tokio/time`.
- [ ] **Implement** by moving code out of `calls/bridge.rs`; `calls/bridge.rs` keeps only voice-specific parts (facts shape, events reduce).
- [ ] **Gate:** every existing `jt_app/tests/calls_bridge.rs` and `calls_session.rs` test passes **unchanged** (no edits to those files in this PR).
- [ ] **Commit** `refactor(bridges): one kernel for every bridge; the voice bridge on it`.

**Acceptance:** voice behaviour identical (its tests unedited and green); the kernel has no `calls` import.
**Risk:** medium (moving live code); mitigated by the unedited-tests gate.

---

## D1 — server

### Task D1-T1: `jt_devices` domain crate

**Files:** create `rust/crates/domain/jt_devices/{Cargo.toml,src/{lib,command,lifecycle,observation,features}.rs,tests/devices.rs}`; add to `rust/Cargo.toml` members; register in `jt_archtest` dependency rules (pure domain: `serde`, `serde_json`, `time`, `uuid`, `thiserror` only).

- [ ] **Tests first (`tests/devices.rs`):**
  - `every_kind_round_trips_as_tagged_json` — each variant `serde_json::to_value` → `from_value` equality; `Screenshot` serializes as `{"kind":"screenshot"}`; `TapOn` as `{"kind":"tap_on","text":"Gönder","exact":false}`.
  - `unknown_kind_and_unknown_field_refused`.
  - `bounds_are_checked` — `Text` > 4000 chars, `Swipe.ms` 0 or > 5000, `LongPress.ms` > 10 000, `Shell.argv` empty or > 64 or an arg > 4096 chars, `LaunchApp.app_id`/`OpenUrl.url` empty → `CommandError::Invalid` with the field name.
  - `no_access_policy_in_validation` — `Shell { argv: ["rm","-rf","/sdcard/x"] }`, `OpenUrl { url: "intent://…" }` validate `Ok` (spec §1: no restrictions now).
  - `lifecycle_transitions` — Queued→Leased→Done ok; Leased→Leased ok (redelivery); Done→anything `Err`; Queued→Expired ok; Leased→Expired ok.
  - `supports_needs_kind_and_unicode_feature` — `Text{"merhaba"}` with `["text"]` ok; `Text{"Ayşe"}` needs `"text.unicode"`; `Shell` without `"shell"` false.
- [ ] Run `cargo test -p jt_devices` (builds on Windows) → red, implement, green.
- [ ] fmt + clippy; **commit** `feat(devices): the device command vocabulary`.

### Task D1-T2: `jt_device_protocol` crate

**Files:** create `rust/crates/domain/jt_device_protocol/{Cargo.toml,src/lib.rs,tests/protocol.rs}`; workspace member; archtest rule (depends on `jt_devices`, `serde`, `time`, `uuid` only).

- [ ] **Tests first (`tests/protocol.rs`, built):** `register_round_trip`, `register_out_carries_server_protocol`,
  `register_out_says_why_a_phone_was_not_registered`, `leased_command_round_trip_with_rfc3339`,
  `leased_command_debug_masks_the_download_url`, `decode_lenient_*`, `outcome_*`, `unknown_fail_reason_reads_as_unknown`,
  `results_batch_limit_constant_is_100`, `protocol_version_is_1`, `unknown_fields_refused`,
  `register_ignores_unknown_fields`, `observation_ignores_unknown_fields`, `register_validation`,
  `a_phones_own_faults_do_not_refuse_the_register_body`, `phone_validation`, `results_validation`,
  `observation_results_are_bounded`, `failed_constructor_is_valid_by_construction`,
  `shell_constructor_is_valid_by_construction`, `commands_query_is_clamped`.
- [ ] `cargo test -p jt_device_protocol` red → implement → green; fmt + clippy; **commit**.
- Built as `f9f9f3fe`, `a1ff64aa` and `55143291` (review fixes); the archtest rule allows `jt_devices`, `serde`,
  `serde_json`, `time`, `uuid`, `thiserror` for this crate.

### Task D1-T3: permissions + migration

**Files:** `rust/crates/domain/jt_tenancy/src/role.rs` (add `DevicesWork` `"devices.work"`, `DevicesManage` `"devices.manage"`, `DevicesBridge` `"devices.bridge"`; owner + manager get work+manage+bridge — bridge only so they can issue a bridge key, as `calls.bridge`; `rep` none); `rust/migrations/00NN_device_bridge.{up,down}.sql`; pins in `jt_archtest`/`jt_app/tests` that list permissions, tables and migrations.

```sql
create table if not exists device_commands (
    id uuid primary key,
    workspace_id uuid not null references workspaces(id),
    capability_id uuid not null,
    seq bigint generated always as identity,
    kind text not null,
    payload jsonb not null,
    status text not null check (status in ('queued','leased','done','failed','expired','canceled')),
    attempts int not null default 0,
    leased_at timestamptz,
    expires_at timestamptz not null,
    result jsonb,
    reason text,
    requested_by jsonb not null,
    created_at timestamptz not null,
    done_at timestamptz,
    foreign key (workspace_id, capability_id) references capabilities(workspace_id, id)
);
create index if not exists device_commands_queue on device_commands (workspace_id, capability_id, status, seq);
alter table device_commands enable row level security;
alter table device_commands force row level security;
-- policy device_commands_ws exactly as call_bridge_events_ws in 0016_voice_bridge.up.sql
-- role backfill exactly as 0016's calls.bridge backfill, for the three new keys
```
(Check `capabilities` has the `(workspace_id, id)` unique key the other tenant tables reference; copy 0016's
idempotent `do $$ … $$` guards. `down` drops the table and removes only the three keys.)

- [ ] **Tests first:** extend the pins (`sql_scoping` sees the new table with FORCE RLS; the migration list includes `00NN`; role permission lists include the three keys; `migration_is_repeatable` for 00NN).
- [ ] CI red → implement → green; **commit** `feat(devices): device_commands and the devices permissions`.

### Task D1-T4: `DeviceCommandRepo` port, Postgres and fake

**Files:** `rust/crates/jt_app/src/ports/devices.rs`, `ports/mod.rs` (TenantRepos accessor `device_commands()`); `rust/crates/adapters/jt_pg/src/repos/devices.rs`; `rust/crates/jt_testkit/src/fakes/devices.rs`; contract tests `rust/crates/jt_testkit/src/devices_contract.rs` run against both (pattern: `inbox_contract.rs`).

```rust
#[async_trait]
pub trait DeviceCommandRepo: Send {
    async fn enqueue(&mut self, row: NewDeviceCommand) -> Result<DeviceCommandRow, AppError>;
    async fn lease(&mut self, caps: &[CapabilityId], now: OffsetDateTime, limit: u32) -> Result<Vec<DeviceCommandRow>, AppError>; // queued, or leased and leased_at <= now-10s; not expired; seq order; sets leased, attempts+1
    async fn finish(&mut self, id: Uuid, outcome: Finish, now: OffsetDateTime) -> Result<FinishOutcome, AppError>;
    // A bridge's result, through jt_devices::next_status(status, event, leased_at.is_some()):
    //   Applied   - a leased command becomes done/failed; or a LATE result for an expired/canceled command that
    //               was leased (leased_at not null) REPLACES that status
    //   Duplicate - only a done/failed row (a result is already recorded)
    //   Unknown   - no such command in this workspace, or a result for a command that was never leased
    //               (leased_at null: queued, or expired/canceled in the queue): refused, nothing changes
    async fn expire_due(&mut self, now: OffsetDateTime) -> Result<u32, AppError>;
    async fn get(&mut self, id: Uuid) -> Result<Option<DeviceCommandRow>, AppError>;
    async fn list(&mut self, cap: CapabilityId, limit: u32) -> Result<Vec<DeviceCommandRow>, AppError>;
}
```
- [ ] **Contract tests first:** `lease_returns_oldest_first`, `lease_skips_fresh_lease_and_redelivers_after_10s`, `lease_never_returns_expired`, `finish_is_idempotent` (a second result for a done/failed row is `Duplicate`), `finish_unknown_id`, `finish_replaces_expired_after_lease`, `finish_refuses_result_for_never_leased`, `expire_due_marks_only_unleased_past_expiry_and_leased_past_expiry`, `rows_are_workspace_scoped`.
- [ ] Implement fake first (tests run on Windows via testkit), then Postgres (CI). **Commit**.

### Task D1-T5: bridge use cases + routes

**Files:** `rust/crates/jt_app/src/usecases/devices/{mod.rs,bridge.rs}`; catalog rows
`panel_only("devices.bridge.register", Exempt, ("POST","/api/devices/bridge/register"), Write)`,
`…commands` `("GET","/api/devices/bridge/commands")` `Read`, `…results` `("POST","/api/devices/bridge/results")` `Write`,
`…files` `("POST","/api/devices/bridge/files")` `Write`; `rust/crates/adapters/jt_panel_http/src/routes/device_bridge.rs`
using the existing bearer extractor (`jt_panel_http/src/bearer.rs`, generalize `takes_bearer_key` to both
prefixes); catalog count pin +4.

Behaviour (on the D0 kernel, `BridgeSpec { component: "device_bridge", permission: DevicesBridge, … }`):
- `register(RegisterIn)`: `RegisterIn::validate` the body (a `ProtocolError` is `422`); then `PhoneReport::validate`
  each phone — a phone that fails is NOT registered and is listed in `RegisterOut.refused` (`RefusedPhone`, reason =
  the error's text), the heartbeat itself is not refused. For each valid phone, declare-or-verify a `phone`
  capability (`Reach::Device`) with external id `{platform}:{serial}`; merge facts into `connector_public.device`
  (model, os_version, screen, features, bridge_id, version, protocol) — merge, never replace; refuse a retired
  phone's re-registration (`409 phone_retired`, or list it in `refused`); answer `RegisterOut::new(registered,
  refused)`. Shape every later body to the protocol the bridge sent.
- `commands(CommandsQuery)`: `clamped()`; lease for this bridge's phones (≤ `limit` ≤ 20), wait on the kernel signal
  up to `wait_s` ≤ 25; **re-check `jt_devices::supports` at lease time** against the phone's CURRENT features (a
  bridge that re-registered without a feature must not be handed a command that needs it; fail such a command
  `unsupported_by_bridge` instead of leasing it); for `PushFile` attach a 10-minute signed `download_url`
  (`FileStore::provider_url`).
- `results(ResultsIn ≤ 100)`: the route's `DefaultBodyLimit` is `MAX_RESULTS_BODY_BYTES`; `ResultsIn::validate`
  (a `ProtocolError` is `422`, final — the bridge must not retry the same batch); `finish` each, **after checking the
  command belongs to one of THIS bridge's phones** (another bridge's command id is `unknown`, not applied);
  **file ids in a result (`File.file_id`, `Observation.screenshot_file_id`) are resolved within the workspace before
  anything is signed or stored**; ledger `devices.command.finished {command_id, kind, status, reason, duration_ms}`;
  signal the waiting agent; observation/shell/file results stored on the row. `ResultsOut` counts `Applied` as
  `applied`, `Duplicate` as `duplicates`, and `Unknown` (no such command, not this bridge's, or a result for a
  command that was never leased) as `unknown`; the three sum to `results.len()`.
- `files` (body ≤ the studio upload limit, `image/png` or `application/octet-stream`): store as a workspace file
  with 7-day expiry metadata, answer `FileOut`.
- [ ] **Tests first (`jt_app/tests/devices_bridge.rs`):** `register_declares_phones_and_merges_facts`, `register_refuses_retired_phone`, `bridge_key_only`, `commands_long_poll_wakes_on_enqueue`, `redelivered_after_10s`, `expired_command_not_leased`, `results_idempotent_and_ledgered`, `late_result_after_expiry_is_applied_and_ledgered_again`, `push_file_gets_signed_download_url`, `files_upload_returns_id`, `register_refuses_one_bad_phone_not_the_heartbeat`, `commands_rechecks_supports_at_lease_time`, `result_for_another_bridges_command_is_unknown`, `result_with_a_foreign_file_id_is_refused`, `invalid_results_body_is_422`; `jt_panel_http/tests/device_bridge.rs::{session_cookie_refused, wrong_permission_key_refused}`; archtest: no MCP tool for `devices.bridge.*`.
- [ ] CI red → implement → green; **commit** `feat(devices): the device bridge's surface`.

### Task D1-T6: agent use cases + MCP tools + logging rule

**Files:** `rust/crates/jt_app/src/usecases/devices/agent.rs`; catalog rows (twin, `GateMode::Exempt` — devices
are set up before a strategy, like the bridge; `Write` for act):
`twin("devices.list", Exempt, "jeeta.devices.list", ("GET","/api/devices"), Read)`,
`twin("devices.observe", Exempt, "jeeta.devices.observe", ("POST","/api/devices/{capability_id}/observe"), Write)`,
`twin("devices.act", Exempt, "jeeta.devices.act", ("POST","/api/devices/{capability_id}/act"), Write)`,
`twin("devices.command_get", Exempt, "jeeta.devices.command_get", ("GET","/api/devices/commands/{command_id}"), Read)`,
`twin("devices.commands", Exempt, "jeeta.devices.commands", ("GET","/api/devices/{capability_id}/commands"), Read)`;
`rust/crates/adapters/jt_mcp/src/tools/devices.rs` (descriptions state: a queued command is not a done command;
`wait_s` ≤ 20; non-ASCII text needs `text.unicode`); `jt_panel_http/src/routes/devices.rs`; catalog pin +5.

- `act`: `validate()`; phone must be a live `phone` capability; `supports(features, cmd)` else
  `422 unsupported_by_bridge {kind}`; Unicode text without the feature → `422 unicode_unsupported` naming
  ADBKeyBoard; enqueue (expires in 5 min); ledger `devices.command.queued {command_id, phone, command}` — the
  **full** command; signal the bridge; wait up to `wait_s` for a final status; return `{command_id, status,
  result?, reason?}`.
- `observe` = `act(Observe{screenshot})` with the observation (and a signed screenshot URL) in the answer.
- [ ] **Tests first (`jt_app/tests/devices_agent.rs`):** `act_queues_and_returns_result_when_bridge_answers`, `act_returns_queued_when_wait_ends`, `act_refuses_unsupported_kind`, `act_refuses_unicode_without_feature`, `act_on_offline_phone_refuses_device_offline`, `ledger_carries_full_command`, `tracing_never_carries_args` (capture `tracing` output with a test subscriber; assert typed text / shell args absent), `rep_cannot_act`, `command_get_waits`; `jt_mcp/tests/devices_mcp.rs::tools_listed_with_schemas`.
- [ ] CI red → implement → green; **commit** `feat(devices): agents act on phones`.

### Task D1-T7: jobs

**Files:** `usecases/jobs.rs`: `Job::DeviceBridgeHealth` (1 min, kernel `mark_unreachable` for kind `phone`),
`Job::DeviceCommandExpiry` (1 min, `expire_due`, ledger `devices.command.finished {status: expired}` per row;
a late result for a command that was leased then replaces `expired` (D1-T4 `finish`) and writes a SECOND
`devices.command.finished` with the result's status: intended, the ledger keeps what happened in order),
`Job::DeviceFilePurge` (hourly, deletes device files older than 7 days); job list pins.
- [ ] **Tests first:** `phone_unreachable_after_10m_without_heartbeat`, `expiry_job_expires_and_ledgers`, `file_purge_keeps_6_days_drops_8`.
- [ ] CI red → green; **commit**.

---

## D2 — the bridge program

### Task D2-T1: crate skeleton, config, client loop

**Files:** `rust/bridge/device/Cargo.toml` (`name = "jeeta-device-bridge"`, bin; deps `jt_device_protocol`,
`jt_devices`, `tokio`, `reqwest` (rustls, json, multipart), `serde`, `toml`, `tracing`, `tracing-subscriber`);
workspace member; archtest rule: depends on neither `jt_pg` nor `jt_app` nor any adapter;
`src/{main,config,client,run_loop}.rs`; `tests/loop.rs` with an axum fake Jeeta.

Config `jeeta-device-bridge.toml`: `base_url`, `key` (or env `JEETA_DEVICE_BRIDGE_KEY`), `adb` (path, default
`adb` on PATH or `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`), `serials` (optional filter).
Loop: every `heartbeat_s` register; continuously long-poll; run commands concurrently per phone but
sequentially within a phone; post results in batches; retry posts with backoff; dedupe command ids (a set
of the last 1 000).
- [ ] **Tests first (`tests/loop.rs`, run on Windows):** `registers_on_start_and_every_heartbeat`, `runs_leased_command_and_posts_result`, `same_command_id_runs_once`, `commands_for_one_phone_run_in_order`, `result_post_retried_until_accepted`, `key_never_logged` (capture tracing).
- [ ] `cargo test -p jeeta-device-bridge` red → green; **commit**.

### Task D2-T2: `AndroidAdbDriver`

**Files:** `src/driver/{mod.rs,android/{mod.rs,adb.rs,observe.rs,commands.rs}}`; fixtures
`tests/fixtures/{dump_whatsapp.xml,dump_numeric_refs.xml,idle_state_error.txt,getprop.txt,devices_l.txt}`
(take dumps from the emulator `jeeta_test`; scrub any personal data); `tests/android_driver.rs` with a fake
`AdbRunner` trait object returning fixture output.

```rust
#[async_trait]
pub trait PhoneDriver: Send + Sync {
    fn platform(&self) -> Platform;
    async fn report(&self) -> Result<PhoneReport, DriverError>;
    async fn execute(&self, cmd: &DeviceCommand, files: &dyn FileTransfer) -> Result<CommandResult, DriverError>;
}
pub trait AdbRunner: Send + Sync { async fn run(&self, serial: &str, args: &[&str]) -> Result<AdbOutput, AdbError>; } // argv only
pub struct DriverError { pub reason: FailReason, pub detail: String }
```
Mapping per spec §4.1. Real-device findings on the owner's Redmi 10C (Android 13, MIUI 14, serial
`18cf9fbb`), which the driver and its fixtures must cover:
- MIUI's `uiautomator dump` writes a Java `FileNotFoundException …/theme_compatibility.xml` stack trace and
  still dumps (`UI hierchary dumped to: …`): judge a dump by the file's `<node` content, never by stderr.
  Test `miui_theme_stack_trace_is_not_a_failure`.
- `input …` without Xiaomi's "USB debugging (Security settings)" prints
  `java.lang.SecurityException: Injecting input events requires … INJECT_EVENTS` and exits **0**: detect
  `Exception occurred` / `SecurityException` in the output and fail with `adb_error` and a detail naming the
  setting. Test `inject_events_refusal_with_exit_0_is_a_failure`.

Specifics:
- `observe`: `uiautomator dump /sdcard/jeeta_ui.xml` then `cat`; output containing `ERROR: could not get idle state` (exit 0) → wait 700 ms, retry once, else `ScreenBusy`; a file without `<node` → `ScreenBusy`; decode named and numeric character references; distill to `Element`s (skip invisible/zero-size; tap point = bounds centre); cap 300 → `truncated`; foreground app from `dumpsys window` (`mCurrentFocus`); screen from `wm size` + rotation.
- `tap_on`: dump, match `text`/`id` (`resource-id`)/`desc` (`content-desc`) exact first then contains (unless `exact`), tap the best match's tap point; none → `ElementNotFound` with up to 20 visible labels in `detail`.
- `text`: ASCII → `input text` with spaces as `%s` and shell metacharacters escaped for the device shell; non-ASCII → if ADBKeyBoard present: `ime set com.android.adbkeyboard/.AdbIME`, `am broadcast -a ADB_INPUT_B64 --es msg <base64>`, restore the previous IME; else `UnicodeUnsupported`.
- feature detection: `pm list packages com.android.adbkeyboard` → `text.unicode`; all kinds of §4.1 reported for Android.
- `shell`: `adb -s S shell <argv…>` as separate args, each argument quoted for the device shell; capture exit code (`adb shell` ≥ API 24 propagates it), stdout/stderr capped at 64 KiB each. After quoting, the driver checks the final command-line length against a limit it names as a constant (the quoting can make a command that validated longer) and refuses an over-long one before any `adb` call with `bridge_error` and a clear `detail` (the length and the limit). The ASCII `text` path does the same check after its escaping.
- `screenshot`: `exec-out screencap -p` bytes → upload via `FileTransfer` → `File{file_id}`.
- `push_file`: download `download_url` to a temp file → `adb push`; `pull_file`: `adb pull` to temp → upload.
- [ ] **Tests first:** `dump_distills_elements`, `numeric_references_decoded`, `idle_state_retried_then_screen_busy`, `tap_on_exact_beats_contains`, `tap_on_missing_lists_labels`, `ascii_text_escapes_for_device_shell`, `unicode_text_uses_adbkeyboard_and_restores_ime`, `unicode_text_without_adbkeyboard_refused`, `shell_passes_argv_separately`, `shell_overlong_after_quoting_refused_with_bridge_error`, `every_call_names_the_serial`, `report_merges_getprop`.
- [ ] `cargo test -p jeeta-device-bridge` red → green; **commit** `feat(device-bridge): the Android driver`.

### Task D2-T3: Windows build in CI

**Files:** `.github/workflows/rust.yml`: job `device-bridge-windows` on `windows-latest`: `cargo test -p jeeta-device-bridge -p jt_devices -p jt_device_protocol` and `cargo build --release -p jeeta-device-bridge`, upload `jeeta-device-bridge.exe` as an artifact.
- [ ] Job green on the PR; **commit**.

---

## D3 — panel and docs

### Task D3-T1: phone card, pairing, command log

**Files:** `rust/panel/src/api/devices.ts`, `rust/panel/src/pages/capabilities/PhoneCard.tsx` (+ `.test.tsx`), wiring in the Capabilities page's Devices tab, i18n `en.json`/`tr.json`.
Card: platform, model, OS, status with heartbeat age, bridge version, features (Unicode yes/no with the ADBKeyBoard hint), last 20 commands (kind, status, time; expand to args/result), "Pair a bridge" (issues an API key with exactly `devices.bridge` via the existing API-key use case, shown once, with the three install steps).
- [ ] **Tests first:** `renders_phone_facts_and_status`, `unicode_hint_when_feature_missing`, `pairing_shows_key_once`, `command_log_expands_args`.
- [ ] `pnpm --dir rust/panel test`, typecheck, build; **commit**.

### Task D3-T2: operations doc

**Files:** `docs/operations/device-bridge.md`: enabling Developer options + USB debugging, accepting the RSA prompt, `adb devices`, installing ADBKeyBoard (and that it must be enabled as an input method), config file, running the bridge, running it at logon (Task Scheduler), troubleshooting (`unauthorized`, `offline`, screen busy, Unicode refused). **Commit**.

---

## D4 — end to end

### Task D4-T1: emulator, then a real phone

- [ ] Emulator `jeeta_test` (`emulator.exe -avd jeeta_test -no-window -gpu swiftshader_indirect -port 5554`) + bridge against **staging** with a `devices.bridge` key; via MCP on staging: `devices.list` → `observe` → `tap_on` → `text` (ASCII) → `shell ["getprop","ro.product.model"]` → `screenshot` → `pull_file`; each appears in the ledger with its args.
- [ ] Real Android phone over USB on the owner's PC: same sequence; Unicode text with ADBKeyBoard installed (owner approves the APK download).
- [ ] Record results in `docs/operations/device-bridge.md` ("verified on").

---

## Self-review against the spec

- §1 non-goals → no policy in `validate`/`act` (D1-T1 `no_access_policy_in_validation`). Lessons → D2-T2 tests.
- §2 units → file structure; protocol shared → D1-T2; bridge never depends on server crates → D2-T1 archtest.
- §3 kernel → D0-T1 with the unedited-voice-tests gate.
- §4 commands/lifecycle/observation → contracts + D1-T1 + D2-T2.
- §5.1–5.6 → D1-T3 (table), D1-T5 (capabilities, facts merge, files), D1-T6 (negotiation, tools, ledger vs tracing), D1-T7 (retention, expiry).
- §6 bridge → D2; §7 panel → D3-T1; §8 testing → each task + D4; §9 iOS → not in this plan (D5); §10 seams → `act` is the single entry point a policy check will wrap.
