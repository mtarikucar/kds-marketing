//! `jeeta.devices.*`: the workspace's phones (spec `2026-10-28-device-bridge-design.md` §5.4). An
//! agent lists the phones, reads a screen, runs a command on a phone and follows it, and reads a
//! phone's log, all through the device bridge on the PC the phone is plugged into. A queued command
//! is not a done command: every answer says where the command stands. The bridge's own surface
//! (`devices.bridge.*`) has no tool here.

use jt_app::ctx::Ctx;
use jt_app::error::AppError;
use jt_app::ports::devices::{
    DeviceKey, MAX_APP_ID_CHARS, MAX_ARG_CHARS, MAX_LONG_PRESS_MS, MAX_PATH_CHARS, MAX_SHELL_ARGS,
    MAX_SHELL_TOTAL_CHARS, MAX_SWIPE_MS, MAX_TEXT_CHARS, MAX_URL_CHARS,
};
use jt_app::usecases::Deps;
use jt_app::usecases::devices::agent::{
    self, ActInput, LogQuery, MAX_SCREEN_PX, MAX_WAIT_S, ObserveInput, WaitQuery,
};
use jt_capability::CapabilityId;
use jt_tenancy::Permission;
use schemars::{Schema, json_schema};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use super::{NoArgs, ToolDef, args, listed, to_json};
use crate::registry::{ToolFuture, schema_for};

pub(super) fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            use_case: "devices.list",
            description: "List the workspace's phones: capability_id, name, online (true when a \
                          command can be queued for it now: its bridge listed it within the \
                          last minute), status, platform, serial, model, os_version, screen {w, \
                          h, rotation}, features (the command kinds its bridge runs, and \
                          text.unicode when it can type text outside ASCII), unicode, bridge_id, \
                          bridge_version and last_seen_at. Returns {phones: [...]}. \
                          [risk: READ]",
            permission: Permission::DevicesWork,
            schema: schema_for::<NoArgs>,
            run: list,
        },
        ToolDef {
            use_case: "devices.observe",
            description: "Read a phone's screen: queues an observe command for the phone \
                          (capability_id; screenshot true adds a screenshot) and waits up to \
                          wait_s seconds (at most 20, 20 when left out) for its bridge to \
                          answer. A queued command is not a done command. Status done carries \
                          result {kind: observation, screen {w, h, rotation}, foreground_app, \
                          elements: [{text, id, desc, class, bounds, tap_point, clickable, \
                          editable, focused}], truncated, screenshot_file_id} and file_url (the \
                          screenshot, readable for 10 minutes); tap an element at its tap_point \
                          or with tap_on. Status queued or leased means the wait ended first: \
                          follow it with jeeta.devices.command_get. Refused as \
                          jeeta.devices.act refuses. [risk: WRITE]",
            permission: Permission::DevicesWork,
            schema: observe_schema,
            run: observe,
        },
        ToolDef {
            use_case: "devices.act",
            description: "Run a command on a phone (capability_id from jeeta.devices.list) and \
                          wait up to wait_s seconds (at most 20, 20 when left out) for its \
                          result. command is one of: {kind: tap, x, y}; {kind: tap_on, text or \
                          id or desc, exact} (finds the element and taps it in one step); {kind: \
                          long_press, x, y, ms up to 10000}; {kind: swipe, x1, y1, x2, y2, ms up \
                          to 5000}; {kind: text, value up to 4000 characters} (types into the \
                          focused field; text outside ASCII needs the phone's text.unicode \
                          feature: ADBKeyBoard installed and enabled); {kind: key, key: back, \
                          home, enter, app_switch, delete, volume_up, volume_down or power}; \
                          {kind: open_url, url}; {kind: launch_app, app_id}; {kind: shell, \
                          argv: [program, arguments...]} (separate arguments, never one command \
                          line); {kind: push_file, file_id, dest}; {kind: pull_file, path}; \
                          {kind: screenshot}; {kind: observe, screenshot}. A queued command is \
                          not a done command: the answer {command_id, status, result, reason, \
                          detail, file_url, ...} is done or failed when the bridge answered in \
                          time (a failure's reason: element_not_found, unicode_unsupported, \
                          unsupported_on_platform, unsupported_by_bridge, adb_error, \
                          screen_busy, timeout, bridge_error, file_not_found or \
                          device_offline), queued (no bridge has taken it yet) or leased (the \
                          phone is running it) when the wait ended first: follow it with \
                          jeeta.devices.command_get. A command no bridge takes within 5 \
                          minutes expires; one expired with leased_at set was handed to the \
                          phone and may still finish: check it with jeeta.devices.command_get \
                          before running it again. Once a command is queued the answer is that \
                          command: an error answer means nothing was queued; after a dropped \
                          connection, check jeeta.devices.commands. Refused before anything is \
                          queued: VALIDATION with \
                          details.field for a bound, with details.reason unsupported_by_bridge \
                          (details.kind: the phone's bridge does not run it) or \
                          unicode_unsupported (text outside ASCII without text.unicode: install \
                          and enable ADBKeyBoard); CONFLICT with details.reason device_offline \
                          (no bridge listed the phone within the last minute) or \
                          phone_retired; NOT_FOUND for an unknown phone. Every command is \
                          written to the ledger with all its arguments. [risk: WRITE]",
            permission: Permission::DevicesWork,
            schema: act_schema,
            run: act,
        },
        ToolDef {
            use_case: "devices.command_get",
            description: "Read one device command (command_id from jeeta.devices.act or \
                          jeeta.devices.observe), waiting up to wait_s seconds (at most 20, 20 \
                          when left out, 0 answers at once) for it to end; answers at once when \
                          it has ended. A queued or leased command is not done yet: ask again. \
                          A command expired with leased_at set was handed to the phone and may \
                          still finish (its result then replaces expired): check it again \
                          before running it again. \
                          Returns {command_id, capability_id, kind, command, status, attempts, \
                          result, reason, detail, file_url, requested_by, created_at, \
                          expires_at, leased_at, done_at}. [risk: READ]",
            permission: Permission::DevicesWork,
            schema: command_get_schema,
            run: command_get,
        },
        ToolDef {
            use_case: "devices.commands",
            description: "List a phone's most recent commands (capability_id), newest first, \
                          limit 1 to 200 (50): the phone's log, each command with its kind, \
                          arguments, status, attempts, reason, detail, who asked and when, \
                          without its result (read one command's result with \
                          jeeta.devices.command_get). Returns {commands: [...]}. [risk: READ]",
            permission: Permission::DevicesWork,
            schema: commands_schema,
            run: commands,
        },
    ]
}

fn uuid(description: &str) -> Value {
    json!({ "type": "string", "format": "uuid", "description": description })
}

fn wait_s() -> Value {
    json!({
        "type": "integer",
        "minimum": 0,
        "maximum": MAX_WAIT_S,
        "description": "How long to wait for the command to end, in seconds (20 when left out, 0 answers at once).",
    })
}

/// A screen coordinate: at most the largest screen side a bridge reports
/// (`jt_device_protocol::MAX_SCREEN_PX`).
fn pixel(description: &str) -> Value {
    json!({ "type": "integer", "minimum": 0, "maximum": MAX_SCREEN_PX, "description": description })
}

fn text(max: usize, description: &str) -> Value {
    json!({ "type": "string", "minLength": 1, "maxLength": max, "description": description })
}

fn millis(max: u32, description: &str) -> Value {
    json!({ "type": "integer", "minimum": 1, "maximum": max, "description": description })
}

/// One kind of command: an object with `kind` set to `kind`, these `properties` and the
/// `required` ones, nothing else.
fn variant(kind: &str, properties: Value, required: &[&str]) -> Value {
    let mut props = Map::new();
    props.insert("kind".into(), json!({ "const": kind }));
    if let Value::Object(more) = properties {
        props.extend(more);
    }
    let mut needed = vec!["kind"];
    needed.extend_from_slice(required);
    json!({
        "type": "object",
        "properties": props,
        "required": needed,
        "additionalProperties": false,
    })
}

/// The JSON Schema of a device command: one object per kind, as `DeviceCommand` reads it.
pub(crate) fn command_schema() -> Value {
    let keys: Vec<&str> = DeviceKey::ALL.iter().map(|k| k.key()).collect();
    let mut tap_on = variant(
        "tap_on",
        json!({
            "text": text(MAX_TEXT_CHARS, "The element's text."),
            "id": text(MAX_TEXT_CHARS, "The element's resource id."),
            "desc": text(MAX_TEXT_CHARS, "The element's content description."),
            "exact": { "type": "boolean", "description": "Match the whole string, not a part of it (false when left out)." },
        }),
        &[],
    );
    if let Some(o) = tap_on.as_object_mut() {
        o.insert(
            "oneOf".into(),
            json!([
                { "required": ["text"] },
                { "required": ["id"] },
                { "required": ["desc"] },
            ]),
        );
    }
    json!({
        "description": "The command, tagged by kind.",
        "oneOf": [
            variant("observe", json!({ "screenshot": { "type": "boolean" } }), &[]),
            variant("tap", json!({ "x": pixel("Screen pixels."), "y": pixel("Screen pixels.") }), &["x", "y"]),
            tap_on,
            variant(
                "long_press",
                json!({ "x": pixel("Screen pixels."), "y": pixel("Screen pixels."), "ms": millis(MAX_LONG_PRESS_MS, "How long to press.") }),
                &["x", "y", "ms"],
            ),
            variant(
                "swipe",
                json!({
                    "x1": pixel("From, screen pixels."),
                    "y1": pixel("From, screen pixels."),
                    "x2": pixel("To, screen pixels."),
                    "y2": pixel("To, screen pixels."),
                    "ms": millis(MAX_SWIPE_MS, "How long the swipe takes."),
                }),
                &["x1", "y1", "x2", "y2", "ms"],
            ),
            variant(
                "text",
                json!({ "value": text(MAX_TEXT_CHARS, "Typed into the focused field; outside ASCII it needs the phone's text.unicode feature.") }),
                &["value"],
            ),
            variant("key", json!({ "key": { "type": "string", "enum": keys } }), &["key"]),
            variant("open_url", json!({ "url": text(MAX_URL_CHARS, "A URL, or any address the phone resolves (an intent).") }), &["url"]),
            variant("launch_app", json!({ "app_id": text(MAX_APP_ID_CHARS, "The package (Android) or bundle id (iOS).") }), &["app_id"]),
            variant(
                "shell",
                json!({
                    "argv": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": MAX_SHELL_ARGS,
                        "items": { "type": "string", "maxLength": MAX_ARG_CHARS },
                        "description": format!(
                            "The program and its arguments, each passed on its own \
                             ({MAX_SHELL_TOTAL_CHARS} characters in all at most, counting one \
                             separator per argument)."
                        ),
                    },
                }),
                &["argv"],
            ),
            variant(
                "push_file",
                json!({
                    "file_id": uuid("A file stored in the workspace."),
                    "dest": text(MAX_PATH_CHARS, "Where on the phone the file goes."),
                }),
                &["file_id", "dest"],
            ),
            variant("pull_file", json!({ "path": text(MAX_PATH_CHARS, "The file on the phone to copy into Jeeta.") }), &["path"]),
            variant("screenshot", json!({}), &[]),
        ],
    })
}

fn observe_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "capability_id": uuid("The phone, from jeeta.devices.list."),
            "screenshot": { "type": "boolean", "description": "Take a screenshot too (false when left out)." },
            "wait_s": wait_s(),
        },
        "required": ["capability_id"],
        "additionalProperties": false,
    })
}

fn act_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "capability_id": uuid("The phone, from jeeta.devices.list."),
            "command": command_schema(),
            "wait_s": wait_s(),
        },
        "required": ["capability_id", "command"],
        "additionalProperties": false,
    })
}

fn command_get_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "command_id": uuid("The command, from jeeta.devices.act or jeeta.devices.observe."),
            "wait_s": wait_s(),
        },
        "required": ["command_id"],
        "additionalProperties": false,
    })
}

fn commands_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "capability_id": uuid("The phone, from jeeta.devices.list."),
            "limit": { "type": "integer", "minimum": 1, "maximum": 200, "description": "How many (50 when left out)." },
        },
        "required": ["capability_id"],
        "additionalProperties": false,
    })
}

/// `raw` without its `key`, which names what the call is about; that id.
fn split(mut raw: Value, key: &str) -> Result<(Uuid, Value), AppError> {
    let id = raw
        .as_object_mut()
        .and_then(|o| o.remove(key))
        .unwrap_or(Value::Null);
    let id: Uuid = args(id)?;
    Ok((id, raw))
}

fn list<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let NoArgs {} = args(raw)?;
        listed("phones", &agent::list(deps, ctx).await?)
    })
}

fn observe<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (phone, rest) = split(raw, "capability_id")?;
        let input: ObserveInput = args(rest)?;
        to_json(&agent::observe(deps, ctx, CapabilityId(phone), input).await?)
    })
}

fn act<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (phone, rest) = split(raw, "capability_id")?;
        let input: ActInput = args(rest)?;
        to_json(&agent::act(deps, ctx, CapabilityId(phone), input).await?)
    })
}

fn command_get<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (id, rest) = split(raw, "command_id")?;
        let query: WaitQuery = args(rest)?;
        to_json(&agent::command_get(deps, ctx, id, query).await?)
    })
}

fn commands<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (phone, rest) = split(raw, "capability_id")?;
        let query: LogQuery = args(rest)?;
        listed(
            "commands",
            &agent::commands(deps, ctx, CapabilityId(phone), query).await?,
        )
    })
}

#[cfg(test)]
mod tests {
    use jt_app::ports::devices::DeviceCommand;

    use super::*;

    /// One command of every kind, every optional field set, at its bounds.
    fn samples() -> Vec<DeviceCommand> {
        use jt_app::ports::devices::ElementTarget;
        vec![
            DeviceCommand::Observe { screenshot: true },
            DeviceCommand::Tap { x: 1, y: 2 },
            DeviceCommand::TapOn {
                target: ElementTarget::Desc("Gönder".into()),
                exact: true,
            },
            DeviceCommand::LongPress {
                x: 1,
                y: 2,
                ms: MAX_LONG_PRESS_MS,
            },
            DeviceCommand::Swipe {
                x1: 0,
                y1: 0,
                x2: MAX_SCREEN_PX,
                y2: MAX_SCREEN_PX,
                ms: MAX_SWIPE_MS,
            },
            DeviceCommand::Text {
                value: "a".repeat(MAX_TEXT_CHARS),
            },
            DeviceCommand::Key {
                key: DeviceKey::AppSwitch,
            },
            DeviceCommand::OpenUrl {
                url: "https://example.com".into(),
            },
            DeviceCommand::LaunchApp {
                app_id: "com.whatsapp".into(),
            },
            DeviceCommand::Shell {
                argv: vec!["getprop".into(), "ro.product.model".into()],
            },
            DeviceCommand::PushFile {
                file_id: uuid::Uuid::nil(),
                dest: "/sdcard/x".into(),
            },
            DeviceCommand::PullFile {
                path: "/sdcard/x".into(),
            },
            DeviceCommand::Screenshot {},
        ]
    }

    /// Every command kind's sample, serialized as the bridge reads it, fits its variant of the
    /// schema: the variant names exactly the sample's kind, every field the sample has is one of
    /// the variant's properties, and every property the variant requires is in the sample. Every
    /// sample is a valid command, and a number or string in it is within its property's bounds.
    #[test]
    fn every_kind_fits_its_variant() {
        let schema = command_schema();
        let variants = schema["oneOf"].as_array().unwrap();
        let samples = samples();
        let kinds: Vec<&str> = samples.iter().map(DeviceCommand::kind).collect();
        assert_eq!(kinds, DeviceCommand::KINDS, "one sample per kind");
        for sample in &samples {
            sample.validate().unwrap();
            let wire = serde_json::to_value(sample).unwrap();
            let fields = wire.as_object().unwrap();
            let fitting: Vec<&Value> = variants
                .iter()
                .filter(|v| v["properties"]["kind"]["const"] == wire["kind"])
                .collect();
            assert_eq!(fitting.len(), 1, "{wire}");
            let variant = fitting[0];
            let properties = variant["properties"].as_object().unwrap();
            for (field, value) in fields {
                let property = properties
                    .get(field)
                    .unwrap_or_else(|| panic!("{field} of {wire} is not in its variant"));
                if let Some(max) = property["maximum"].as_u64() {
                    assert!(
                        value.as_u64().unwrap() <= max,
                        "{field} of {}",
                        wire["kind"]
                    );
                }
                if let Some(max) = property["maxLength"].as_u64() {
                    let chars = value.as_str().unwrap().chars().count() as u64;
                    assert!(chars <= max, "{field} of {}", wire["kind"]);
                }
            }
            for required in variant["required"].as_array().unwrap() {
                let required = required.as_str().unwrap();
                assert!(fields.contains_key(required), "{required} of {wire}");
            }
            if let Some(one_of) = variant["oneOf"].as_array() {
                let met = one_of
                    .iter()
                    .filter(|alt| {
                        alt["required"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .all(|r| fields.contains_key(r.as_str().unwrap()))
                    })
                    .count();
                assert_eq!(met, 1, "exactly one target in {wire}");
            }
            assert_eq!(variant["additionalProperties"], false, "{}", wire["kind"]);
        }
    }

    /// The bounds are `jt_devices`' own.
    #[test]
    fn the_bounds_are_the_vocabularys() {
        let schema = command_schema();
        let variant = |kind: &str| {
            schema["oneOf"]
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["properties"]["kind"]["const"] == kind)
                .unwrap()
                .clone()
        };
        let shell = variant("shell");
        assert_eq!(shell["properties"]["argv"]["maxItems"], MAX_SHELL_ARGS);
        assert_eq!(
            shell["properties"]["argv"]["items"]["maxLength"],
            MAX_ARG_CHARS
        );
        assert_eq!(
            variant("text")["properties"]["value"]["maxLength"],
            MAX_TEXT_CHARS
        );
        assert_eq!(
            variant("swipe")["properties"]["ms"]["maximum"],
            MAX_SWIPE_MS
        );
        assert_eq!(
            variant("long_press")["properties"]["ms"]["maximum"],
            MAX_LONG_PRESS_MS
        );
        assert_eq!(
            variant("open_url")["properties"]["url"]["maxLength"],
            MAX_URL_CHARS
        );
        assert_eq!(
            variant("launch_app")["properties"]["app_id"]["maxLength"],
            MAX_APP_ID_CHARS
        );
        for (kind, field) in [("push_file", "dest"), ("pull_file", "path")] {
            assert_eq!(
                variant(kind)["properties"][field]["maxLength"],
                MAX_PATH_CHARS
            );
        }
        for (kind, field) in [("tap", "x"), ("long_press", "y"), ("swipe", "x2")] {
            assert_eq!(variant(kind)["properties"][field]["maximum"], MAX_SCREEN_PX);
        }
    }

    /// The command schema has one object per command kind, each tagged as `DeviceCommand` reads
    /// it, and every example it allows is a command.
    #[test]
    fn the_command_schema_names_every_kind() {
        let schema = command_schema();
        let kinds: Vec<&str> = schema["oneOf"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["properties"]["kind"]["const"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, DeviceCommand::KINDS);
        for v in schema["oneOf"].as_array().unwrap() {
            assert_eq!(v["additionalProperties"], false, "{v}");
            assert_eq!(v["required"][0], "kind", "{v}");
        }
        for example in [
            json!({ "kind": "tap", "x": 1, "y": 2 }),
            json!({ "kind": "tap_on", "desc": "Gönder", "exact": true }),
            json!({ "kind": "key", "key": "app_switch" }),
            json!({ "kind": "shell", "argv": ["getprop", "ro.product.model"] }),
            json!({ "kind": "screenshot" }),
            json!({ "kind": "observe", "screenshot": true }),
        ] {
            let _: DeviceCommand = serde_json::from_value(example).unwrap();
        }
    }
}
