# Voice bridge

The voice bridge is the sidecar that is a workspace's phone line for agent calls (spec
`docs/superpowers/specs/2026-10-27-agent-voice-calls-design.md` §4, §10). It registers with
NetGSM's Netsantral as a software SIP extension, turns the caller's speech into text and the
agent's sentences into speech, and talks to Jeeta as an HTTPS **client**: Jeeta never connects
to it. It runs on the same host as `jeeta serve` (owner decision D1) with self-hosted Vosk
(speech-to-text) and Piper (text-to-speech) (owner decision D4).

This page covers what Jeeta expects of a bridge: the key it calls with, the three routes it
uses, how its heartbeat shows in the panel, and the host setup. The sidecar's own code, binary
and unit file arrive with plan task V1-T3 (`rust/bridge/voice/`); until then a bridge registers
only in tests.

## 1. Gate V1 (owner, before any bridge runs)

Gate V1 checks that NetGSM lets a software SIP user agent on this host use an extension. On the
Jeeta host, with a command-line SIP client (`baresip` or `pjsua`) and the credentials of the
extension made for the bridge (Netsantral portal: Dahililer, the extension, its SIP password):

1. **Register**: the client registers the extension with the SIP server the portal shows for it.
2. **Inbound**: route an inbound call to the extension (portal: Çağrı akışı), call the
   workspace's number from a mobile, answer in the client: does it ring, is there audio both
   ways?
3. **Outbound**: dial a mobile from the extension: does it connect, with audio both ways?

Record pass or fail per step. If NetGSM refuses the extension, stop and report: the SIP Trunk
add-on is not approved in advance (owner decision D1).

## 2. The bridge's API key

The bridge calls Jeeta with an API key issued with the single scope `calls.bridge`:

- In the panel: **API anahtarları**, a new key with the one scope **Ses köprüsü olarak
  çalışma** (`calls.bridge`); or `jeeta.api_keys.create` with
  `{"name": "voice bridge", "scopes": ["calls.bridge"]}`.
- Only an owner or a manager can issue it: they are the roles holding `calls.bridge`.
- A key holding any other permission is refused by every bridge route (`403`,
  `details.reason = "bridge_key_only"`), and a key holding only `calls.bridge` reaches nothing
  else: the bridge is handed the numbers it dials, which no agent output shows. A panel session
  cookie is never accepted on these routes.
- The plaintext is shown once. Keep it in the bridge's environment file (section 5), never in a
  command line, a log or Git. Revoking the key in the panel stops the bridge at its next call.

The bridge acts as the system component `voice_bridge`, not as an agent connection: its
heartbeat never makes an agent look checked in.

## 3. Protocol

Every request carries `Authorization: Bearer <key>`; `POST` requests also carry
`X-Requested-With: jeeta-panel` (the API's request-header check applies to every mutating
request) and a JSON body. Errors are `{ "code", "message", "details" }`. The workspace must be
active (`423 WORKSPACE_INACTIVE` otherwise); no approved strategy is needed.

### `POST /api/voice/bridge/register` (every 15 seconds)

```json
{
  "extension": "101",
  "codecs": ["PCMA", "PCMU"],
  "max_calls": 1,
  "stt": { "engine": "vosk", "model": "vosk-model-small-tr-0.3" },
  "tts": { "engine": "piper", "voice": "tr_TR-fahrettin-medium" },
  "version": "0.1.0"
}
```

Answer: `{ "capability_id", "status": "verified", "heartbeat_s": 15 }`. The first registration of
an extension declares its `voice_bridge` capability ("Voice bridge 101", the extension as its
external id); an owner may also declare it first in the panel with the extension as its external
id. Each registration verifies the capability and stores what it reported under
`connector_public.bridge`. Extension: 1 to 16 digits; at most 8 codecs; `max_calls` 1 to 8;
engine names `[a-z0-9_-]{1,32}`; model, voice and version 1 to 128 characters.

### `GET /api/voice/bridge/commands?wait_s=25&extension=101`

Long-polls for at most `wait_s` seconds (25 at most, and when left out); `extension` may be
left out while the workspace has one bridge. Answer:

```json
{ "commands": [ { "id": "…", "call_id": "…", "bridge_call_id": "…", "kind": "dial", "payload": { … } } ],
  "timed_out": false }
```

`kind` is one of `answer`, `dial`, `say`, `play`, `record`, `transfer`, `hangup`; `payload` holds
the command's fields (`jt_calls::Command`). For an outbound call the bridge uses the command's
`bridge_call_id` as its id of the call. A command handed out is leased: it is handed out again
when the bridge has not acknowledged it within 10 seconds, so the bridge acts on a command `id`
once and ignores a repeat.

### `POST /api/voice/bridge/events`

```json
{ "events": [
  { "bridge_call_id": "…", "bridge_seq": 1, "at": "2026-10-28T09:00:01Z", "kind": "ringing" },
  { "bridge_call_id": "…", "bridge_seq": 2, "at": "2026-10-28T09:00:04Z", "kind": "command_done", "id": "…" }
] }
```

At most 100 events. `bridge_seq` counts each call's events up from 1. Kinds: `inbound`,
`ringing`, `answered`, `utterance` (`text`, `is_final`, `confidence?`, `stt_ms?`), `dtmf`
(`digit`), `said` (`seq`, `interrupted_at_char?`, `tts_ms?`), `silence` (`ms`), `recording`
(`file_ref`), `hangup` (`cause`), `error` (`failure_line`), `command_done` (`id`, which
acknowledges a command). Answer: `{ "accepted", "duplicates", "unmatched" }`.

Each event is applied once by its `(bridge_call_id, bridge_seq)`: resending a batch after a
timeout is safe. A batch that does not validate is refused whole (`422 VALIDATION`, naming the
event); the bridge drops it rather than resending it. Events of a call Jeeta has no agent
session for are counted `unmatched` (inbound calls are handled from phase V2 on). An event's
`at` is believed up to a minute before it arrives.

## 4. Heartbeat and the panel

- The capability reads **verified** while the last registration is at most 60 seconds old and
  **stale** after that; agent calls through a stale bridge are refused (`bridge_offline`).
- The `voice_bridge_health` job (every minute) marks it **unreachable** once the last
  registration is more than 10 minutes old, and writes `calls.bridge.offline` to the ledger. The
  next registration verifies it again and writes `calls.bridge.online`.
- While it is declared, stale or unreachable, `jeeta.work.pending` lists `voice_bridge_offline`
  for the agent, and the panel's home page shows it.
- Its card on the **Kabiliyetler** page shows the extension, the engines, the version, how many
  calls it carries and how long ago it last registered. It cannot be verified by evidence: only
  its registration verifies it.

## 5. Host setup

The bridge runs as its own system user beside `jeeta.service`, with its secrets in a root-owned
environment file (`/etc/jeeta/voice-bridge.env`, mode 0600):

```ini
JEETA_BASE_URL=https://<the public address of this Jeeta>
JEETA_BRIDGE_KEY=<the calls.bridge key>
SIP_SERVER=<the SIP server the Netsantral portal shows for the extension>
SIP_USER=<the extension>
SIP_PASSWORD=<the extension's SIP password>
STT=vosk:/var/lib/jeeta-voice-bridge/models/tr
TTS=piper:/var/lib/jeeta-voice-bridge/voices/tr_TR-fahrettin-medium.onnx
```

Jeeta never stores the SIP password: it lives only in this file. The host needs outbound UDP to
the SIP server and the RTP port range the bridge is configured with, and the CPU and memory for
Vosk and Piper beside Jeeta.

A unit in the shape of `jeeta.service` (V1-T3 ships the final one as
`rust/bridge/voice/systemd/jeeta-voice-bridge.service`):

```ini
[Unit]
Description=Jeeta voice bridge
After=network-online.target jeeta.service
Wants=network-online.target

[Service]
Type=simple
User=jeeta-voice-bridge
Group=jeeta-voice-bridge
WorkingDirectory=/var/lib/jeeta-voice-bridge
EnvironmentFile=/etc/jeeta/voice-bridge.env
ExecStart=/opt/jeeta-voice-bridge/current/jeeta-voice-bridge
Restart=on-failure
RestartSec=5s
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/jeeta-voice-bridge
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

The bridge must never log its key, an event's words, audio paths that hold a number, or a phone
number.
