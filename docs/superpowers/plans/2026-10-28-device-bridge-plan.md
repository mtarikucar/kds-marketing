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
| `rust/crates/domain/jt_tenancy/src/role.rs` | changed | `devices.work`, `devices.bridge` |
| `rust/crates/jt_app/src/catalog.rs` | changed | rows (§D1-T5, D1-T6) |
| `rust/crates/adapters/jt_panel_http/src/routes/device_bridge.rs` + `routes/devices.rs` | new | routes |
| `rust/crates/adapters/jt_mcp/src/tools/devices.rs` | new | MCP tools |
| `rust/crates/jt_app/src/usecases/jobs.rs` | changed | `DeviceBridgeHealth` (or kernel's shared health job), `DeviceCommandExpiry`, `DeviceFilePurge` |
| `rust/bridge/device/{Cargo.toml,src/{lib,main,config,client,run_loop}.rs,src/driver/{mod,android/{mod,adb,observe,commands}}.rs}` | new | the PC-side program |
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
pub const PHONE_RETIRED: &str = "phone_retired";   // RefusedPhone.reason of a retired phone: the bridge stops listing it
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
// `unreadable` one by id with FailReason::UnsupportedByBridge and logs `dropped` (commands with no readable id, so
// nothing to fail them by) at warn level. A body that is not a poll (not an object with a `commands` array) is an
// Err, not an empty poll: the bridge treats it as a failed poll, backs off and polls again.
pub struct LenientCommands { pub commands: Vec<LeasedCommand>, pub unreadable: Vec<(Uuid, String)>, pub dropped: usize }
impl CommandsOut   { pub fn decode_lenient(value: serde_json::Value) -> Result<LenientCommands, ProtocolError>; }
```

Rules of the vocabulary (written in the `jt_devices` crate docs too):
- **Growing it.** A new command kind needs a feature name (a bridge reports what it runs, and a command is queued
  only for a bridge that lists its kind). A new field on an existing kind needs a feature name too, and is
  `#[serde(default, skip_serializing_if = ...)]`, so an older bridge never sees it. A new VALUE of an existing enum
  field (a new `DeviceKey` or `ElementTarget` variant) counts as a new field: it needs a feature name (e.g.
  `key.camera`) that `supports` checks. A new `FailReason` needs nothing: an older reader takes it as `Unknown`. A new
  `Platform` needs a protocol bump (it is a stored key: no `Unknown` variant), and the first register goes out
  before the bridge knows the server's protocol, so it lists only phones of the platforms protocol 1 defines: phones
  of newer platforms are listed only once `RegisterOut.protocol` shows the server defines them. Register is tolerant
  (unknown fields ignored); after it, each side sends only what the lower protocol defines.
- **Logging.** Log `DeviceCommand::kind()` and counts, never the `{:?}` of a command or an observation (typed text,
  shell arguments and screen text are in them). A failure `detail` can carry on-screen labels. `reqwest` errors carry
  the request URL (a signed download address): the bridge uses `without_url()` before logging one.
- **A tagged variant without fields is an empty struct variant** (`Screenshot {}`): serde ignores unknown fields on a
  unit variant of a tagged enum, so `deny_unknown_fields` would not hold. (`CommandResult::Done {}` is one.)
- **A refused results batch (422) is refused for good**: the bridge must not retry it as it is. It builds results with
  `Outcome::failed` / `CommandResult::shell` and `Observation::cap_elements`, so what it sends is valid by construction.
- **Every `POST` from the bridge carries `X-Requested-With: jeeta-panel`** next to `Authorization: Bearer <key>`:
  `jt_panel_http` wraps every `/api` route in `csrf::require_requested_with`, which refuses a non-safe method without
  it with a `403` before authentication (as for the voice bridge, `docs/operations/voice-bridge.md` §3). The poll
  (`GET`) carries the key only. A signed download carries neither.

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
  `shell_constructor_is_valid_by_construction`, `shell_cap_inside_a_character_drops_the_character_whole`,
  `commands_query_is_clamped`.
- [ ] `cargo test -p jt_device_protocol` red → implement → green; fmt + clippy; **commit**.
- Built as `f9f9f3fe`, `a1ff64aa` and `55143291` (review fixes); the archtest rule allows `jt_devices`, `serde`,
  `serde_json`, `time`, `uuid`, `thiserror` for this crate.

### Task D1-T3: permissions + migration

**Files:** `rust/crates/domain/jt_tenancy/src/role.rs` (add `DevicesWork` `"devices.work"` and `DevicesBridge` `"devices.bridge"`; owner + manager get both — bridge only so they can issue a bridge key, as `calls.bridge`; `rep` none. There is no `devices.manage`: it would gate nothing in this build. Pairing is `api_keys.manage` plus holding `devices.bridge`, exactly as voice does it; access policy is a later, separate layer, and a permission added then costs one backfill); `rust/migrations/00NN_device_bridge.{up,down}.sql`; pins in `jt_archtest`/`jt_app/tests` that list permissions, tables and migrations.

```sql
create table if not exists device_commands (
    id uuid primary key,
    workspace_id uuid not null references workspaces(id),
    capability_id uuid not null,
    seq bigint generated always as identity,
    kind text not null check (char_length(kind) between 1 and 32),   -- not pinned to a list
    payload jsonb not null check (jsonb_typeof(payload) = 'object'),
    status text not null check (status in ('queued','leased','done','failed','expired','canceled')),
    attempts int not null default 0 check (attempts >= 0),
    leased_at timestamptz,
    expires_at timestamptz not null,
    result jsonb,
    reason text,                                                      -- not pinned to a list
    detail text check (detail is null or char_length(detail) <= 300), -- Outcome::Failed.detail
    requested_by jsonb not null check (jsonb_typeof(requested_by) = 'object'),
    created_at timestamptz not null,
    done_at timestamptz,
    constraint device_commands_capability_fkey foreign key (workspace_id, capability_id)
        references capabilities (workspace_id, id),
    constraint device_commands_leased_check check (status not in ('leased','done') or leased_at is not null),
    constraint device_commands_done_check check ((done_at is null) = (status in ('queued','leased')))
);
create index if not exists device_commands_queue on device_commands (workspace_id, capability_id, status, seq);
create index if not exists device_commands_due
    on device_commands (workspace_id, expires_at) where status in ('queued','leased');
create index if not exists device_commands_log on device_commands (workspace_id, capability_id, seq);
alter table device_commands enable row level security;
alter table device_commands force row level security;
-- policy device_commands_ws exactly as call_bridge_events_ws in 0016_voice_bridge.up.sql
-- role backfill exactly as 0016's calls.bridge backfill, for the two new keys
```
(`capabilities` has the `(workspace_id, id)` unique key the foreign key needs (`0003_capabilities`); the guards are
0016's idempotent `do $$ … $$`. `down` removes only the two keys, then drops the table, and its indexes with it.
0017 was still unmerged when the indexes and checks were added, so they are part of it, not a 0018.)

- [ ] **Tests first:** extend the pins (`sql_scoping` sees the new table with FORCE RLS; the migration list includes `00NN`; role permission lists include the two keys; the repeatability test for 00NN runs up and down twice, checks the role backfill, the three indexes after the final up, forced RLS and exactly one `device_commands_ws` policy).
- [ ] CI red → implement → green; **commit** `feat(devices): device_commands and the devices permissions`.

### Task D1-T4: `DeviceCommandRepo` port, Postgres and fake

**Files:** `rust/crates/jt_app/src/ports/devices.rs`, `ports/mod.rs` (TenantRepos accessor `device_commands()`); `rust/crates/adapters/jt_pg/src/repos/devices.rs`; `rust/crates/jt_testkit/src/fakes/devices.rs`; contract tests `rust/crates/jt_testkit/src/devices_contract.rs` run against both (pattern: `inbox_contract.rs`).

As built (`c76b3404`, `b78f0d29`, then the review follow-ups and the D1-T5 methods); `jt_app::ports::devices`
re-exports `jt_devices::*` and `jt_device_protocol::MAX_DETAIL_CHARS`:
```rust
#[async_trait]
pub trait DeviceCommandRepo: Send + Sync {
    async fn enqueue(&mut self, row: NewDeviceCommand) -> Result<DeviceCommandRow, AppError>; // taken id (any workspace) CONFLICT; foreign phone INTERNAL
    async fn pick_due(&mut self, caps: &[CapabilityId], now: OffsetDateTime, redeliver_before: OffsetDateTime, limit: u32)
        -> Result<Vec<DeviceCommandRow>, AppError>;   // queued, or leased and leased_at <= redeliver_before; expires_at > now;
                                                      // seq order, <= limit (1..=200); `for update skip locked`, held until the
                                                      // bundle ends; marks NOTHING. The caller passes `now - REDELIVER_AFTER`.
    async fn mark_leased(&mut self, ids: &[Uuid], now: OffsetDateTime) -> Result<Vec<DeviceCommandRow>, AppError>;
                                                      // ids still queued/leased -> leased at now, attempts + 1; by seq
    async fn fail_pending(&mut self, ids: &[Uuid], reason: FailReason, detail: &str, now: OffsetDateTime)
        -> Result<Vec<DeviceCommandRow>, AppError>;   // a server-decided failure: ids still queued/leased -> failed
                                                      // (`failed_while_pending`, through next_status); leased_at and attempts
                                                      // untouched; detail cut to 300; ended/unknown/foreign ids passed over; by seq
    async fn finish(&mut self, caps: &[CapabilityId], id: Uuid, outcome: Finish, now: OffsetDateTime) -> Result<Finished, AppError>;
    // A bridge's result for a command of one of ITS phones (`capability_id = any(caps)`), through `Finish::status_after`
    // (never leased -> Unknown, else jt_devices::next_status(status, event, true)):
    //   Applied(row) - a leased command becomes done/failed; or a LATE result for an expired/canceled command that
    //                  was leased (leased_at not null) REPLACES that status; the row as it now stands
    //   Duplicate    - only a done/failed row (a result is already recorded)
    //   Unknown      - no such command among `caps`' phones (another bridge's included), or a result for a command
    //                  that was never leased (leased_at null: queued, or expired/canceled in the queue)
    async fn expire_due(&mut self, now: OffsetDateTime) -> Result<Vec<ExpiredCommand>, AppError>;
                                                      // queued/leased with expires_at <= now -> expired, done_at = now; a row
                                                      // another bundle holds is skipped (`for update skip locked`) for the next
                                                      // sweep; payload never decoded; by seq
    async fn get(&mut self, id: Uuid) -> Result<Option<DeviceCommandRow>, AppError>;
    async fn list(&mut self, cap: CapabilityId, limit: u32) -> Result<Vec<DeviceCommandRow>, AppError>; // newest first, 1..=200
}
pub enum Finish { Done { result: Value }, Failed { reason: FailReason, detail: String } } // Finish::failed(reason, detail) cuts to 300
pub enum Finished { Applied(Box<DeviceCommandRow>), Duplicate, Unknown }
pub struct ExpiredCommand { pub id: Uuid, pub capability_id: CapabilityId, pub seq: i64, pub kind: String,
    pub created_at: OffsetDateTime, pub leased_at: Option<OffsetDateTime> }
```
- A poll is `pick_due`, then `fail_pending` for what the bridge cannot run and `mark_leased` for the rest, in one
  bundle: a refused command is never marked leased. There is no cancel method: no D1 task cancels.
- A pick, and the expiry sweep, lock their rows in a MATERIALIZED CTE (or a plain `select … for update skip locked`)
  that runs once: `update … from (select … limit … for update skip locked)` over-leased in CI (Postgres ran the pick
  again during the update and each run skipped the rows already updated). Voice's `take_commands` had the same shape
  and the same fault; it is fixed the same way.
- `Outcome::Failed.detail` is stored in the `detail` column (at most `MAX_DETAIL_CHARS` = 300 characters, cut by
  the store whatever the caller passed); `reason` and `kind` are stored as text, not pinned to a list. A stored
  reason this version does not know reads as `FailReason::Unknown` (a `warn!` names the key, nothing else).
- [x] **Contract tests** (`jt_testkit::devices_contract`, run against the fake and Postgres): `lease_returns_oldest_first`,
  `lease_skips_fresh_lease_and_redelivers_after_10s`, `lease_never_returns_expired` (all three through the pick
  path: `pick_due` + `mark_leased`, with a limit below the due count), `pick_due_does_not_mark`,
  `mark_leased_marks_only_still_pending`, `fail_pending_never_sets_leased_at_and_skips_finished`,
  `finish_is_idempotent`, `finish_unknown_id`, `finish_for_another_bridges_command_is_unknown`,
  `finish_replaces_expired_after_lease`, `finish_refuses_result_for_never_leased`,
  `expire_due_marks_only_unleased_past_expiry_and_leased_past_expiry`, `list_is_newest_first_and_bounded`,
  `rows_are_workspace_scoped`. Postgres only (`jt_pg/tests/devices_repos.rs`): `concurrent_picks_take_different_commands`,
  `racing_results_apply_once`, `expire_due_passes_over_a_held_command`, `an_unknown_stored_reason_reads_as_unknown`.

### Task D1-T5: bridge use cases + routes

**Kernel first (from the D0 review, PR #379).** Spec §3 says the kernel owns lease/redeliver and declare. D0 kept those parts in `calls` (it was a pure refactor), so this task moves them into the kernel before the device code uses them. Voice moves onto them, and its tests stay unedited and green:
- **Redelivery.** Move `REDELIVER_AFTER` (`calls/bridge.rs:83`) into the kernel, or onto `BridgeSpec`. Add a kernel helper that wraps each read: `now = ctx.now + waited`, fresh transaction, lease through a closure, commit, then `Some` if the batch is non-empty. Voice's `commands` and the device `commands` both use it.
- **Declare.** Move voice's in-transaction declare (`calls/bridge.rs:289-327`) into `kernel::declare(r, ctx, ids, kind_key, name, external_id, in_force)`, plus a shared lookup of live capabilities by kind and external id. What happens to a retired capability stays each bridge's own policy: voice answers `409`; the device lists the phone in `refused` with `PHONE_RETIRED`.
- **Merge depth.** `kernel::heartbeat` merges `connector_public` one level deep, so it replaces `connector_public.device` whole. If phone facts must merge key by key inside `device` ("merge, never replace"), add that deeper merge to the kernel, not to device code.
- **Optional:** a `BridgeSpec.kind_key` field, so a spec can't be paired with the wrong kind.

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
  (model, os_version, screen, features, bridge_id, version, protocol) — merge, never replace; a RETIRED
  phone that is still plugged in is always listed in `RegisterOut.refused` with the reason `PHONE_RETIRED` (`"phone_retired"`), and
  nothing is declared or merged for it — never a `409`: one phone's faults never refuse the register, so the other
  phones on that bridge stay online; answer `RegisterOut::new(registered, refused)`. Shape every later body to the
  protocol the bridge sent.
- `commands(CommandsQuery)`: `clamped()`. "This bridge's phones" means exactly the phones in its LATEST register; a phone the bridge leaves out (e.g. one whose worker is stuck) gets no new leases from the next poll on. Lease for those phones (≤ `limit` ≤ 20; `pick_due`, then `fail_pending` / `mark_leased`, D1-T4), wait on the kernel signal
  up to `wait_s` ≤ 25; **re-check `jt_devices::supports` at lease time** against the phone's CURRENT features (a
  bridge that re-registered without a feature must not be handed a command that needs it; fail such a command
  `unsupported_by_bridge` instead of leasing it); for `PushFile` attach a 10-minute signed `download_url`
  (`FileStore::provider_url`).
- `results(ResultsIn ≤ 100)`: the route's `DefaultBodyLimit` is `MAX_RESULTS_BODY_BYTES`; `ResultsIn::validate`
  (a `ProtocolError` is `422`, final — the bridge must not retry the same batch); `finish` each (`finish(caps, …)` takes this bridge's phones, D1-T4), **after checking the
  command belongs to one of THIS bridge's phones** (another bridge's command id is `unknown`, not applied);
  **file ids in a result (`File.file_id`, `Observation.screenshot_file_id`) are resolved within the workspace before
  anything is signed or stored**; ledger `devices.command.finished {command_id, kind, status, reason, duration_ms}`;
  signal the waiting agent; observation/shell/file results stored on the row. `ResultsOut` counts `Applied` as
  `applied`, `Duplicate` as `duplicates`, and `Unknown` (no such command, not this bridge's, or a result for a
  command that was never leased) as `unknown`; the three sum to `results.len()`.
- `files` (body ≤ the studio upload limit, `image/png` or `application/octet-stream`): store as a workspace file
  with 7-day expiry metadata, answer `FileOut`.

What the bridge as built (D2-T1) relies on, which the server must match:
- **The request header.** Every `POST` carries `X-Requested-With: jeeta-panel` (Contracts); the `/api` CSRF layer
  applies to these routes like any other. `jt_panel_http/tests/device_bridge.rs` pins the server side: a `POST`
  with the bearer key but without the header is `403`, and with it the route answers.
- **`POST /api/devices/bridge/files` takes a RAW body**: the file itself, with `Content-Type` `image/png` (a
  screenshot) or `application/octet-stream` (a pulled file). No JSON envelope, no multipart, no filename. It answers
  `200 {"file_id": …}` (`FileOut`). It needs its own `DefaultBodyLimit`: studio's limit is set on studio's route ids
  only. An upload is not idempotent: a retried upload makes a new file (the 7-day purge removes what no result names).
- **A `422` carries `details.field` = `ProtocolError::field()`** (the server's usual error shape). That name is the
  one thing of a refusal the bridge logs, when it drops a refused result.
- **`download_url` is an absolute `https` URL that authenticates by itself.** The bridge sends no `Authorization` to
  it and follows up to 5 redirects. Conflict to resolve here, not decided by D2-T1: `FileStore::provider_url`
  (`jt_files`) refuses any lifetime but 24 h, while this task asks for a 10-minute URL.
- **A result the server does not apply is still a `200`.** One for an unknown command, another bridge's, or one that
  was never leased is counted in `ResultsOut.unknown`, never answered with a 4xx. The bridge retries only
  transport errors, 5xx, 408 and 429; it splits a batch on a 422 (or 413); any other 4xx (401, 403, 404 included)
  makes it drop the batch.
- [ ] **Tests first (`jt_app/tests/devices_bridge.rs`):** `register_declares_phones_and_merges_facts`, `register_lists_retired_phone_as_refused`, `bridge_key_only`, `commands_long_poll_wakes_on_enqueue`, `redelivered_after_10s`, `expired_command_not_leased`, `results_idempotent_and_ledgered`, `late_result_after_expiry_is_applied_and_ledgered_again`, `push_file_gets_signed_download_url`, `files_upload_returns_id`, `register_refuses_one_bad_phone_not_the_heartbeat`, `commands_rechecks_supports_at_lease_time`, `result_for_another_bridges_command_is_unknown`, `result_with_a_foreign_file_id_is_refused`, `invalid_results_body_is_422`; `jt_panel_http/tests/device_bridge.rs::{session_cookie_refused, wrong_permission_key_refused, post_without_requested_with_is_403, files_take_a_raw_body}`; `invalid_results_body_is_422` also checks `details.field`; archtest: no MCP tool for `devices.bridge.*`.
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
- [ ] **Tests first (`jt_app/tests/devices_agent.rs`):** `act_queues_and_returns_result_when_bridge_answers`, `act_returns_queued_when_wait_ends`, `act_refuses_unsupported_kind`, `act_refuses_unicode_without_feature`, `act_on_offline_phone_refuses_device_offline`, `act_on_phone_missing_from_latest_register_refuses_device_offline` (a stale phone is not "live"), `ledger_carries_full_command`, `tracing_never_carries_args` (capture `tracing` output with a test subscriber; assert typed text / shell args absent), `rep_cannot_act`, `command_get_waits`; `jt_mcp/tests/devices_mcp.rs::tools_listed_with_schemas`.
- [ ] CI red → implement → green; **commit** `feat(devices): agents act on phones`.

### Task D1-T7: jobs

**Files:** `usecases/jobs.rs`: `Job::DeviceBridgeHealth` (1 min, kernel `mark_unreachable` for kind `phone`),
`Job::DeviceCommandExpiry` (1 min, `expire_due`, which returns an `ExpiredCommand` per row it ended, ledger `devices.command.finished {status: expired}` per row;
a late result for a command that was leased then replaces `expired` (D1-T4 `finish`) and writes a SECOND
`devices.command.finished` with the result's status: intended, the ledger keeps what happened in order),
`Job::DeviceFilePurge` (hourly, deletes device files older than 7 days); job list pins.
Health is `run_bridge_health(deps, Job::DeviceBridgeHealth, &DEVICE_BRIDGE, "phone", now)`, the generic loop from D0. Two prerequisites:
- `phone` needs a heartbeat in `jt_capability/src/kind.rs`. Staleness is read from the kind, not from the spec.
- `work.rs` must map kind to work item. Today any heartbeat kind that goes offline is reported as `VoiceBridgeOffline`, with the voice hint and the `calls.bridge.register` tool. A phone needs its own work item, e.g. `DeviceBridgeOffline`. Test: `offline_phone_is_not_reported_as_a_voice_bridge`.
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
of the last 1 000). Read each poll body with `CommandsOut::decode_lenient`: run `commands`, fail each `unreadable`
command by its id with `FailReason::UnsupportedByBridge` (the message is the failure `detail`, never a log line), and
log `dropped` at `warn` level when it is not zero (a count only: no body, no command). An `Err` is a failed poll, like
a transport error: log it (the field name only), back off and poll again — it must not read as an idle poll.

As built (after the spec and quality reviews):
- **Requests.** Every `POST` (register, results, files) carries `X-Requested-With: jeeta-panel` (Contracts). The
  server's answers are decoded strictly, as the Contracts say (after register, each side sends only what protocol 1
  defines): an answer that does not decode is logged by the field the decoder names only (`unknown field`,
  `missing field`) and tried again after a growing pause.
- **Register.** Every `heartbeat_s`, with only the configured `serials`, each once, at most `MAX_PHONES`. The
  registry's `attached()` and each `report()` run in tasks of their own within `Timing::report_timeout` (10 s). A
  listing that fails, panics or times out is replaced by the last good one; a phone whose report does is listed with
  its last good report for up to `STALE_REPORT_HEARTBEATS` (3) registers, then left out. A report's `serial` is the
  registry's and its `platform` is `PhoneDriver::platform()`. A `RefusedPhone` for a phone this bridge listed is
  logged at `warn` (serial and reason, control characters blanked, when the refusal is new); one with
  `PHONE_RETIRED` is not listed again until the bridge restarts.
- **Poll.** Only while a phone is registered, and at least `Timing::idle_poll_floor` (1 s) apart when a poll brings
  nothing new, so a server that answers at once (`max_wait_s = 0`) is never polled in a busy loop.
- **Run.** One worker per phone. A command that waited in its phone's queue longer than `Timing::stale_after`
  (`DEFAULT_EXPIRES_IN`, on the monotonic clock from its arrival) is failed as `timeout` unrun. Each command runs in a
  task of its own, bounded by `Timing::command_timeout` (120 s), or `Timing::transfer_timeout` (30 min) for
  `push_file`/`pull_file`. A command that times out is cut off: its task is aborted (the driver's future dropped) and
  awaited, `Timing::stop_wait` (`STOP_WAIT`, 5 s) and then without a bound once that is logged, so two commands never
  run on one phone; then the worker awaits `PhoneDriver::recover()` (bounded by `Timing::recover_timeout`,
  `RECOVER_TIMEOUT`, 30 s; a recovery that outlasts it is aborted and awaited the same way) before the next command.
  The command's result is sent before this cleaning up. While a phone's worker waits without a bound, the phone is
  left out of the registers (chosen over failing its new commands at dispatch: the server stops queuing for it).
  Every worker begins with one `recover()`: the poll loop starts a worker for each registered phone, so a phone is
  recovered once after the bridge starts, before its first command (a crash may have cut a command off). A driver
  panic fails its command as `bridge_error` (logged at `error` with serial and command id, never the panic's
  message), the phone recovers and the worker goes on. Serials, which come from the server and from phones, are
  logged with control characters blanked. A worker found stopped all the same (its `send` fails) is
  logged at `error`, the command is failed as `bridge_error` and the worker started again; the commands lost with it
  are never answered and only expire.
- **Post.** Batches of at most `MAX_RESULTS`, at most `MAX_RESULTS_BODY_BYTES` serialized, a command once; each
  result first checked with `ResultsIn::validate` and its size, one the server would refuse replaced by a
  `bridge_error` failure. A transport error, 5xx, 408 or 429 is retried with backoff. Such a failure counts against
  `Timing::post_attempts` (`MAX_POST_ATTEMPTS`, 10) only when a register or a poll succeeded since the try before it
  (a counter the heartbeat and the poll loop bump): the server is up and the batch is the trouble, such as a body
  that makes a handler fail. Past the count the batch is split as on a 422, and a lone result that keeps failing is
  dropped with a `warn` of its command id. A server outage, however long, counts nothing and drops nothing: the
  results are posted when it is back (D1-T7 applies late results).
  **A 422 is final**: the batch is never sent again as it is but split in halves (the first half first) until the
  refused result stands alone, which is dropped with a `warn` of its command id and the 422's `details.field`. A 413
  is split the same way; any other 4xx drops the batch (`error` log).
- **Stop.** `run` waits for the shutdown future and its three tasks together (`biased`, the tasks first, in order):
  a task that ends on its own is logged at `error`, the bridge stops and `run` answers `RunError::TaskEnded` (the
  program exits non-zero). The shutdown future answers a `Stop`: `Graceful` (`Timing::shutdown_grace`, 5 s) or
  `Within(d)`. Stopping, polling ends, a running command's `bridge_error` failure is sent and then the command is cut
  off (its phone recovers), so posting and cleaning up share the grace and the failure is not lost to a slow
  recovery; a command that ended just as the bridge stopped keeps its own outcome; queued commands stay unanswered
  (the server hands them out again); a post in backoff is tried again at once. `main` stops gracefully on Ctrl+C,
  Ctrl+Break and `SIGTERM`, and within `HURRIED_GRACE` (2 s) on console close, log-off and shutdown (Windows), which
  the system follows by ending the process soon. Exit status: 0 when stopped, 2 for a configuration that cannot be
  used, 1 when a task ended.
- **Files.** A download goes to `https` only (plain `http` to this computer), follows up to 5 redirects, never from
  `https` down to `http`, takes at most `MAX_DOWNLOAD_BYTES` (256 MiB, checked against the announced length and as it
  arrives) and removes its file when it fails or is dropped part way. `FileTransfer::upload(bytes, ContentType)` and
  `upload_file(&Path, ContentType)`, which streams (reqwest's `stream` feature); `ContentType` is `Png` or
  `OctetStream`, the two the files route takes.
- **Logging.** `main` installs the subscriber without bridging the HTTP client's `log` records, and a panic hook
  (`install_panic_hook`) that logs where a panic happened, never its message.

Seams D2-T2 fills (`src/driver/mod.rs`): `PhoneDriver` (below, with `recover`), `DriverError`, `FileTransfer` (one
per command, holding that command's signed `download_url`, so a driver never sees it; the download sends no key) and
`PhoneRegistry::attached() -> Vec<AttachedPhone { serial, driver }>`, which returns the same `Arc` for the same phone
on every call while it stays attached. A lib target beside the bin (`src/lib.rs`, so the tests reach the loop). Extra
deps: `serde_json`, `uuid`, `async-trait`. `Config` (private fields, getters; made only by `Config::parse`) also takes
an optional `bridge_id` (default `COMPUTERNAME`/`HOSTNAME`); `base_url` is https (plain http only to this computer);
the env key wins over the file's; an unknown setting is refused; no error repeats the key, a non-string `key`
included. `run(&Config, Arc<dyn PhoneRegistry>, Timing, shutdown) -> Result<(), RunError>`; `Timing` holds the
intervals (tests shorten them). `main.rs` wires a registry that reports no phones (`TODO(D2-T2)`). The archtest rule
(`device_bridge_depends_on_no_server_crate`) checks every dependency kind; `no_crate_but_outbound_names_reqwest` and
`deny.toml` name the bridge as the one other package with its own HTTP client. The fake Jeeta refuses what D1-T5's
server refuses: a `POST` without the request header (403), a body that breaks a limit (422 with `details.field`; a
register's phone that fails `PhoneReport::validate` listed as refused), a results body over its limit (413), a file
of another type (415).
- [ ] **Tests first (`tests/loop.rs`, run on Windows):** `registers_on_start_and_every_heartbeat`, `runs_leased_command_and_posts_result`, `same_command_id_runs_once`, `commands_for_one_phone_run_in_order`, `result_post_retried_until_accepted`, `unreadable_command_is_failed_by_id_and_dropped_is_logged`, `malformed_poll_body_backs_off_and_polls_again`, `key_never_logged` (capture tracing; covers HTTP error statuses and a refused connection), `refused_results_batch_is_not_resent_as_is`, `retired_phone_is_not_listed_again`, `file_transfer_uploads_with_the_key_and_downloads_without_it`, `posts_carry_the_requested_with_header`, `idle_polls_are_spaced_even_when_the_server_does_not_wait`, `a_driver_panic_fails_its_command_and_the_phone_keeps_working`, `only_the_configured_serials_are_listed`, `each_serial_is_listed_once_and_at_most_max_phones`, `a_failed_requests_url_is_never_logged` (fails if `without_url()` is removed), `a_failed_listing_keeps_the_last_phones`, `a_failed_report_reuses_the_last_one_for_a_few_heartbeats`, `a_register_answer_with_an_unknown_field_is_logged_by_field_and_retried`, `a_hung_command_times_out_and_the_next_runs`, `push_file_is_bounded_by_the_transfer_timeout`, `a_command_that_waited_past_its_expiry_is_failed_unrun`, `results_made_before_shutdown_are_posted`, `a_batch_over_the_body_limit_is_split`, `a_batch_refused_with_another_4xx_is_dropped`, `a_batch_the_server_keeps_failing_is_split_and_a_lone_result_dropped`; `tests/panic_hook.rs::a_panic_is_logged_by_where_it_happened_never_by_its_message`; unit tests `a_command_for_a_stopped_worker_is_failed_and_the_worker_started_again`, `the_first_task_to_end_is_named`, `a_key_that_is_not_a_string_is_not_quoted`, `a_download_goes_to_https_or_to_this_computer`, `a_plain_http_download_elsewhere_is_refused_before_any_request`, `a_download_over_the_cap_is_refused_and_leaves_no_file`, `a_download_cancelled_part_way_leaves_no_file`, `a_decoding_error_is_kept_by_its_field_only`, `a_stuck_phone_is_marked_while_its_guard_lives`; after the re-review `results_survive_a_server_outage`, `a_recover_that_hangs_is_cut_off_before_the_next_command`, `a_phone_is_recovered_once_when_first_registered`, `a_phone_whose_command_will_not_stop_is_left_out_of_registers` (a multi-thread runtime: the command holds its thread), `a_server_serial_is_logged_clean`; `tests/program.rs` (the built program): `a_configuration_that_cannot_be_used_exits_2_without_the_key`, `the_program_registers_and_stops_cleanly` (`SIGTERM` and exit 0 on Unix; on Windows the stop events need `GenerateConsoleCtrlEvent`, an `unsafe` call the workspace forbids, so there it only registers and is killed).
- [ ] `cargo test -p jeeta-device-bridge` red → green; **commit**.

### Task D2-T2: `AndroidAdbDriver`

**Files:** `src/driver/{mod.rs,android/{mod.rs,adb.rs,observe.rs,commands.rs}}`; fixtures
`tests/fixtures/{dump_whatsapp.xml,dump_numeric_refs.xml,idle_state_error.txt,getprop.txt,devices_l.txt}`
(take dumps from the emulator `jeeta_test`; scrub any personal data); `tests/android_driver.rs` with a fake
`AdbRunner` trait object returning fixture output.

```rust
#[async_trait]
pub trait PhoneDriver: Send + Sync {                    // as built in D2-T1 (src/driver/mod.rs)
    fn platform(&self) -> Platform;
    async fn report(&self) -> Result<PhoneReport, DriverError>;
    async fn execute(&self, cmd: &DeviceCommand, files: &dyn FileTransfer) -> Result<CommandResult, DriverError>;
    async fn recover(&self) {}                          // after a cut-off command or a panic; see below
}
pub trait FileTransfer: Send + Sync {
    async fn upload(&self, bytes: Vec<u8>, content_type: ContentType) -> Result<Uuid, DriverError>;
    async fn upload_file(&self, path: &Path, content_type: ContentType) -> Result<Uuid, DriverError>; // streams
    async fn download(&self, dest: &Path) -> Result<u64, DriverError>;
}
pub enum ContentType { Png, OctetStream }
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
- ADBKeyBoard (`com.android.adbkeyboard/.AdbIME`, 2.0) works on it, but a broadcast sent right after `ime set` is
  silently lost: the IME must first bind to the focused field. After `ime set`, poll `dumpsys input_method` until
  `mCurMethodId` names AdbIME and a `mServedInputConnection` is present (a bounded wait the driver names as a
  constant; past it → `adb_error`, IME restored). `am broadcast` answers `result=0` whether or not the text
  arrived, so the result code proves nothing. Tests `unicode_text_waits_for_ime_binding`,
  `unicode_text_ime_never_binds_is_a_failure_and_restores_ime`.
- Auto-rotate is on: the phone was seen at `ROTATION_270` (1650x720). Screen size and rotation are read on every
  observation, never cached from `report`. Test `observe_reports_rotated_screen`.
- Installing an APK is not a bridge command, and the device's own settings decide it: `adb install` answers
  `INSTALL_FAILED_USER_RESTRICTED` (MIUI "Install via USB" off), and the shell user can't start the package
  installer (`needs … REQUEST_INSTALL_PACKAGES`). The operations doc (D3-T2) gives the manual path: push to
  `/sdcard/Download`, open the system Files app, tap the APK. On MIUI the post-install scan screen carries an
  advert with a large "Install" button for another app, so don't tap it.

Specifics:
- `observe`: `uiautomator dump /sdcard/jeeta_ui.xml` then `cat`; output containing `ERROR: could not get idle state` (exit 0) → wait 700 ms, retry once, else `ScreenBusy`; a file without `<node` → `ScreenBusy`; decode named and numeric character references; distill to `Element`s (skip invisible/zero-size; tap point = bounds centre); cap 300 → `truncated`; foreground app from `dumpsys window` (`mCurrentFocus`); screen from `wm size` + rotation.
- `tap_on`: dump, match `text`/`id` (`resource-id`)/`desc` (`content-desc`) exact first then contains (unless `exact`), tap the best match's tap point; none → `ElementNotFound` with up to 20 visible labels in `detail`.
- `text`: ASCII → `input text` with spaces as `%s` and shell metacharacters escaped for the device shell; non-ASCII → if ADBKeyBoard present: `ime set com.android.adbkeyboard/.AdbIME`, `am broadcast -a ADB_INPUT_B64 --es msg <base64>`, restore the previous IME; else `UnicodeUnsupported`.
- feature detection: `pm list packages com.android.adbkeyboard` → `text.unicode`; all kinds of §4.1 reported for Android.
- `shell`: `adb -s S shell <argv…>` as separate args, each argument quoted for the device shell; capture exit code (`adb shell` ≥ API 24 propagates it), stdout/stderr capped at 64 KiB each. After quoting, the driver checks the final command-line length against a limit it names as a constant (the quoting can make a command that validated longer) and refuses an over-long one before any `adb` call with `bridge_error` and a clear `detail` (the length and the limit). The ASCII `text` path does the same check after its escaping.
- `screenshot`: `exec-out screencap -p` bytes → `FileTransfer::upload(bytes, ContentType::Png)` → `File{file_id}`.
- `push_file`: `FileTransfer::download(temp)` (the transfer holds the signed address; the driver never sees it) →
  `adb push`; `pull_file`: `adb pull` to temp → `FileTransfer::upload_file(temp, ContentType::OctetStream)`, which
  streams the file instead of holding it in memory.

What the loop (D2-T1) asks of the driver:
- **`execute` is cancel-safe.** The loop cancels a command by dropping its future: at `Timing::command_timeout`
  (120 s; `Timing::transfer_timeout` for `push_file`/`pull_file`) and at shutdown. Every `adb` child is spawned with
  `kill_on_drop(true)` (`tokio::process::Command`), so a cancelled command leaves no `adb` running; every temp file is
  held in a guard that removes it on drop.
- **What `Drop` cannot do goes in `recover()`.** `Drop` cannot `.await`, so the IME a Unicode `text` command set is
  not restored by a guard. Decision (D2-T1 review): the cooperative cleanup path is `async fn recover(&self)` on
  `PhoneDriver`, not a cancellation token passed into `execute`. The worker awaits it after a command was cut off
  (timeout, shutdown) or its driver panicked, once that command's future is gone and before the phone's next command,
  bounded by `RECOVER_TIMEOUT` (30 s). The Android driver records "an IME to restore" when it sets ADBKeyBoard and
  clears it when it restores it on the normal path; `recover()` restores what is recorded and is cheap when nothing
  is. Test `recover_restores_the_ime_after_a_cut_unicode_text`.
- **`recover()` also runs once per phone when the bridge starts** (each phone's worker begins with it), when the
  driver has recorded nothing: a bridge killed mid-command (a crash, a closed console) may have left ADBKeyBoard as
  the phone's IME. So on that first call the Android driver checks the phone itself: when `settings get secure
  default_input_method` names `com.android.adbkeyboard/.AdbIME`, it restores the phone's previous IME (or the
  first other enabled one, `ime list -s`). Test `recover_at_start_restores_a_left_adbkeyboard`.
- **`report()` never waits behind `execute`.** It runs at every heartbeat, possibly during a 30-minute `push_file` on
  the same phone, so it takes no lock a command holds. The first `adb devices` starts the adb server and can outlast
  `Timing::report_timeout` (10 s): the loop then stands in the last good listing (none on the very first) and the last
  good report, so a slow `adb` does not take a phone offline. Test `report_does_not_wait_behind_execute`.
- **The registry keeps its drivers.** `PhoneRegistry::attached()` returns the same `Arc` for the same serial while
  the phone stays attached (an iOS driver will hold a WebDriverAgent session and its port forward).
- **A transfer has its own bound.** `adb push`/`adb pull` of a large file is bounded by a driver constant (e.g.
  `ADB_TRANSFER_TIMEOUT`) within `Timing::transfer_timeout`, not by the 120 s of other commands; every other `adb`
  call by a shorter constant of its own.
- [ ] **Tests first:** `dump_distills_elements`, `numeric_references_decoded`, `idle_state_retried_then_screen_busy`, `tap_on_exact_beats_contains`, `tap_on_missing_lists_labels`, `ascii_text_escapes_for_device_shell`, `unicode_text_uses_adbkeyboard_and_restores_ime`, `unicode_text_waits_for_ime_binding`, `unicode_text_ime_never_binds_is_a_failure_and_restores_ime`, `unicode_text_without_adbkeyboard_refused`, `observe_reports_rotated_screen`, `miui_theme_stack_trace_is_not_a_failure`, `inject_events_refusal_with_exit_0_is_a_failure`, `shell_passes_argv_separately`, `shell_overlong_after_quoting_refused_with_bridge_error`, `every_call_names_the_serial`, `report_merges_getprop`, `recover_restores_the_ime_after_a_cut_unicode_text`, `recover_at_start_restores_a_left_adbkeyboard`, `report_does_not_wait_behind_execute`, `registry_returns_the_same_driver_for_the_same_serial`.
- [ ] `cargo test -p jeeta-device-bridge` red → green; **commit** `feat(device-bridge): the Android driver`.

### Task D2-T3: Windows build in CI

**Files:** `.github/workflows/rust.yml`: job `device-bridge-windows` on `windows-latest`: `cargo test -p jeeta-device-bridge -p jt_devices -p jt_device_protocol` and `cargo build --release -p jeeta-device-bridge`, upload `jeeta-device-bridge.exe` as an artifact.
- [ ] Job green on the PR; **commit**.

---

## D3 — panel and docs

### Task D3-T1: phone card, pairing, command log

**Files:** `rust/panel/src/api/devices.ts`, `rust/panel/src/pages/capabilities/PhoneCard.tsx` (+ `.test.tsx`), wiring in the Capabilities page's Devices tab, i18n `en.json`/`tr.json`.
Card: platform, model, OS, status with heartbeat age, bridge version, features (Unicode yes/no with the hint "install **and enable** ADBKeyBoard": the bridge reports `text.unicode` only when it is both installed and enabled as an input method), last 20 commands (kind, status, time; expand to args/result), "Pair a bridge" (issues an API key with exactly `devices.bridge` via the existing API-key use case, shown once, with the three install steps; offered to who holds `api_keys.manage` and `devices.bridge`, which is all that pairing needs, as in voice).
- [ ] **Tests first:** `renders_phone_facts_and_status`, `unicode_hint_when_feature_missing`, `pairing_shows_key_once`, `command_log_expands_args`.
- [ ] `pnpm --dir rust/panel test`, typecheck, build; **commit**.

### Task D3-T2: operations doc

**Files:** `docs/operations/device-bridge.md`: enabling Developer options + USB debugging, accepting the RSA prompt, `adb devices`, installing ADBKeyBoard (and that it must be enabled as an input method), config file, running the bridge, running it at logon (Task Scheduler), troubleshooting (`unauthorized`, `offline`, screen busy, Unicode refused). **Commit**.

---

## D4 — end to end

### Task D4-T1: emulator, then a real phone

- [ ] **Precondition.** An existing API key does not gain the new permissions: a key's scopes are snapshotted when it is issued. Before the end-to-end run, issue a fresh owner agent key with `devices.work`, and a bridge key with exactly `devices.bridge`; an older key does not carry them.
- [ ] Emulator `jeeta_test` (`emulator.exe -avd jeeta_test -no-window -gpu swiftshader_indirect -port 5554`) + bridge against **staging** with a `devices.bridge` key; via MCP on staging: `devices.list` → `observe` → `tap_on` → `text` (ASCII) → `shell ["getprop","ro.product.model"]` → `screenshot` → `pull_file`; each appears in the ledger with its args.
- [ ] Real Android phone over USB on the owner's PC: same sequence; Unicode text with ADBKeyBoard installed (owner approves the APK download).
- [ ] Checks on the Redmi 10C (Android 13, MIUI 14) that D2-T2 could not make, since it ran read-only captures only:
  - Recapture `dumpsys input_method` right after `ime set com.android.adbkeyboard/.AdbIME` with a text field focused, a few times in quick succession. Confirm that the driver's bind check (`commands::bound_to_a_field`: `mCurMethodId`, the manager's `mCurId=… mBoundToMethod=true`, the client's `mBindSequence=… mCurId=…`, a served connection) passes only once a broadcast types, and replace the hand-edited fixtures `input_method_{adbime_unbound,in_between,bound}.txt` with the captures (scrubbed).
  - Unicode `text` end to end: if text goes missing (the broadcast answers, nothing is typed), add a short pause between the `am broadcast` and putting the input method back (`commands::type_unicode`), as ADBKeyBoard may still be committing the text when it is switched away.
  - `launch_app` (`monkey -p … 1`): confirm that MIUI's `theme_compatibility.xml` stack trace, if `monkey` prints it, does not fail the command (the driver ignores that trace; seen so far from `uiautomator` only).
  - `observe`: confirm `uiautomator dump /data/local/tmp/jeeta_ui.xml` writes there (the folder is the shell user's, mode 771, as read in D2-T2) and that the file is gone after the observation.
- [ ] Manual Windows stop checks on the owner's PC. These cover what CI can't test, because `unsafe_code = "forbid"` rules out `GenerateConsoleCtrlEvent`:
  - Ctrl+C during a long command: the "Ctrl+C: the bridge stops" line, exit code 0, and the cut-off `bridge_error` result in the ledger.
  - Closing the console window during a command: the result is posted within `HURRIED_GRACE` (2 s).
- [ ] Record results in `docs/operations/device-bridge.md` ("verified on").

---

## Self-review against the spec

- §1 non-goals → no policy in `validate`/`act` (D1-T1 `no_access_policy_in_validation`). Lessons → D2-T2 tests.
- §2 units → file structure; protocol shared → D1-T2; bridge never depends on server crates → D2-T1 archtest.
- §3 kernel → D0-T1 with the unedited-voice-tests gate.
- §4 commands/lifecycle/observation → contracts + D1-T1 + D2-T2.
- §5.1–5.6 → D1-T3 (table), D1-T5 (capabilities, facts merge, files), D1-T6 (negotiation, tools, ledger vs tracing), D1-T7 (retention, expiry).
- §6 bridge → D2; §7 panel → D3-T1; §8 testing → each task + D4; §9 iOS → not in this plan (D5); §10 seams → `act` is the single entry point a policy check will wrap.
