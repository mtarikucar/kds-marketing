# Device bridge — Jeeta drives a physical phone (Rust)

Date: 2026-10-28. Status: approved by the owner in chat (2026-10-28), with three changes to the first draft:
no app allowlist, no rate caps, free shell commands allowed; every command is logged.

## 1. Goal and non-goals

**Goal.** An agent connected to Jeeta (Claude, Codex) controls a physical phone through Jeeta: it reads the
screen, taps, types, swipes, opens URLs and apps, runs shell commands, moves files, takes screenshots. This
ports v1's phone bridge (`backend/src/modules/marketing/devices/`, Electron desktop app) to the Rust stack so
the capability survives the cutover from v1 to Rust.

**Platforms.** Android now (adb). iPhone later, behind the same contract: the owner has not decided how to sign
WebDriverAgent (paid Apple Developer account, a Mac, or a free 7-day Apple ID), so the iOS driver is designed
for but not built (§9).

**Non-goals (owner, 2026-10-28).**
- **No access restrictions in this phase.** No app allowlist, no per-hour caps, no human approval per
  command, no URL-scheme filter. Security is a separate layer the owner will specify later (§10 keeps the
  seams for it).
- No phone-side app (Android AccessibilityService / Kotlin): one architecture for both platforms beats a
  second one that cannot exist on iOS.
- No Appium: a Node.js server in the middle would own the behaviour we need to own.

**Kept from v1 (lessons, not restrictions).**
- *A queued command is not a done command.* Every layer says which state a command is in.
- `TAP_ON` resolves the element on the device in one step: dump-then-tap-a-coordinate races a moving screen.
- `uiautomator dump` refuses a moving screen with exit code 0 and "ERROR: could not get idle state." — that
  is an error, retried once after 700 ms, never an empty screen.
- uiautomator writes numeric character references (`&#10;`); decode them.
- `adb shell input text` maps ASCII keycodes: non-ASCII text is typed *wrong* and reported as done. Unicode
  goes through an IME that accepts it (ADBKeyBoard) when installed, else the command is refused with the
  reason (correctness, not security).
- A heartbeat merges device properties, never replaces them (v1 lost model/OS when adb hiccuped).
- Feature negotiation instead of a version compare: the bridge reports what it can do (§5.3).

## 2. Architecture

```
agent (MCP) ──► Jeeta server ──► device_commands (queue, tenant DB)
                                     ▲            │ long-poll (lease)
                                     │ results    ▼
                              jeeta-device-bridge (Rust, on the PC the phone is plugged into)
                                     │  PhoneDriver trait
                              ┌──────┴───────┐
                        AndroidAdbDriver   IosWdaDriver (later)
                              │                 │
                          adb (USB/Wi-Fi)    go-ios + WebDriverAgent
```

The server never reaches the phone: the phone is on a desk, the server in a data centre. The bridge pulls
commands, acts, and pushes results. This is the same shape as the voice bridge (V1-T1, `usecases/calls/bridge.rs`),
so the two share one kernel (§3).

### Units

| Unit | Kind | Purpose | Depends on |
|---|---|---|---|
| bridge kernel (`jt_app::usecases::bridges`) | app module | lease/redeliver/long-poll/heartbeat/health shared by every bridge | ports `BridgeQueue`, `BridgeSignals`, capabilities |
| `jt_devices` | domain crate (pure) | command vocabulary, validation, lifecycle, observation model, platform feature names | `serde`, `time` |
| `jt_device_protocol` | shared crate (pure) | the wire types between server and bridge (request/response bodies), versioned | `jt_devices` |
| `usecases/devices/*` | app | agent use cases (list/observe/act/command_get) + bridge use cases (register/commands/results/files) | kernel, `jt_devices`, files, ledger |
| `jt_pg` repos | adapter | `device_commands` persistence, RLS | migration |
| `jt_panel_http` routes, `jt_mcp` tools | adapters | bridge routes (bearer, single permission), MCP tools | use cases |
| `bridge/device` → `jeeta-device-bridge` | binary crate | the PC-side program; drivers | `jt_device_protocol`, `tokio`, `reqwest` (rustls); **never** `jt_pg`/`jt_app` |
| panel | React | phone card, pairing, command log | API |

`jt_device_protocol` is the single source of truth for the wire format: the server and the bridge compile
against the same structs, so they cannot drift (the voice bridge's sidecar is not Rust and cannot share this).
The bridge crate must build on Windows (no `jt_pg`), which keeps it buildable and testable on the owner's PC.

## 3. Shared bridge kernel (refactor of V1-T1)

The voice bridge and the device bridge do the same five things. They move into one kernel, with the voice
bridge as its first user, the device bridge its second:

1. **Register / heartbeat** every 15 s: declares-or-verifies the bridge's capabilities, merges reported facts,
   `last_verified_at` is the heartbeat; stale after 60 s, unreachable after 10 min by a 1-minute health job,
   `*.online` / `*.offline` ledger entries and a `*Offline` work item.
2. **Commands long-poll** ≤ 25 s, leasing the oldest unacknowledged commands in queue order; a command not
   acknowledged within 10 s is handed out again; the bridge acts on a command id once.
3. **Results/events** batch, applied at most once per key.
4. **Signals**: a per-workspace `Notify` registry (process-local, like `OpsSignals`; a multi-instance deployment
   degrades to short polling) wakes a poll when a command is queued and wakes an agent waiting on a result.
5. **Auth**: an API key whose permission set is exactly one bridge permission (`calls.bridge`,
   `devices.bridge`); the session cookie is never read; the bridge acts as `Actor::System { component }`.

**Order.** V1-T2 (agent voice session) is changing the voice bridge's poll right now. The kernel is extracted
after V1-T2 merges (step D0), voice moves onto it unchanged in behaviour (its tests are the proof), then
devices are built on it. No second copy of lease/redeliver logic is written.

## 4. Domain: `jt_devices`

### 4.1 Commands

| Kind | Args | Android (adb) | iOS (WDA, later) |
|---|---|---|---|
| `observe` | `screenshot: bool` | `uiautomator dump` → distilled elements; `screencap -p` | `/source` → elements; `/screenshot` |
| `tap` | `x, y` | `input tap` | `/wda/tap` |
| `tap_on` | exactly one of `text`, `id`, `desc`; `exact: bool` | dump + match + tap in one step | `/elements` + `/click` |
| `long_press` | `x, y, ms` | `input swipe x y x y ms` | `/wda/touchAndHold` |
| `swipe` | `x1,y1,x2,y2, ms ≤ 5000` | `input swipe` | `/wda/dragfromtoforduration` |
| `text` | `value ≤ 4000` | ASCII: `input text`; Unicode: ADBKeyBoard broadcast; else refused `unicode_unsupported` | `/wda/keys` (Unicode native) |
| `key` | `back, home, enter, app_switch, delete, volume_up/down, power` | `input keyevent` | `/wda/pressButton` (home, volume) |
| `open_url` | any URL/intent string | `am start -a android.intent.action.VIEW -d` | Safari / deep link |
| `launch_app` | `app_id` (package / bundle id) | `monkey -p … 1` or `am start` | `/wda/apps/launch` |
| `shell` | `argv: [string]` (no shell string; argv array) | `adb shell` argv | `unsupported_on_platform` |
| `push_file` | `file_id` (Jeeta file), `dest` | bridge downloads the signed URL, `adb push` | `unsupported_on_platform` (v1 of iOS) |
| `pull_file` | `path` | `adb pull`, bridge uploads → Jeeta file | `unsupported_on_platform` |
| `screenshot` | — | `screencap -p` | `/screenshot` |

`shell` takes an argv array, passed to `adb shell` as separate arguments: free commands are allowed (owner),
but the bridge never concatenates a string into a host shell, so a command cannot escape into the PC.

### 4.2 Lifecycle

`queued → leased → done | failed | expired | canceled`.
- `leased` again after 10 s without acknowledgement (redelivery, §3); the bridge dedups by command id.
- `expired` when not leased within `expires_in` (default 5 min) — a bridge that was off must not replay a
  stale `tap` hours later.
- `failed` carries a stable `reason` (`device_offline`, `element_not_found`, `unicode_unsupported`,
  `unsupported_on_platform`, `adb_error`, `screen_busy`, `timeout`, `bridge_error`) and a bounded detail line.
- Results are idempotent by command id.

### 4.3 Observation

`{ screen: {w, h, rotation}, foreground_app, elements: [{text, id, desc, class, bounds, tap_point, clickable,
editable, focused}], screenshot_file_id? }`. Elements are distilled (no XML): a model reads a list, not a tree.
Element count capped at 300 with `truncated: true`.

## 5. Server

### 5.1 Persistence

Migration `00NN_device_bridge` (next free number at implementation time): `device_commands` (id uuid v7,
workspace_id, capability_id → the phone, seq bigint for queue order, kind, payload jsonb, status, attempts,
leased_at, expires_at, result jsonb, reason, detail (the failure line, at most 300 characters), requested_by actor
jsonb, created_at, done_at), ENABLE + FORCE RLS, workspace-scoped policy, indexes on
`(workspace_id, capability_id, status, seq)` (the queue), `(workspace_id, expires_at)` for commands not finished
yet (the expiry sweep) and `(workspace_id, capability_id, seq)` (a phone's log). Results live on the row;
screenshots and pulled files are Jeeta files (`jt_files`), referenced by id.

### 5.2 Capabilities

Each attached phone is a `phone` capability (`KindGroup::Device`, `Reach::Device`), external id
`{platform}:{serial}` (e.g. `android:R58N…`), verified by the bridge's heartbeat like `voice_bridge`
(`capability.verify` refuses it). Its `connector_public` keeps the merged facts: platform, model, OS version,
screen size, features, bridge id and version, last seen. A phone that disappears from a heartbeat goes stale on
the same clock as a silent bridge.

### 5.3 Feature negotiation

The bridge reports per phone the command kinds it can run (`features: ["observe","tap",…,"text.unicode"]`).
`act` refuses a kind the phone's bridge does not report (`unsupported_by_bridge`, naming the kind) before
queuing — the honest refusal arrives when the agent asks, not later on a desk.

### 5.4 Use cases and catalog

Agent (MCP + panel), permission `devices.work`; pairing (issuing a bridge key) is `api_keys.manage` plus holding
`devices.bridge`, as in voice. Owner and manager hold all three; `rep` holds none (a phone reaches everything on it).
There is no `devices.manage` in this build: it would gate nothing, and access policy is a later, separate layer (§10):
- `devices.list` — phones with status, platform, model, features, last seen.
- `devices.observe {capability_id, screenshot?, wait_s ≤ 20}` — queues `observe`, waits for the result.
- `devices.act {capability_id, command, wait_s ≤ 20}` — validates, queues, waits; returns the result or
  `{status:"queued"|"leased", command_id}` when the wait ends first.
- `devices.command_get {command_id, wait_s ≤ 20}` — the state/result of one command.
- `devices.commands {capability_id, limit}` — recent commands (the log view).

Bridge (panel-only routes `/api/devices/bridge/*`, permission `devices.bridge`, exact-set key, no MCP tool):
`register`, `commands` (long-poll), `results` (batch), `files` (upload a screenshot/pulled file → file id;
download for `push_file` uses a signed URL in the command).

Catalog pins, gate lists, panel-only rows, permission lists and table/migration pins change together, as for
every use case.

### 5.5 Logging (owner: every command is logged)

- **Ledger** (the tenant's audit log, visible to the owner): `devices.command.queued` with the full command
  (kind and args, including shell argv and typed text), actor, phone; `devices.command.finished` with status,
  reason, duration, and a reference to the result (not the observation itself, which can be large).
- **Server logs** (`tracing`): command id, kind, phone capability id, status, duration — never args, text,
  observation content, phone numbers or file contents.
- **Bridge logs** (on the PC): same rule as server logs.

### 5.6 Retention

Screenshots and pulled files expire after 7 days (storage hygiene, not access control); command rows are kept
like ledger history.

## 6. The bridge program (`jeeta-device-bridge`)

- Rust, `tokio`, one binary for Windows/macOS/Linux; config file + env: Jeeta base URL, bridge key, optional
  device serial filter, adb path.
- Loop: register every 15 s with the attached phones (`adb devices -l`, `getprop` for model/OS/screen,
  feature detection incl. ADBKeyBoard), long-poll commands, run each through the phone's driver with a
  per-command timeout, post results (batch, retried idempotently), upload files.
- `PhoneDriver` trait: `info()`, `observe(opts)`, `execute(cmd) -> Result<CommandResult, DriverError>`.
  `AndroidAdbDriver` runs `adb` with argv arrays only, `-s <serial>` on every call.
- Runs as a console program first; a Windows service wrapper and an installer are packaging steps (D3), not
  design.
- Built in CI for Windows (`x86_64-pc-windows-msvc`) as a release artifact.

## 7. Panel

Phone card on the Capabilities → Devices tab: platform icon, model, OS, status (heartbeat age), bridge version,
features, recent commands (status, kind, time; open to see args/result), "pair a bridge" (issues a
`devices.bridge` key once, with install steps). TR + EN.

## 8. Testing

- `jt_devices`: validation and lifecycle unit tests.
- `jt_device_protocol`: round-trip serde tests (the bridge and server agree).
- Kernel: the voice bridge's existing tests must pass unchanged after the extraction, plus kernel tests.
- Server: `jt_app/tests/devices_*.rs` with a scripted fake bridge (register → poll → result), redelivery after
  10 s, expiry, feature refusal, ledger entries carry args while tracing does not.
- Bridge: driver tests against recorded adb outputs (fixtures from v1's emulator runs: uiautomator dumps incl.
  numeric references and the "could not get idle state" case); a fake Jeeta server for the loop.
- End to end on this PC's Android emulator (`%LOCALAPPDATA%\Android\Sdk`, AVD `jeeta_test`), then a real
  Android phone over USB.

## 9. iOS later (designed-for)

`IosWdaDriver`: WebDriverAgent on the iPhone (signed per the owner's later choice), started and port-forwarded
by `go-ios` (`ios runwda`, `ios forward`; iOS 17+ needs `ios tunnel start`, on Windows the `wintun` driver and
an elevated shell). Commands map per §4.1; `shell`, `push_file`, `pull_file` report `unsupported_on_platform`
until a mapping exists. Platform `ios`, external id `ios:{udid}`. Nothing on the server changes: features
decide what an iPhone can do.

## 10. Seams for the later security layer

Not built now (owner). The layer will hook in at three points that already exist in this design: a policy
check in `devices.act` before queuing (allowlists, caps, approvals), the per-command ledger entries (review),
and the `phone` capability's policy object (per-device rules).

## 11. Steps

- **D0** — extract the bridge kernel from the voice bridge (after V1-T2 merges); voice behaviour unchanged.
- **D1** — `jt_devices`, `jt_device_protocol`, migration, server use cases, routes, MCP tools, ledger.
- **D2** — `jeeta-device-bridge` with `AndroidAdbDriver`; fixtures; Windows build in CI.
- **D3** — panel card, pairing, docs (`docs/operations/device-bridge.md`), packaging.
- **D4** — emulator end-to-end on this PC, then a real phone.
- **D5** — iOS driver after the owner's signing decision.
