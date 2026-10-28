//! The server <-> bridge wire protocol: JSON shapes, refusals, limits, validation and the
//! constructors that build valid bodies.
use jt_device_protocol::{
    CommandError, CommandResult, CommandsOut, CommandsQuery, DeviceCommand, DeviceKey, Element,
    ElementTarget, FailReason, FileOut, HEARTBEAT_S, LeasedCommand, MAX_COMMANDS, MAX_DETAIL_CHARS,
    MAX_ELEMENTS, MAX_FEATURE_CHARS, MAX_FEATURES, MAX_ID_CHARS, MAX_OUTPUT_BYTES, MAX_PHONES,
    MAX_RESULTS, MAX_RESULTS_BODY_BYTES, MAX_SCREEN_PX, MAX_TEXT_CHARS, MAX_VERSION_CHARS,
    MAX_WAIT_S, Observation, Outcome, PROTOCOL_VERSION, PhoneReport, Platform, ProtocolError,
    RefusedPhone, RegisterIn, RegisterOut, RegisteredPhone, ResultIn, ResultsIn, ResultsOut,
    Screen, TEXT_UNICODE, supports,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use time::macros::datetime;
use uuid::Uuid;

fn id(n: u128) -> Uuid {
    Uuid::from_u128(0x0190_0000_0000_7000_8000_0000_0000_0000 + n)
}

fn screen() -> Screen {
    Screen {
        w: 1080,
        h: 2400,
        rotation: 0,
    }
}

fn phone(serial: &str) -> PhoneReport {
    PhoneReport {
        platform: Platform::Android,
        serial: serial.into(),
        model: Some("Pixel 7".into()),
        os_version: Some("14".into()),
        screen: Some(screen()),
        features: vec!["observe".into(), "tap".into(), "text.unicode".into()],
    }
}

fn register() -> RegisterIn {
    RegisterIn {
        bridge_id: "pc-atolye".into(),
        version: "0.1.0".into(),
        protocol: PROTOCOL_VERSION,
        phones: vec![phone("R58N1234ABC")],
    }
}

/// The wire form is exactly `wire`, and reading `wire` gives the value back.
fn round_trips<T>(value: &T, wire: Value)
where
    T: Serialize + DeserializeOwned + PartialEq + std::fmt::Debug,
{
    assert_eq!(&serde_json::to_value(value).unwrap(), &wire, "{value:?}");
    let back: T = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(&back, value, "{wire}");
}

/// `valid` is read, and the same object with one more field is refused.
fn refuses_unknown_field<T>(valid: Value)
where
    T: DeserializeOwned + std::fmt::Debug,
{
    serde_json::from_value::<T>(valid.clone())
        .unwrap_or_else(|e| panic!("{valid} should be read: {e}"));
    let mut extra = valid.clone();
    extra
        .as_object_mut()
        .expect("an object")
        .insert("x".into(), json!(1));
    assert!(
        serde_json::from_value::<T>(extra.clone()).is_err(),
        "{extra} should be refused"
    );
}

/// The field a refused body names.
fn invalid(error: ProtocolError) -> &'static str {
    error.field()
}

fn observation() -> Observation {
    Observation {
        screen: screen(),
        foreground_app: Some("com.whatsapp".into()),
        elements: vec![Element {
            text: Some("Gönder".into()),
            id: None,
            desc: None,
            class: Some("android.widget.Button".into()),
            bounds: [10, 20, 110, 80],
            tap_point: [60, 50],
            clickable: true,
            editable: false,
            focused: false,
        }],
        truncated: false,
        screenshot_file_id: None,
    }
}

fn leased() -> LeasedCommand {
    LeasedCommand {
        id: id(1),
        capability_id: id(2),
        serial: "R58N1234ABC".into(),
        command: DeviceCommand::Tap { x: 540, y: 1200 },
        expires_at: datetime!(2026-10-28 12:30:45 UTC),
        download_url: None,
    }
}

fn long(n: usize) -> String {
    "a".repeat(n)
}

#[test]
fn register_round_trip() {
    round_trips(
        &register(),
        json!({
            "bridge_id": "pc-atolye",
            "version": "0.1.0",
            "protocol": 1,
            "phones": [{
                "platform": "android",
                "serial": "R58N1234ABC",
                "model": "Pixel 7",
                "os_version": "14",
                "screen": {"w": 1080, "h": 2400, "rotation": 0},
                "features": ["observe", "tap", "text.unicode"]
            }]
        }),
    );
    // What a bridge may not know about a phone can be left out or null.
    let bare: PhoneReport = serde_json::from_value(json!({
        "platform": "ios", "serial": "00008110-0001", "features": []
    }))
    .unwrap();
    assert_eq!(bare.platform, Platform::Ios);
    assert_eq!(
        (bare.model, bare.os_version, bare.screen),
        (None, None, None)
    );
    let nulls: PhoneReport = serde_json::from_value(json!({
        "platform": "android", "serial": "s", "model": null, "os_version": null,
        "screen": null, "features": []
    }))
    .unwrap();
    assert_eq!(nulls.model, None);
}

#[test]
fn register_out_carries_server_protocol() {
    let registered = RegisteredPhone {
        serial: "R58N1234ABC".into(),
        capability_id: id(2),
    };
    // `new` fills what the server owns: the heartbeat, the longest wait and its own protocol.
    let out = RegisterOut::new(vec![registered.clone()], vec![]);
    assert_eq!(out.heartbeat_s, HEARTBEAT_S);
    assert_eq!(out.max_wait_s, MAX_WAIT_S);
    assert_eq!(out.protocol, PROTOCOL_VERSION);
    round_trips(
        &out,
        json!({
            "phones": [{"serial": "R58N1234ABC", "capability_id": "01900000-0000-7000-8000-000000000002"}],
            "refused": [],
            "heartbeat_s": 15,
            "max_wait_s": 25,
            "protocol": 1
        }),
    );
    // The server answers its own protocol, which may be newer than the bridge's.
    let newer: RegisterOut = serde_json::from_value(json!({
        "phones": [], "refused": [], "heartbeat_s": 15, "max_wait_s": 25, "protocol": 7
    }))
    .unwrap();
    assert_eq!(newer.protocol, 7);
}

#[test]
fn register_out_says_why_a_phone_was_not_registered() {
    let refused = RefusedPhone {
        platform: Platform::Ios,
        serial: "00008110-0001".into(),
        reason: "model: must not contain a NUL character".into(),
    };
    let out = RegisterOut::new(
        vec![RegisteredPhone {
            serial: "R58N1234ABC".into(),
            capability_id: id(2),
        }],
        vec![refused.clone()],
    );
    round_trips(
        &out,
        json!({
            "phones": [{"serial": "R58N1234ABC", "capability_id": "01900000-0000-7000-8000-000000000002"}],
            "refused": [{
                "platform": "ios",
                "serial": "00008110-0001",
                "reason": "model: must not contain a NUL character"
            }],
            "heartbeat_s": 15,
            "max_wait_s": 25,
            "protocol": 1
        }),
    );
    // An answer without the list (a server that has none to give) reads as no refusals.
    let without: RegisterOut = serde_json::from_value(json!({
        "phones": [], "heartbeat_s": 15, "max_wait_s": 25, "protocol": 1
    }))
    .unwrap();
    assert_eq!(without.refused, vec![]);
}

#[test]
fn leased_command_round_trip_with_rfc3339() {
    let mut command = leased();
    let wire = serde_json::to_value(&command).unwrap();
    // The exact string form, and an absent download address is left out, not null.
    assert_eq!(wire["expires_at"], "2026-10-28T12:30:45Z");
    assert!(wire.as_object().unwrap().get("download_url").is_none());
    round_trips(
        &command,
        json!({
            "id": "01900000-0000-7000-8000-000000000001",
            "capability_id": "01900000-0000-7000-8000-000000000002",
            "serial": "R58N1234ABC",
            "command": {"kind": "tap", "x": 540, "y": 1200},
            "expires_at": "2026-10-28T12:30:45Z"
        }),
    );

    command.command = DeviceCommand::PushFile {
        file_id: id(9),
        dest: "/sdcard/Download/a.jpg".into(),
    };
    command.download_url = Some("https://jeetagrowth.com/files/9?sig=abc".into());
    let wire = serde_json::to_value(&command).unwrap();
    assert_eq!(
        wire["download_url"],
        "https://jeetagrowth.com/files/9?sig=abc"
    );
    assert_eq!(wire["command"]["kind"], "push_file");
    let back: LeasedCommand = serde_json::from_value(wire).unwrap();
    assert_eq!(back, command);

    // Any offset is read, as the same instant.
    let shifted: LeasedCommand = serde_json::from_value(json!({
        "id": id(1), "capability_id": id(2), "serial": "s",
        "command": {"kind": "screenshot"},
        "expires_at": "2026-10-28T15:30:45+03:00"
    }))
    .unwrap();
    assert_eq!(shifted.expires_at, datetime!(2026-10-28 12:30:45 UTC));
    // A timestamp that is not RFC 3339 is refused.
    assert!(
        serde_json::from_value::<LeasedCommand>(json!({
            "id": id(1), "capability_id": id(2), "serial": "s",
            "command": {"kind": "screenshot"},
            "expires_at": 1793190645
        }))
        .is_err()
    );
    // The command is the jt_devices one, unknown kinds refused.
    assert!(
        serde_json::from_value::<LeasedCommand>(json!({
            "id": id(1), "capability_id": id(2), "serial": "s",
            "command": {"kind": "teleport"},
            "expires_at": "2026-10-28T12:30:45Z"
        }))
        .is_err()
    );
}

#[test]
fn leased_command_debug_masks_the_download_url() {
    let mut command = leased();
    command.command = DeviceCommand::PushFile {
        file_id: id(9),
        dest: "/sdcard/Download/a.jpg".into(),
    };
    command.download_url = Some("https://jeetagrowth.com/files/9?sig=SECRETSIG".into());
    let shown = format!("{command:?}");
    assert!(!shown.contains("SECRETSIG"), "{shown}");
    assert!(!shown.contains("jeetagrowth.com"), "{shown}");
    assert!(shown.contains("download_url"), "{shown}");
    assert!(shown.contains("***"), "{shown}");
    // The rest is shown, and an absent address is shown as absent.
    assert!(shown.contains("R58N1234ABC"), "{shown}");
    command.download_url = None;
    let shown = format!("{command:?}");
    assert!(shown.contains("download_url: None"), "{shown}");
}

#[test]
fn commands_envelope_round_trip() {
    round_trips(&CommandsOut { commands: vec![] }, json!({"commands": []}));
    round_trips(
        &CommandsQuery {
            wait_s: 25,
            limit: 20,
        },
        json!({"wait_s": 25, "limit": 20}),
    );
    round_trips(&FileOut { file_id: id(5) }, json!({"file_id": id(5)}));
    round_trips(
        &ResultsOut {
            applied: 2,
            duplicates: 1,
            unknown: 0,
        },
        json!({"applied": 2, "duplicates": 1, "unknown": 0}),
    );
}

fn poll_item(n: u128, command: Value) -> Value {
    json!({
        "id": id(n), "capability_id": id(100), "serial": "s",
        "command": command, "expires_at": "2026-10-28T12:30:45Z"
    })
}

#[test]
fn decode_lenient_reads_a_clean_poll_like_serde() {
    let mut with_url = leased();
    with_url.id = id(2);
    with_url.command = DeviceCommand::PushFile {
        file_id: id(9),
        dest: "/sdcard/a.jpg".into(),
    };
    with_url.download_url = Some("https://example.com/f?sig=1".into());
    let poll = CommandsOut {
        commands: vec![leased(), with_url],
    };
    let (commands, unreadable) = CommandsOut::decode_lenient(serde_json::to_value(&poll).unwrap());
    assert_eq!(commands, poll.commands);
    assert_eq!(unreadable, vec![]);
}

#[test]
fn decode_lenient_fails_an_unreadable_command_by_id() {
    let tap = json!({"kind": "tap", "x": 1, "y": 2});
    let mut bad_time = poll_item(5, tap.clone());
    bad_time["expires_at"] = json!("tomorrow");
    let mut no_id = poll_item(6, tap.clone());
    no_id.as_object_mut().unwrap().remove("id");
    let mut bad_id = poll_item(7, tap.clone());
    bad_id["id"] = json!("not-a-uuid");
    let (commands, unreadable) = CommandsOut::decode_lenient(json!({"commands": [
        poll_item(1, tap.clone()),
        // A kind this build does not know.
        poll_item(2, json!({"kind": "drag", "x": 1})),
        poll_item(3, json!({"kind": "key", "key": "back"})),
        // A value of a known field this build does not know.
        poll_item(4, json!({"kind": "key", "key": "camera"})),
        bad_time,
        // No id to fail it by: dropped.
        no_id,
        bad_id,
        poll_item(8, tap),
    ]}));
    // The readable ones come back whole and in order; one bad command does not poison the poll.
    let ids: Vec<Uuid> = commands.iter().map(|c| c.id).collect();
    assert_eq!(ids, vec![id(1), id(3), id(8)]);
    assert_eq!(
        commands[1].command,
        DeviceCommand::Key {
            key: DeviceKey::Back
        }
    );
    // The unreadable ones are named by id, in order, each with the reason.
    let failed: Vec<Uuid> = unreadable.iter().map(|(id, _)| *id).collect();
    assert_eq!(failed, vec![id(2), id(4), id(5)]);
    assert!(
        unreadable.iter().all(|(_, why)| !why.is_empty()),
        "{unreadable:?}"
    );
    assert!(unreadable[0].1.contains("drag"), "{unreadable:?}");
}

#[test]
fn decode_lenient_reads_a_body_that_is_not_a_poll_as_no_commands() {
    for body in [
        json!(null),
        json!([]),
        json!({}),
        json!({"commands": 5}),
        json!({"commands": {}}),
    ] {
        assert_eq!(
            CommandsOut::decode_lenient(body.clone()),
            (vec![], vec![]),
            "{body}"
        );
    }
}

#[test]
fn outcome_done_variants_round_trip() {
    let observed = Outcome::Done {
        result: CommandResult::Observation(observation()),
    };
    round_trips(
        &observed,
        json!({
            "status": "done",
            "result": {
                "kind": "observation",
                "screen": {"w": 1080, "h": 2400, "rotation": 0},
                "foreground_app": "com.whatsapp",
                "elements": [{
                    "text": "Gönder", "id": null, "desc": null,
                    "class": "android.widget.Button",
                    "bounds": [10, 20, 110, 80], "tap_point": [60, 50],
                    "clickable": true, "editable": false, "focused": false
                }],
                "truncated": false,
                "screenshot_file_id": null
            }
        }),
    );

    // The exact form of the result with no payload.
    let done = Outcome::Done {
        result: CommandResult::Done {},
    };
    assert_eq!(
        serde_json::to_string(&done).unwrap(),
        r#"{"status":"done","result":{"kind":"done"}}"#
    );
    round_trips(&done, json!({"status": "done", "result": {"kind": "done"}}));

    round_trips(
        &Outcome::Done {
            result: CommandResult::Shell {
                exit_code: -1,
                stdout: "34\n".into(),
                stderr: String::new(),
                truncated: true,
            },
        },
        json!({
            "status": "done",
            "result": {
                "kind": "shell", "exit_code": -1, "stdout": "34\n", "stderr": "",
                "truncated": true
            }
        }),
    );
    // A shell result that does not say it was cut was not.
    let uncut: CommandResult = serde_json::from_value(
        json!({"kind": "shell", "exit_code": 0, "stdout": "", "stderr": ""}),
    )
    .unwrap();
    assert_eq!(
        uncut,
        CommandResult::Shell {
            exit_code: 0,
            stdout: String::new(),
            stderr: String::new(),
            truncated: false
        }
    );

    round_trips(
        &Outcome::Done {
            result: CommandResult::File { file_id: id(7) },
        },
        json!({
            "status": "done",
            "result": {"kind": "file", "file_id": "01900000-0000-7000-8000-000000000007"}
        }),
    );
}

#[test]
fn outcome_failed_carries_reason_and_detail() {
    let failed = Outcome::Failed {
        reason: FailReason::AdbError,
        detail: "device unauthorized".into(),
    };
    round_trips(
        &failed,
        json!({"status": "failed", "reason": "adb_error", "detail": "device unauthorized"}),
    );
    // A result carries its command and how long the bridge worked on it.
    let result = ResultIn {
        command_id: id(1),
        outcome: failed,
        duration_ms: 412,
    };
    round_trips(
        &result,
        json!({
            "command_id": "01900000-0000-7000-8000-000000000001",
            "outcome": {"status": "failed", "reason": "adb_error", "detail": "device unauthorized"},
            "duration_ms": 412
        }),
    );
    // Every reason this version knows is carried by its name.
    for reason in FailReason::ALL {
        let wire = json!({"status": "failed", "reason": reason.key(), "detail": ""});
        let outcome: Outcome = serde_json::from_value(wire).unwrap();
        assert_eq!(
            outcome,
            Outcome::Failed {
                reason: *reason,
                detail: String::new()
            }
        );
    }
}

#[test]
fn unknown_fail_reason_reads_as_unknown() {
    let outcome: Outcome = serde_json::from_value(
        json!({"status": "failed", "reason": "a_future_reason", "detail": "x"}),
    )
    .unwrap();
    assert_eq!(
        outcome,
        Outcome::Failed {
            reason: FailReason::Unknown,
            detail: "x".into()
        }
    );
    // A whole batch survives one reason this version does not know.
    let batch: ResultsIn = serde_json::from_value(json!({"results": [
        {"command_id": id(1), "duration_ms": 5,
         "outcome": {"status": "failed", "reason": "a_future_reason", "detail": "x"}},
        {"command_id": id(2), "duration_ms": 5,
         "outcome": {"status": "done", "result": {"kind": "done"}}}
    ]}))
    .unwrap();
    assert_eq!(batch.results.len(), 2);
    // Status and result kind are not forgiven the same way.
    assert!(serde_json::from_value::<Outcome>(json!({"status": "paused"})).is_err());
    assert!(
        serde_json::from_value::<Outcome>(
            json!({"status": "done", "result": {"kind": "a_future_kind"}})
        )
        .is_err()
    );
}

#[test]
fn results_batch_limit_constant_is_100() {
    assert_eq!(MAX_RESULTS, 100);
}

#[test]
fn protocol_version_is_1() {
    assert_eq!(PROTOCOL_VERSION, 1);
}

#[test]
fn limits_are_the_documented_ones() {
    assert_eq!(HEARTBEAT_S, 15);
    assert_eq!(MAX_WAIT_S, 25);
    assert_eq!(MAX_COMMANDS, 20);
    assert_eq!(MAX_DETAIL_CHARS, 300);
    assert_eq!(MAX_OUTPUT_BYTES, 65_536);
    assert_eq!(MAX_ID_CHARS, 128);
    assert_eq!(MAX_VERSION_CHARS, 64);
    assert_eq!(MAX_PHONES, 16);
    assert_eq!(MAX_FEATURES, 64);
    assert_eq!(MAX_FEATURE_CHARS, 64);
    assert_eq!(MAX_SCREEN_PX, 20_000);
    assert_eq!(MAX_RESULTS_BODY_BYTES, 2 * 1024 * 1024);
}

/// Everything a bridge needs of the shared vocabulary comes from this crate.
#[test]
fn the_bridge_needs_one_import_path_for_the_shared_vocabulary() {
    let tap_on = DeviceCommand::TapOn {
        target: ElementTarget::Text("Gönder".into()),
        exact: false,
    };
    assert_eq!(tap_on.validate(), Ok(()));
    let key = DeviceCommand::Key {
        key: DeviceKey::AppSwitch,
    };
    assert_eq!(key.kind(), "key");
    let refused: CommandError = DeviceCommand::Text {
        value: String::new(),
    }
    .validate()
    .unwrap_err();
    assert!(refused.to_string().starts_with("value:"), "{refused}");

    // What the bridge lists decides what it is handed.
    let listed = vec!["tap_on".to_string(), "text".to_string()];
    assert!(supports(&listed, &tap_on));
    assert!(!supports(&listed, &key));
    let unicode = DeviceCommand::Text {
        value: "Ayşe".into(),
    };
    assert!(!supports(&listed, &unicode));
    let listed = vec!["text".to_string(), TEXT_UNICODE.to_string()];
    assert!(supports(&listed, &unicode));

    // A screen read and capped with the shared types.
    let mut seen = observation();
    seen.elements = vec![seen.elements[0].clone(); MAX_ELEMENTS + 1];
    seen.cap_elements();
    assert_eq!(seen.elements.len(), MAX_ELEMENTS);
    assert!(seen.truncated);
    assert_eq!(MAX_TEXT_CHARS, 4000);
    assert_eq!(
        FailReason::from_key("adb_error"),
        Some(FailReason::AdbError)
    );
}

#[test]
fn unknown_fields_refused() {
    // `RegisterIn` and `PhoneReport` are the exceptions: see `register_ignores_unknown_fields`.
    refuses_unknown_field::<RegisterOut>(json!({
        "phones": [], "refused": [], "heartbeat_s": 15, "max_wait_s": 25, "protocol": 1
    }));
    refuses_unknown_field::<RegisteredPhone>(json!({"serial": "s", "capability_id": id(2)}));
    refuses_unknown_field::<RefusedPhone>(json!({
        "platform": "android", "serial": "s", "reason": "no"
    }));
    refuses_unknown_field::<CommandsQuery>(json!({"wait_s": 25, "limit": 20}));
    refuses_unknown_field::<LeasedCommand>(json!({
        "id": id(1), "capability_id": id(2), "serial": "s",
        "command": {"kind": "screenshot"}, "expires_at": "2026-10-28T12:30:45Z"
    }));
    refuses_unknown_field::<CommandsOut>(json!({"commands": []}));
    refuses_unknown_field::<ResultIn>(json!({
        "command_id": id(1), "duration_ms": 1,
        "outcome": {"status": "done", "result": {"kind": "done"}}
    }));
    refuses_unknown_field::<ResultsIn>(json!({"results": []}));
    refuses_unknown_field::<ResultsOut>(json!({"applied": 0, "duplicates": 0, "unknown": 0}));
    refuses_unknown_field::<FileOut>(json!({"file_id": id(5)}));

    // The outcome and each of its results are tagged objects that refuse them too.
    refuses_unknown_field::<Outcome>(json!({
        "status": "failed", "reason": "timeout", "detail": ""
    }));
    refuses_unknown_field::<Outcome>(json!({
        "status": "done", "result": {"kind": "done"}
    }));
    refuses_unknown_field::<CommandResult>(json!({"kind": "done"}));
    refuses_unknown_field::<CommandResult>(json!({
        "kind": "shell", "exit_code": 0, "stdout": "", "stderr": "", "truncated": false
    }));
    refuses_unknown_field::<CommandResult>(json!({"kind": "file", "file_id": id(5)}));
    // `CommandResult` as it sits in an outcome.
    assert!(
        serde_json::from_value::<Outcome>(json!({
            "status": "done", "result": {"kind": "done", "x": 1}
        }))
        .is_err()
    );
    // A required field cannot be left out either.
    assert!(serde_json::from_value::<CommandsQuery>(json!({"wait_s": 25})).is_err());
}

/// The first register goes out before the bridge knows the server's protocol, so a newer
/// bridge's extra fields must not make an older server refuse it. Everything after it is strict.
#[test]
fn register_ignores_unknown_fields() {
    let newer: RegisterIn = serde_json::from_value(json!({
        "bridge_id": "pc-atolye", "version": "0.9.0", "protocol": 2,
        "battery_saver": true,
        "phones": [{
            "platform": "android", "serial": "R58N1234ABC", "model": "Pixel 7",
            "os_version": "14", "features": ["observe"],
            "screen": {"w": 1080, "h": 2400, "rotation": 0, "density": 420},
            "transport": "usb"
        }]
    }))
    .unwrap();
    assert_eq!(newer.protocol, 2);
    assert_eq!(newer.phones.len(), 1);
    assert_eq!(newer.phones[0].serial, "R58N1234ABC");
    assert_eq!(newer.phones[0].screen, Some(screen()));
    // What is ignored is not written back: this version sends only what it defines.
    let wire = serde_json::to_value(&newer).unwrap();
    assert!(wire.get("battery_saver").is_none());
    assert!(wire["phones"][0].get("transport").is_none());
    // Required fields are still required.
    assert!(
        serde_json::from_value::<RegisterIn>(json!({"bridge_id": "b", "version": "1"})).is_err()
    );
    // A platform this version does not know cannot be read: it is a stored key, not a label, so
    // a new platform needs a protocol bump.
    assert!(
        serde_json::from_value::<RegisterIn>(json!({
            "bridge_id": "b", "version": "1", "protocol": 2,
            "phones": [{"platform": "harmony", "serial": "h", "features": []}]
        }))
        .is_err()
    );
}

/// `Observation`, `Screen` and `Element` are shared with the tolerant handshake, so they accept
/// unknown fields too: tolerance when one is read back is intended. Nothing ignored is written.
#[test]
fn observation_ignores_unknown_fields() {
    let outcome: Outcome = serde_json::from_value(json!({
        "status": "done",
        "result": {
            "kind": "observation",
            "screen": {"w": 1080, "h": 2400, "rotation": 0, "density": 420},
            "foreground_app": "com.whatsapp",
            "elements": [{
                "text": "Gönder", "id": null, "desc": null,
                "class": "android.widget.Button",
                "bounds": [10, 20, 110, 80], "tap_point": [60, 50],
                "clickable": true, "editable": false, "focused": false, "checked": true
            }],
            "truncated": false,
            "screenshot_file_id": null,
            "extra_top": 1
        }
    }))
    .unwrap();
    assert_eq!(
        outcome,
        Outcome::Done {
            result: CommandResult::Observation(observation())
        }
    );
    let wire = serde_json::to_string(&outcome).unwrap();
    for ignored in ["density", "checked", "extra_top"] {
        assert!(!wire.contains(ignored), "{ignored} was written back");
    }
}

#[test]
fn observation_result_is_tagged_next_to_the_observation_fields() {
    let result = CommandResult::Observation(observation());
    let wire = serde_json::to_value(&result).unwrap();
    assert_eq!(wire["kind"], "observation");
    assert_eq!(wire["foreground_app"], "com.whatsapp");
    assert_eq!(wire["screen"]["w"], 1080);
    let back: CommandResult = serde_json::from_value(wire).unwrap();
    assert_eq!(back, result);
}

/// The register body itself: what makes the whole request unusable. A phone's own faults are
/// `PhoneReport::validate`'s, so they do not refuse the heartbeat.
#[test]
fn register_validation() {
    assert_eq!(register().validate(), Ok(()));

    // A bridge with no phone attached still registers: it is alive, and says so.
    let mut empty = register();
    empty.phones.clear();
    assert_eq!(empty.validate(), Ok(()));

    let mut r = register();
    r.protocol = 0;
    assert_eq!(invalid(r.validate().unwrap_err()), "protocol");
    let mut r = register();
    r.protocol = 9; // newer than this build: the server decides what to send, not this check
    assert_eq!(r.validate(), Ok(()));

    for bad in ["", "   ", "a\0b"] {
        let mut r = register();
        r.bridge_id = bad.into();
        assert_eq!(invalid(r.validate().unwrap_err()), "bridge_id", "{bad:?}");
    }
    let mut r = register();
    r.bridge_id = long(MAX_ID_CHARS + 1);
    assert_eq!(invalid(r.validate().unwrap_err()), "bridge_id");
    r.bridge_id = long(MAX_ID_CHARS);
    assert_eq!(r.validate(), Ok(()));
    // Characters, not bytes.
    r.bridge_id = "ş".repeat(MAX_ID_CHARS);
    assert_eq!(r.validate(), Ok(()));

    for bad in ["", " \t", "1\0"] {
        let mut r = register();
        r.version = bad.into();
        assert_eq!(invalid(r.validate().unwrap_err()), "version", "{bad:?}");
    }
    let mut r = register();
    r.version = long(MAX_VERSION_CHARS + 1);
    assert_eq!(invalid(r.validate().unwrap_err()), "version");
    r.version = long(MAX_VERSION_CHARS);
    assert_eq!(r.validate(), Ok(()));

    // Phones: the cap.
    let mut r = register();
    r.phones = (0..MAX_PHONES).map(|i| phone(&format!("s{i}"))).collect();
    assert_eq!(r.validate(), Ok(()));
    r.phones.push(phone("one-more"));
    assert_eq!(invalid(r.validate().unwrap_err()), "phones");

    // A serial once: the bridge routes commands by serial alone, whatever the platform.
    let mut r = register();
    r.phones = vec![phone("same"), phone("other"), phone("same")];
    assert_eq!(invalid(r.validate().unwrap_err()), "phones");
    let mut ios = phone("same");
    ios.platform = Platform::Ios;
    r.phones = vec![phone("same"), ios];
    assert_eq!(invalid(r.validate().unwrap_err()), "phones");
}

#[test]
fn a_phones_own_faults_do_not_refuse_the_register_body() {
    let mut r = register();
    r.phones = vec![phone("good"), phone("bad")];
    r.phones[1].model = Some("Pixel\0".into());
    r.phones[1].features.push("  ".into());
    r.phones[1].screen = Some(Screen {
        w: 0,
        h: 0,
        rotation: 7,
    });
    assert_eq!(r.validate(), Ok(()), "the body is fine");
    assert_eq!(r.phones[0].validate(), Ok(()));
    assert!(r.phones[1].validate().is_err(), "the phone is not");
    // Even a phone without a usable serial: the phone is refused, not the heartbeat.
    r.phones[1].serial = "  ".into();
    assert_eq!(r.validate(), Ok(()));
    assert_eq!(invalid(r.phones[1].validate().unwrap_err()), "serial");
}

#[test]
fn phone_validation() {
    assert_eq!(phone("R58N1234ABC").validate(), Ok(()));

    for bad in ["", "  ", "R5\0"] {
        let mut p = phone("x");
        p.serial = bad.into();
        assert_eq!(invalid(p.validate().unwrap_err()), "serial", "{bad:?}");
    }
    let mut p = phone("x");
    p.serial = long(MAX_ID_CHARS + 1);
    assert_eq!(invalid(p.validate().unwrap_err()), "serial");
    p.serial = long(MAX_ID_CHARS);
    assert_eq!(p.validate(), Ok(()));

    // Model and OS version may be blank (a phone that says nothing), but no NUL and at most 128
    // characters.
    type Set = fn(&mut PhoneReport, String);
    let setters: [(&str, Set); 2] = [
        ("model", |p, v| p.model = Some(v)),
        ("os_version", |p, v| p.os_version = Some(v)),
    ];
    for (field, set) in setters {
        let mut p = phone("x");
        set(&mut p, long(MAX_ID_CHARS));
        assert_eq!(p.validate(), Ok(()), "{field}");
        set(&mut p, "ş".repeat(MAX_ID_CHARS));
        assert_eq!(p.validate(), Ok(()), "{field}: characters, not bytes");
        set(&mut p, String::new());
        assert_eq!(p.validate(), Ok(()), "{field}: blank is allowed");
        set(&mut p, long(MAX_ID_CHARS + 1));
        assert_eq!(invalid(p.validate().unwrap_err()), field);
        set(&mut p, "Pixel\0".into());
        assert_eq!(invalid(p.validate().unwrap_err()), field);
    }
    let mut p = phone("x");
    p.model = None;
    p.os_version = None;
    p.screen = None;
    assert_eq!(
        p.validate(),
        Ok(()),
        "what the bridge cannot tell may be left out"
    );

    // Screen: both sides 1 ..= 20 000 pixels, rotation a quarter turn.
    let with_screen = |w, h, rotation| {
        let mut p = phone("x");
        p.screen = Some(Screen { w, h, rotation });
        p.validate()
    };
    assert_eq!(with_screen(1, 1, 0), Ok(()));
    assert_eq!(with_screen(MAX_SCREEN_PX, MAX_SCREEN_PX, 270), Ok(()));
    for rotation in [0, 90, 180, 270] {
        assert_eq!(with_screen(1080, 2400, rotation), Ok(()));
    }
    for (w, h) in [
        (0, 2400),
        (1080, 0),
        (MAX_SCREEN_PX + 1, 2400),
        (1080, MAX_SCREEN_PX + 1),
        (u32::MAX, u32::MAX),
    ] {
        assert_eq!(
            invalid(with_screen(w, h, 0).unwrap_err()),
            "screen",
            "{w}x{h}"
        );
    }
    for rotation in [1, 45, 91, 360, u16::MAX] {
        assert_eq!(
            invalid(with_screen(1080, 2400, rotation).unwrap_err()),
            "screen",
            "rotation {rotation}"
        );
    }

    // Features: each named, no NUL, at most 64 characters, at most 64 of them.
    for bad in ["", "  ", "text\0"] {
        let mut p = phone("x");
        p.features.push(bad.into());
        assert_eq!(invalid(p.validate().unwrap_err()), "features", "{bad:?}");
    }
    let mut p = phone("x");
    p.features = vec![long(MAX_FEATURE_CHARS + 1)];
    assert_eq!(invalid(p.validate().unwrap_err()), "features");
    p.features = vec![long(MAX_FEATURE_CHARS)];
    assert_eq!(p.validate(), Ok(()));
    p.features = (0..MAX_FEATURES).map(|i| format!("f{i}")).collect();
    assert_eq!(p.validate(), Ok(()));
    p.features.push("one-more".into());
    assert_eq!(invalid(p.validate().unwrap_err()), "features");
}

#[test]
fn validation_names_what_is_wrong() {
    let mut r = register();
    r.protocol = 0;
    let error = r.validate().unwrap_err();
    assert_eq!(
        error,
        ProtocolError::Invalid {
            field: "protocol",
            reason: "must be at least 1"
        }
    );
    assert_eq!(error.to_string(), "protocol: must be at least 1");
    assert_eq!(error.field(), "protocol");
}

fn done_result(n: u128) -> ResultIn {
    ResultIn {
        command_id: id(n),
        outcome: Outcome::Done {
            result: CommandResult::Done {},
        },
        duration_ms: 3,
    }
}

fn failed(n: u128, detail: String) -> ResultIn {
    ResultIn {
        command_id: id(n),
        outcome: Outcome::Failed {
            reason: FailReason::BridgeError,
            detail,
        },
        duration_ms: 1,
    }
}

fn shell_in(stdout: String, stderr: String) -> ResultIn {
    ResultIn {
        command_id: id(1),
        outcome: Outcome::Done {
            result: CommandResult::Shell {
                exit_code: 0,
                stdout,
                stderr,
                truncated: false,
            },
        },
        duration_ms: 1,
    }
}

fn batch(results: Vec<ResultIn>) -> ResultsIn {
    ResultsIn { results }
}

#[test]
fn results_validation() {
    assert_eq!(batch(vec![done_result(1)]).validate(), Ok(()));

    // 1 ..= 100 results.
    assert_eq!(
        invalid(batch(vec![]).validate().unwrap_err()),
        "results",
        "an empty batch"
    );
    let n = MAX_RESULTS as u128;
    assert_eq!(batch((1..=n).map(done_result).collect()).validate(), Ok(()));
    assert_eq!(
        invalid(
            batch((1..=n + 1).map(done_result).collect())
                .validate()
                .unwrap_err()
        ),
        "results"
    );

    // A command once per batch.
    assert_eq!(
        invalid(
            batch(vec![done_result(1), done_result(2), done_result(1)])
                .validate()
                .unwrap_err()
        ),
        "command_id"
    );

    // A failure's detail: at most 300 characters (not bytes), no NUL.
    assert_eq!(
        batch(vec![failed(1, long(MAX_DETAIL_CHARS))]).validate(),
        Ok(())
    );
    assert_eq!(
        batch(vec![failed(1, "ş".repeat(MAX_DETAIL_CHARS))]).validate(),
        Ok(())
    );
    assert_eq!(
        invalid(
            batch(vec![failed(1, long(MAX_DETAIL_CHARS + 1))])
                .validate()
                .unwrap_err()
        ),
        "detail"
    );
    assert_eq!(
        invalid(
            batch(vec![failed(1, "a\0b".into())])
                .validate()
                .unwrap_err()
        ),
        "detail"
    );

    // Shell output: at most 64 KiB per stream, counted in bytes, no NUL.
    assert_eq!(
        batch(vec![shell_in(
            long(MAX_OUTPUT_BYTES),
            long(MAX_OUTPUT_BYTES)
        )])
        .validate(),
        Ok(())
    );
    assert_eq!(
        invalid(
            batch(vec![shell_in(long(MAX_OUTPUT_BYTES + 1), String::new())])
                .validate()
                .unwrap_err()
        ),
        "stdout"
    );
    assert_eq!(
        invalid(
            batch(vec![shell_in(String::new(), long(MAX_OUTPUT_BYTES + 1))])
                .validate()
                .unwrap_err()
        ),
        "stderr"
    );
    // 32 769 two-byte characters are 65 538 bytes: few characters, too many bytes.
    assert_eq!(
        invalid(
            batch(vec![shell_in(
                "ş".repeat(MAX_OUTPUT_BYTES / 2 + 1),
                String::new()
            )])
            .validate()
            .unwrap_err()
        ),
        "stdout"
    );
    assert_eq!(
        invalid(
            batch(vec![shell_in("init\0--second".into(), String::new())])
                .validate()
                .unwrap_err()
        ),
        "stdout"
    );
    assert_eq!(
        invalid(
            batch(vec![shell_in(String::new(), "\0".into())])
                .validate()
                .unwrap_err()
        ),
        "stderr"
    );

    // One bad result anywhere in the batch refuses the batch.
    assert_eq!(
        invalid(
            batch(vec![
                done_result(1),
                done_result(2),
                failed(3, long(MAX_DETAIL_CHARS + 1)),
            ])
            .validate()
            .unwrap_err()
        ),
        "detail"
    );
}

fn observed(change: impl FnOnce(&mut Observation)) -> ResultsIn {
    let mut seen = observation();
    change(&mut seen);
    batch(vec![ResultIn {
        command_id: id(1),
        outcome: Outcome::Done {
            result: CommandResult::Observation(seen),
        },
        duration_ms: 1,
    }])
}

#[test]
fn observation_results_are_bounded() {
    assert_eq!(observed(|_| {}).validate(), Ok(()));

    // At most MAX_ELEMENTS elements.
    let at_cap = observed(|o| o.elements = vec![o.elements[0].clone(); MAX_ELEMENTS]);
    assert_eq!(at_cap.validate(), Ok(()));
    let over = observed(|o| o.elements = vec![o.elements[0].clone(); MAX_ELEMENTS + 1]);
    assert_eq!(invalid(over.validate().unwrap_err()), "observation");

    // The screen is held to the register screen check.
    for (w, h, rotation) in [
        (0, 2400, 0),
        (1080, 0, 0),
        (MAX_SCREEN_PX + 1, 1, 0),
        (1, 1, 45),
    ] {
        let bad = observed(|o| o.screen = Screen { w, h, rotation });
        assert_eq!(
            invalid(bad.validate().unwrap_err()),
            "observation",
            "{w}x{h} rotated {rotation}"
        );
    }
    let ok = observed(|o| {
        o.screen = Screen {
            w: MAX_SCREEN_PX,
            h: 1,
            rotation: 270,
        }
    });
    assert_eq!(ok.validate(), Ok(()));

    // Every string: at most MAX_TEXT_CHARS characters, and no NUL.
    type Set = fn(&mut Observation, String);
    let setters: [(&str, Set); 5] = [
        ("foreground_app", |o, v| o.foreground_app = Some(v)),
        ("text", |o, v| o.elements[0].text = Some(v)),
        ("id", |o, v| o.elements[0].id = Some(v)),
        ("desc", |o, v| o.elements[0].desc = Some(v)),
        ("class", |o, v| o.elements[0].class = Some(v)),
    ];
    for (name, set) in setters {
        let with = |value: String| observed(|o| set(o, value));
        assert_eq!(with(long(MAX_TEXT_CHARS)).validate(), Ok(()), "{name}");
        assert_eq!(
            with("ş".repeat(MAX_TEXT_CHARS)).validate(),
            Ok(()),
            "{name}: characters, not bytes"
        );
        assert_eq!(with(String::new()).validate(), Ok(()), "{name}: empty");
        assert_eq!(
            invalid(with(long(MAX_TEXT_CHARS + 1)).validate().unwrap_err()),
            "observation",
            "{name}"
        );
        assert_eq!(
            invalid(with("a\0b".into()).validate().unwrap_err()),
            "observation",
            "{name}: NUL"
        );
    }
    // The last element is checked as well as the first.
    let last = observed(|o| {
        o.elements = vec![o.elements[0].clone(); 3];
        o.elements[2].text = Some("x\0".into());
    });
    assert_eq!(invalid(last.validate().unwrap_err()), "observation");
}

#[test]
fn failed_constructor_is_valid_by_construction() {
    assert_eq!(
        Outcome::failed(FailReason::AdbError, "device unauthorized"),
        Outcome::Failed {
            reason: FailReason::AdbError,
            detail: "device unauthorized".into()
        }
    );
    // A NUL character becomes U+FFFD.
    assert_eq!(
        Outcome::failed(FailReason::BridgeError, "a\0b"),
        Outcome::Failed {
            reason: FailReason::BridgeError,
            detail: "a\u{FFFD}b".into()
        }
    );
    // At most MAX_DETAIL_CHARS characters, cut on a character, never on a byte.
    let detail = |outcome: Outcome| match outcome {
        Outcome::Failed { detail, .. } => detail,
        other => panic!("not a failure: {other:?}"),
    };
    let exact = long(MAX_DETAIL_CHARS);
    assert_eq!(detail(Outcome::failed(FailReason::Timeout, &exact)), exact);
    let cut = detail(Outcome::failed(
        FailReason::Timeout,
        &long(MAX_DETAIL_CHARS + 200),
    ));
    assert_eq!(cut, long(MAX_DETAIL_CHARS));
    let cut = detail(Outcome::failed(FailReason::Timeout, &"ş".repeat(500)));
    assert_eq!(cut.chars().count(), MAX_DETAIL_CHARS);
    assert_eq!(cut, "ş".repeat(MAX_DETAIL_CHARS));
    // A NUL past the cap is cut with the rest; one inside it is replaced.
    let mixed = format!("{}\0{}\0", long(MAX_DETAIL_CHARS - 1), long(10));
    let cut = detail(Outcome::failed(FailReason::Timeout, &mixed));
    assert_eq!(cut, format!("{}\u{FFFD}", long(MAX_DETAIL_CHARS - 1)));
    // Whatever goes in, the batch passes validation.
    let texts = [
        String::new(),
        "a\0b".to_string(),
        long(10_000),
        "ş\0".repeat(1_000),
    ];
    for text in &texts {
        let result = ResultIn {
            command_id: id(1),
            outcome: Outcome::failed(FailReason::Unknown, text),
            duration_ms: 1,
        };
        assert_eq!(batch(vec![result]).validate(), Ok(()));
    }
}

fn shell_parts(result: CommandResult) -> (i32, String, String, bool) {
    match result {
        CommandResult::Shell {
            exit_code,
            stdout,
            stderr,
            truncated,
        } => (exit_code, stdout, stderr, truncated),
        other => panic!("not a shell result: {other:?}"),
    }
}

fn valid_in_a_batch(result: CommandResult) {
    let result = ResultIn {
        command_id: id(1),
        outcome: Outcome::Done { result },
        duration_ms: 1,
    };
    assert_eq!(batch(vec![result]).validate(), Ok(()));
}

#[test]
fn shell_constructor_is_valid_by_construction() {
    // Plain output as it is.
    let (code, out, err, cut) = shell_parts(CommandResult::shell(-1, b"34\n", b""));
    assert_eq!(
        (code, out.as_str(), err.as_str(), cut),
        (-1, "34\n", "", false)
    );

    // Bytes that are not UTF-8, and NUL characters, become U+FFFD.
    let (_, out, err, cut) = shell_parts(CommandResult::shell(0, b"ab\xffcd", b"init\0second\0"));
    assert_eq!(out, "ab\u{FFFD}cd");
    assert_eq!(err, "init\u{FFFD}second\u{FFFD}");
    assert!(!cut);

    // Exactly the limit is not cut; one byte more is, and says so.
    let at_limit = vec![b'a'; MAX_OUTPUT_BYTES];
    let (_, out, _, cut) = shell_parts(CommandResult::shell(0, &at_limit, b""));
    assert_eq!((out.len(), cut), (MAX_OUTPUT_BYTES, false));
    let over = vec![b'a'; MAX_OUTPUT_BYTES + 1];
    let (_, out, _, cut) = shell_parts(CommandResult::shell(0, &over, b""));
    assert_eq!((out.len(), cut), (MAX_OUTPUT_BYTES, true));

    // Cut on a character boundary: 'a' and two-byte characters leave an odd number of bytes.
    let mut two_byte = vec![b'a'];
    two_byte.extend("ş".repeat(40_000).as_bytes());
    let (_, out, _, cut) = shell_parts(CommandResult::shell(0, &two_byte, b""));
    assert_eq!(out.len(), MAX_OUTPUT_BYTES - 1);
    assert!(out.ends_with('ş') && cut);
    // A four-byte character that does not fit is dropped whole, not split.
    let mut emoji = vec![b'a'; MAX_OUTPUT_BYTES - 1];
    emoji.extend("😀".as_bytes());
    let (_, out, _, cut) = shell_parts(CommandResult::shell(0, &emoji, b""));
    assert_eq!(out, long(MAX_OUTPUT_BYTES - 1));
    assert!(cut);

    // Replacement grows the text (one byte becomes three), so it is cut after it, not before.
    for noise in [vec![0u8; 30_000], vec![0xFFu8; 30_000]] {
        let (_, out, _, cut) = shell_parts(CommandResult::shell(0, &noise, b""));
        assert_eq!(out.len(), 65_535, "21 845 replacement characters");
        assert!(out.chars().all(|c| c == '\u{FFFD}'));
        assert!(cut);
    }

    // The streams are cut apart.
    let (_, out, err, cut) = shell_parts(CommandResult::shell(7, b"x", &over));
    assert_eq!(
        (out.as_str(), err.len(), cut),
        ("x", MAX_OUTPUT_BYTES, true)
    );

    // Whatever goes in, the batch passes validation.
    for bytes in [
        Vec::new(),
        b"ok".to_vec(),
        b"\0\0\0".to_vec(),
        vec![0xFFu8; 100_000],
        two_byte.clone(),
        emoji.clone(),
        over.clone(),
        "ş\0".repeat(50_000).into_bytes(),
    ] {
        valid_in_a_batch(CommandResult::shell(0, &bytes, &bytes));
    }
}

#[test]
fn commands_query_is_clamped() {
    let clamped = |wait_s, limit| CommandsQuery { wait_s, limit }.clamped();
    // In range: left alone.
    assert_eq!(
        clamped(25, 20),
        CommandsQuery {
            wait_s: 25,
            limit: 20
        }
    );
    assert_eq!(
        clamped(10, 5),
        CommandsQuery {
            wait_s: 10,
            limit: 5
        }
    );
    // `wait_s` is 0 ..= 25: 0 means "answer now".
    assert_eq!(clamped(0, 5).wait_s, 0);
    assert_eq!(clamped(26, 5).wait_s, MAX_WAIT_S);
    assert_eq!(clamped(u32::MAX, 5).wait_s, MAX_WAIT_S);
    // `limit` is 1 ..= 20.
    assert_eq!(clamped(5, 0).limit, 1);
    assert_eq!(clamped(5, 1).limit, 1);
    assert_eq!(clamped(5, 21).limit, MAX_COMMANDS);
    assert_eq!(clamped(5, u32::MAX).limit, MAX_COMMANDS);
}
