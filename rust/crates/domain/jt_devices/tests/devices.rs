//! The device command vocabulary: wire shape, bounds, lifecycle and feature negotiation.
use jt_devices::{
    CommandError, CommandStatus, DeviceCommand, DeviceKey, ElementTarget, FailReason,
    LifecycleError, LifecycleEvent, MAX_ARG_CHARS, MAX_LONG_PRESS_MS, MAX_SHELL_ARGS, MAX_SWIPE_MS,
    MAX_TEXT_CHARS, Observation, Platform, TEXT_UNICODE, next_status, supports,
};
use serde_json::json;
use uuid::Uuid;

fn file_id() -> Uuid {
    Uuid::from_u128(0x0190_0000_0000_7000_8000_0000_0000_0001)
}

/// One command per kind, each paired with its exact wire form.
fn every_kind() -> Vec<(DeviceCommand, serde_json::Value)> {
    vec![
        (
            DeviceCommand::Observe { screenshot: true },
            json!({"kind": "observe", "screenshot": true}),
        ),
        (
            DeviceCommand::Tap { x: 540, y: 1200 },
            json!({"kind": "tap", "x": 540, "y": 1200}),
        ),
        (
            DeviceCommand::TapOn {
                target: ElementTarget::Text("Gönder".into()),
                exact: false,
            },
            json!({"kind": "tap_on", "text": "Gönder", "exact": false}),
        ),
        (
            DeviceCommand::TapOn {
                target: ElementTarget::Id("com.app:id/send".into()),
                exact: true,
            },
            json!({"kind": "tap_on", "id": "com.app:id/send", "exact": true}),
        ),
        (
            DeviceCommand::TapOn {
                target: ElementTarget::Desc("Ara".into()),
                exact: false,
            },
            json!({"kind": "tap_on", "desc": "Ara", "exact": false}),
        ),
        (
            DeviceCommand::LongPress {
                x: 10,
                y: 20,
                ms: 800,
            },
            json!({"kind": "long_press", "x": 10, "y": 20, "ms": 800}),
        ),
        (
            DeviceCommand::Swipe {
                x1: 1,
                y1: 2,
                x2: 3,
                y2: 4,
                ms: 300,
            },
            json!({"kind": "swipe", "x1": 1, "y1": 2, "x2": 3, "y2": 4, "ms": 300}),
        ),
        (
            DeviceCommand::Text {
                value: "merhaba".into(),
            },
            json!({"kind": "text", "value": "merhaba"}),
        ),
        (
            DeviceCommand::Key {
                key: DeviceKey::AppSwitch,
            },
            json!({"kind": "key", "key": "app_switch"}),
        ),
        (
            DeviceCommand::OpenUrl {
                url: "https://example.com/a".into(),
            },
            json!({"kind": "open_url", "url": "https://example.com/a"}),
        ),
        (
            DeviceCommand::LaunchApp {
                app_id: "com.whatsapp".into(),
            },
            json!({"kind": "launch_app", "app_id": "com.whatsapp"}),
        ),
        (
            DeviceCommand::Shell {
                argv: vec!["getprop".into(), "ro.build.version.sdk".into()],
            },
            json!({"kind": "shell", "argv": ["getprop", "ro.build.version.sdk"]}),
        ),
        (
            DeviceCommand::PushFile {
                file_id: file_id(),
                dest: "/sdcard/Download/a.jpg".into(),
            },
            json!({
                "kind": "push_file",
                "file_id": "01900000-0000-7000-8000-000000000001",
                "dest": "/sdcard/Download/a.jpg"
            }),
        ),
        (
            DeviceCommand::PullFile {
                path: "/sdcard/DCIM/a.jpg".into(),
            },
            json!({"kind": "pull_file", "path": "/sdcard/DCIM/a.jpg"}),
        ),
        (DeviceCommand::Screenshot, json!({"kind": "screenshot"})),
    ]
}

#[test]
fn every_kind_round_trips_as_tagged_json() {
    let all = every_kind();
    for (command, wire) in &all {
        assert_eq!(&serde_json::to_value(command).unwrap(), wire, "{command:?}");
        let back: DeviceCommand = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(&back, command, "{wire}");
        assert_eq!(wire["kind"], command.kind(), "the tag is the kind");
    }
    // All thirteen kinds are covered (`tap_on` appears once per target).
    let kinds: std::collections::BTreeSet<_> = all.iter().map(|(c, _)| c.kind()).collect();
    assert_eq!(
        kinds,
        std::collections::BTreeSet::from([
            "observe",
            "tap",
            "tap_on",
            "long_press",
            "swipe",
            "text",
            "key",
            "open_url",
            "launch_app",
            "shell",
            "push_file",
            "pull_file",
            "screenshot",
        ])
    );
}

#[test]
fn defaults_fill_the_optional_flags() {
    let observe: DeviceCommand = serde_json::from_value(json!({"kind": "observe"})).unwrap();
    assert_eq!(observe, DeviceCommand::Observe { screenshot: false });
    let tap_on: DeviceCommand =
        serde_json::from_value(json!({"kind": "tap_on", "id": "x"})).unwrap();
    assert_eq!(
        tap_on,
        DeviceCommand::TapOn {
            target: ElementTarget::Id("x".into()),
            exact: false
        }
    );
}

#[test]
fn every_key_has_its_snake_case_name() {
    for (key, name) in [
        (DeviceKey::Back, "back"),
        (DeviceKey::Home, "home"),
        (DeviceKey::Enter, "enter"),
        (DeviceKey::AppSwitch, "app_switch"),
        (DeviceKey::Delete, "delete"),
        (DeviceKey::VolumeUp, "volume_up"),
        (DeviceKey::VolumeDown, "volume_down"),
        (DeviceKey::Power, "power"),
    ] {
        assert_eq!(serde_json::to_value(key).unwrap(), json!(name));
        assert_eq!(
            serde_json::from_value::<DeviceKey>(json!(name)).unwrap(),
            key
        );
    }
}

#[test]
fn unknown_kind_and_unknown_field_refused() {
    for wire in [
        json!({"kind": "format_disk"}),
        json!({"kind": "tap", "x": 1, "y": 2, "z": 3}),
        json!({"kind": "text", "value": "a", "append": true}),
        json!({"kind": "tap_on", "text": "a", "exact": false, "extra": 1}),
        // A target is exactly one of text, id, desc: two of them are not an answer.
        json!({"kind": "tap_on", "text": "a", "id": "b"}),
        // A command that names no target at all.
        json!({"kind": "tap_on", "exact": true}),
        // The tag itself is required.
        json!({"x": 1, "y": 2}),
        json!({"kind": "tap", "x": -1, "y": 2}),
        json!({"kind": "key", "key": "reboot"}),
    ] {
        assert!(
            serde_json::from_value::<DeviceCommand>(wire.clone()).is_err(),
            "{wire} was accepted"
        );
    }
}

fn invalid(command: &DeviceCommand) -> &'static str {
    match command.validate() {
        Err(CommandError::Invalid { field, .. }) => field,
        Ok(()) => panic!("{command:?} passed validation"),
    }
}

fn text(value: &str) -> DeviceCommand {
    DeviceCommand::Text {
        value: value.to_owned(),
    }
}

#[test]
fn bounds_are_checked() {
    // Text: not empty, at most 4000 characters (characters, not bytes).
    assert_eq!(invalid(&text("")), "value");
    assert_eq!(invalid(&text(&"a".repeat(MAX_TEXT_CHARS + 1))), "value");
    assert_eq!(text(&"a".repeat(MAX_TEXT_CHARS)).validate(), Ok(()));
    // 4000 two-byte characters are 8000 bytes and still within the bound.
    assert_eq!(text(&"ş".repeat(MAX_TEXT_CHARS)).validate(), Ok(()));
    assert_eq!(invalid(&text(&"ş".repeat(MAX_TEXT_CHARS + 1))), "value");
    // A lone space is something to type.
    assert_eq!(text(" ").validate(), Ok(()));

    // Swipe: 1..=5000 ms.
    let swipe = |ms| DeviceCommand::Swipe {
        x1: 0,
        y1: 0,
        x2: 1,
        y2: 1,
        ms,
    };
    assert_eq!(invalid(&swipe(0)), "ms");
    assert_eq!(invalid(&swipe(MAX_SWIPE_MS + 1)), "ms");
    assert_eq!(swipe(1).validate(), Ok(()));
    assert_eq!(swipe(MAX_SWIPE_MS).validate(), Ok(()));

    // Long press: 1..=10_000 ms.
    let long_press = |ms| DeviceCommand::LongPress { x: 0, y: 0, ms };
    assert_eq!(invalid(&long_press(0)), "ms");
    assert_eq!(invalid(&long_press(MAX_LONG_PRESS_MS + 1)), "ms");
    assert_eq!(long_press(1).validate(), Ok(()));
    assert_eq!(long_press(MAX_LONG_PRESS_MS).validate(), Ok(()));

    // Shell: at least one, at most 64 arguments, each at most 4096 characters.
    let shell = |argv: Vec<String>| DeviceCommand::Shell { argv };
    assert_eq!(invalid(&shell(vec![])), "argv");
    assert_eq!(
        invalid(&shell(vec!["echo".to_owned(); MAX_SHELL_ARGS + 1])),
        "argv"
    );
    assert_eq!(invalid(&shell(vec!["a".repeat(MAX_ARG_CHARS + 1)])), "argv");
    assert_eq!(
        invalid(&shell(vec!["ok".into(), "a".repeat(MAX_ARG_CHARS + 1)])),
        "argv"
    );
    assert_eq!(
        shell(vec!["echo".to_owned(); MAX_SHELL_ARGS]).validate(),
        Ok(())
    );
    assert_eq!(shell(vec!["a".repeat(MAX_ARG_CHARS)]).validate(), Ok(()));

    // Names and paths: not empty, not blank.
    for blank in ["", "  ", "\t\n"] {
        assert_eq!(
            invalid(&DeviceCommand::LaunchApp {
                app_id: blank.into()
            }),
            "app_id"
        );
        assert_eq!(
            invalid(&DeviceCommand::OpenUrl { url: blank.into() }),
            "url"
        );
        assert_eq!(
            invalid(&DeviceCommand::PushFile {
                file_id: file_id(),
                dest: blank.into()
            }),
            "dest"
        );
        assert_eq!(
            invalid(&DeviceCommand::PullFile { path: blank.into() }),
            "path"
        );
        for target in [
            ElementTarget::Text(blank.into()),
            ElementTarget::Id(blank.into()),
            ElementTarget::Desc(blank.into()),
        ] {
            assert_eq!(
                invalid(&DeviceCommand::TapOn {
                    target,
                    exact: false
                }),
                "target"
            );
        }
    }
}

#[test]
fn commands_without_bounds_validate() {
    for (command, _) in every_kind() {
        assert_eq!(command.validate(), Ok(()), "{command:?}");
    }
    // Coordinates are the device's to bound: the vocabulary does not know the screen.
    assert_eq!(
        DeviceCommand::Tap {
            x: u32::MAX,
            y: u32::MAX
        }
        .validate(),
        Ok(())
    );
}

#[test]
fn no_access_policy_in_validation() {
    // The owner wants full access now; whatever restricts it later is a separate layer.
    let shell = DeviceCommand::Shell {
        argv: vec!["rm".into(), "-rf".into(), "/sdcard/x".into()],
    };
    assert_eq!(shell.validate(), Ok(()));
    let intent = DeviceCommand::OpenUrl {
        url: "intent://scan/#Intent;scheme=zxing;end".into(),
    };
    assert_eq!(intent.validate(), Ok(()));
    let launch = DeviceCommand::LaunchApp {
        app_id: "com.android.settings".into(),
    };
    assert_eq!(launch.validate(), Ok(()));
    let power = DeviceCommand::Key {
        key: DeviceKey::Power,
    };
    assert_eq!(power.validate(), Ok(()));
}

#[test]
fn command_error_names_the_field_and_reason() {
    let err = text("").validate().unwrap_err();
    let shown = err.to_string();
    assert!(shown.starts_with("value: "), "{shown}");
}

#[test]
fn lifecycle_transitions() {
    use CommandStatus::*;
    use LifecycleEvent as E;

    // From queued: leased, or straight to any end.
    assert_eq!(next_status(Queued, E::Leased), Ok(Leased));
    assert_eq!(next_status(Queued, E::Done), Ok(Done));
    assert_eq!(next_status(Queued, E::Failed), Ok(Failed));
    assert_eq!(next_status(Queued, E::Expired), Ok(Expired));
    assert_eq!(next_status(Queued, E::Canceled), Ok(Canceled));

    // From leased: leased again (redelivery), or any end.
    assert_eq!(next_status(Leased, E::Leased), Ok(Leased));
    assert_eq!(next_status(Leased, E::Done), Ok(Done));
    assert_eq!(next_status(Leased, E::Failed), Ok(Failed));
    assert_eq!(next_status(Leased, E::Expired), Ok(Expired));
    assert_eq!(next_status(Leased, E::Canceled), Ok(Canceled));

    // An end is final: nothing moves it, not even the same event again.
    for from in [Done, Failed, Expired, Canceled] {
        assert!(from.is_final());
        for event in [E::Leased, E::Done, E::Failed, E::Expired, E::Canceled] {
            assert_eq!(
                next_status(from, event),
                Err(LifecycleError { from, event }),
                "{from:?} then {event:?}"
            );
        }
    }
    assert!(!Queued.is_final());
    assert!(!Leased.is_final());

    let shown = next_status(Done, E::Canceled).unwrap_err().to_string();
    assert!(
        shown.contains("Done") && shown.contains("Canceled"),
        "{shown}"
    );
}

#[test]
fn statuses_and_reasons_use_snake_case_names() {
    for (status, name) in [
        (CommandStatus::Queued, "queued"),
        (CommandStatus::Leased, "leased"),
        (CommandStatus::Done, "done"),
        (CommandStatus::Failed, "failed"),
        (CommandStatus::Expired, "expired"),
        (CommandStatus::Canceled, "canceled"),
    ] {
        assert_eq!(serde_json::to_value(status).unwrap(), json!(name));
        assert_eq!(
            serde_json::from_value::<CommandStatus>(json!(name)).unwrap(),
            status
        );
    }
    for (reason, name) in [
        (FailReason::DeviceOffline, "device_offline"),
        (FailReason::ElementNotFound, "element_not_found"),
        (FailReason::UnicodeUnsupported, "unicode_unsupported"),
        (FailReason::UnsupportedOnPlatform, "unsupported_on_platform"),
        (FailReason::UnsupportedByBridge, "unsupported_by_bridge"),
        (FailReason::AdbError, "adb_error"),
        (FailReason::ScreenBusy, "screen_busy"),
        (FailReason::Timeout, "timeout"),
        (FailReason::BridgeError, "bridge_error"),
    ] {
        assert_eq!(serde_json::to_value(reason).unwrap(), json!(name));
        assert_eq!(
            serde_json::from_value::<FailReason>(json!(name)).unwrap(),
            reason
        );
    }
    assert_eq!(
        serde_json::to_value(Platform::Android).unwrap(),
        json!("android")
    );
    assert_eq!(serde_json::to_value(Platform::Ios).unwrap(), json!("ios"));
}

#[test]
fn timing_constants_match_the_lifecycle() {
    assert_eq!(jt_devices::REDELIVER_AFTER, time::Duration::seconds(10));
    assert_eq!(jt_devices::DEFAULT_EXPIRES_IN, time::Duration::minutes(5));
}

fn features(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}

#[test]
fn supports_needs_kind_and_unicode_feature() {
    let ascii = text("merhaba");
    let turkish = text("Ayşe");
    assert!(supports(&features(&["text"]), &ascii));
    assert!(!supports(&features(&["text"]), &turkish));
    assert!(supports(&features(&["text", TEXT_UNICODE]), &turkish));
    // The unicode feature alone is not the kind.
    assert!(!supports(&features(&[TEXT_UNICODE]), &turkish));
    assert!(!supports(&features(&[TEXT_UNICODE]), &ascii));
    assert_eq!(TEXT_UNICODE, "text.unicode");

    let shell = DeviceCommand::Shell {
        argv: vec!["id".into()],
    };
    assert!(!supports(&features(&["tap", "text"]), &shell));
    assert!(supports(&features(&["tap", "shell"]), &shell));
    assert!(!supports(&[], &DeviceCommand::Screenshot));

    // Every kind is matched by its own name and by nothing else.
    for (command, _) in every_kind() {
        assert!(
            supports(&features(&[command.kind()]), &command),
            "{command:?}"
        );
        assert!(!supports(&features(&["something_else"]), &command));
    }
}

#[test]
fn observation_round_trips_and_marks_truncation() {
    let wire = json!({
        "screen": {"w": 1080, "h": 2400, "rotation": 0},
        "foreground_app": "com.whatsapp",
        "elements": [{
            "text": "Gönder",
            "id": "com.whatsapp:id/send",
            "desc": null,
            "class": "android.widget.ImageButton",
            "bounds": [900, 2200, 1060, 2360],
            "tap_point": [980, 2280],
            "clickable": true,
            "editable": false,
            "focused": false
        }],
        "truncated": false,
        "screenshot_file_id": null
    });
    let observation: Observation = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(observation.screen.w, 1080);
    assert_eq!(observation.foreground_app.as_deref(), Some("com.whatsapp"));
    assert_eq!(observation.elements[0].tap_point, [980, 2280]);
    assert_eq!(observation.elements[0].desc, None);
    assert_eq!(serde_json::to_value(&observation).unwrap(), wire);
    assert_eq!(jt_devices::MAX_ELEMENTS, 300);
}
