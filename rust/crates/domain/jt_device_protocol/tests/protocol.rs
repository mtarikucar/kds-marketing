//! The server <-> bridge wire protocol: JSON shapes, refusals, limits and validation.
use jt_device_protocol::{
    CommandResult, CommandsOut, CommandsQuery, DeviceCommand, FailReason, FileOut, HEARTBEAT_S,
    LeasedCommand, MAX_COMMANDS, MAX_DETAIL_CHARS, MAX_FEATURE_CHARS, MAX_FEATURES, MAX_ID_CHARS,
    MAX_OUTPUT_BYTES, MAX_PHONES, MAX_RESULTS, MAX_SCREEN_PX, MAX_VERSION_CHARS, MAX_WAIT_S,
    Observation, Outcome, PROTOCOL_VERSION, PhoneReport, Platform, ProtocolError, RegisterIn,
    RegisterOut, RegisteredPhone, ResultIn, ResultsIn, ResultsOut, Screen,
};
use jt_devices::Element;
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

fn invalid(error: ProtocolError) -> &'static str {
    let ProtocolError::Invalid { field, .. } = error;
    field
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
    let out = RegisterOut {
        phones: vec![RegisteredPhone {
            serial: "R58N1234ABC".into(),
            capability_id: id(2),
        }],
        heartbeat_s: HEARTBEAT_S,
        max_wait_s: MAX_WAIT_S,
        protocol: PROTOCOL_VERSION,
    };
    round_trips(
        &out,
        json!({
            "phones": [{"serial": "R58N1234ABC", "capability_id": "01900000-0000-7000-8000-000000000002"}],
            "heartbeat_s": 15,
            "max_wait_s": 25,
            "protocol": 1
        }),
    );
    // The server answers its own protocol, which may be newer than the bridge's.
    let newer: RegisterOut = serde_json::from_value(json!({
        "phones": [], "heartbeat_s": 15, "max_wait_s": 25, "protocol": 7
    }))
    .unwrap();
    assert_eq!(newer.protocol, 7);
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
            },
        },
        json!({
            "status": "done",
            "result": {"kind": "shell", "exit_code": -1, "stdout": "34\n", "stderr": ""}
        }),
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
}

#[test]
fn the_bridge_needs_one_import_path_for_the_shared_vocabulary() {
    // Re-exported from jt_devices: the same types, not copies.
    let _: jt_devices::Platform = Platform::Android;
    let _: jt_devices::Screen = screen();
    let _: jt_devices::FailReason = FailReason::Unknown;
    let _: jt_devices::DeviceCommand = DeviceCommand::Screenshot {};
    let _: jt_devices::Observation = observation();
}

#[test]
fn unknown_fields_refused() {
    // `RegisterIn` and `PhoneReport` are the exceptions: see `register_ignores_unknown_fields`.
    refuses_unknown_field::<RegisterOut>(json!({
        "phones": [], "heartbeat_s": 15, "max_wait_s": 25, "protocol": 1
    }));
    refuses_unknown_field::<RegisteredPhone>(json!({"serial": "s", "capability_id": id(2)}));
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
        "kind": "shell", "exit_code": 0, "stdout": "", "stderr": ""
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

fn long(n: usize) -> String {
    "a".repeat(n)
}

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

    for bad in ["", "  ", "R5\0"] {
        let mut r = register();
        r.phones[0].serial = bad.into();
        assert_eq!(invalid(r.validate().unwrap_err()), "serial", "{bad:?}");
    }
    let mut r = register();
    r.phones[0].serial = long(MAX_ID_CHARS + 1);
    assert_eq!(invalid(r.validate().unwrap_err()), "serial");
    r.phones[0].serial = long(MAX_ID_CHARS);
    assert_eq!(r.validate(), Ok(()));

    // Phones: the cap, and no (platform, serial) twice.
    let mut r = register();
    r.phones = (0..MAX_PHONES).map(|i| phone(&format!("s{i}"))).collect();
    assert_eq!(r.validate(), Ok(()));
    r.phones.push(phone("one-more"));
    assert_eq!(invalid(r.validate().unwrap_err()), "phones");

    let mut r = register();
    r.phones = vec![phone("same"), phone("other"), phone("same")];
    assert_eq!(invalid(r.validate().unwrap_err()), "phones");
    // The same serial on another platform is another phone.
    let mut ios = phone("same");
    ios.platform = Platform::Ios;
    r.phones = vec![phone("same"), ios];
    assert_eq!(r.validate(), Ok(()));

    // Model and OS version may be blank (a phone that says nothing), but no NUL and at most 128
    // characters.
    type Set = fn(&mut PhoneReport, String);
    let setters: [(&str, Set); 2] = [
        ("model", |p, v| p.model = Some(v)),
        ("os_version", |p, v| p.os_version = Some(v)),
    ];
    for (field, set) in setters {
        let mut r = register();
        set(&mut r.phones[0], long(MAX_ID_CHARS));
        assert_eq!(r.validate(), Ok(()), "{field}");
        set(&mut r.phones[0], "ş".repeat(MAX_ID_CHARS));
        assert_eq!(r.validate(), Ok(()), "{field}: characters, not bytes");
        set(&mut r.phones[0], String::new());
        assert_eq!(r.validate(), Ok(()), "{field}: blank is allowed");
        set(&mut r.phones[0], long(MAX_ID_CHARS + 1));
        assert_eq!(invalid(r.validate().unwrap_err()), field);
        set(&mut r.phones[0], "Pixel\0".into());
        assert_eq!(invalid(r.validate().unwrap_err()), field);
    }
    let mut r = register();
    r.phones[0].model = None;
    r.phones[0].os_version = None;
    r.phones[0].screen = None;
    assert_eq!(
        r.validate(),
        Ok(()),
        "what the bridge cannot tell may be left out"
    );

    // Screen: both sides 1 ..= 20 000 pixels, rotation a quarter turn.
    let with_screen = |w, h, rotation| {
        let mut r = register();
        r.phones[0].screen = Some(Screen { w, h, rotation });
        r.validate()
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

    // Features: each named, at most 64 characters, at most 64 of them.
    for bad in ["", "  "] {
        let mut r = register();
        r.phones[0].features.push(bad.into());
        assert_eq!(invalid(r.validate().unwrap_err()), "features", "{bad:?}");
    }
    let mut r = register();
    r.phones[0].features = vec![long(MAX_FEATURE_CHARS + 1)];
    assert_eq!(invalid(r.validate().unwrap_err()), "features");
    r.phones[0].features = vec![long(MAX_FEATURE_CHARS)];
    assert_eq!(r.validate(), Ok(()));
    r.phones[0].features = (0..MAX_FEATURES).map(|i| format!("f{i}")).collect();
    assert_eq!(r.validate(), Ok(()));
    r.phones[0].features.push("one-more".into());
    assert_eq!(invalid(r.validate().unwrap_err()), "features");
}

#[test]
fn register_validation_names_what_is_wrong() {
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

    // A failure's detail: at most 300 characters (not bytes).
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

    // Shell output: at most 64 KiB per stream, counted in bytes.
    let shell = |stdout: String, stderr: String| ResultIn {
        command_id: id(1),
        outcome: Outcome::Done {
            result: CommandResult::Shell {
                exit_code: 0,
                stdout,
                stderr,
            },
        },
        duration_ms: 1,
    };
    assert_eq!(
        batch(vec![shell(long(MAX_OUTPUT_BYTES), long(MAX_OUTPUT_BYTES))]).validate(),
        Ok(())
    );
    assert_eq!(
        invalid(
            batch(vec![shell(long(MAX_OUTPUT_BYTES + 1), String::new())])
                .validate()
                .unwrap_err()
        ),
        "stdout"
    );
    assert_eq!(
        invalid(
            batch(vec![shell(String::new(), long(MAX_OUTPUT_BYTES + 1))])
                .validate()
                .unwrap_err()
        ),
        "stderr"
    );
    // 32 769 two-byte characters are 65 538 bytes: few characters, too many bytes.
    assert_eq!(
        invalid(
            batch(vec![shell(
                "ş".repeat(MAX_OUTPUT_BYTES / 2 + 1),
                String::new()
            )])
            .validate()
            .unwrap_err()
        ),
        "stdout"
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
