//! The device command vocabulary: wire shape, bounds, lifecycle and feature negotiation.
use jt_devices::{
    CommandError, CommandStatus, DeviceCommand, DeviceKey, Element, ElementTarget, FailReason,
    LifecycleError, LifecycleEvent, MAX_APP_ID_CHARS, MAX_ARG_CHARS, MAX_ELEMENTS,
    MAX_LONG_PRESS_MS, MAX_PATH_CHARS, MAX_SHELL_ARGS, MAX_SHELL_TOTAL_CHARS, MAX_SWIPE_MS,
    MAX_TEXT_CHARS, MAX_URL_CHARS, Observation, Platform, Screen, TEXT_UNICODE, next_status,
    supports,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
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
        (DeviceCommand::Screenshot {}, json!({"kind": "screenshot"})),
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
    // All thirteen kinds are covered (`tap_on` appears once per target), and `KINDS` lists
    // exactly them, once each.
    let kinds: std::collections::BTreeSet<_> = all.iter().map(|(c, _)| c.kind()).collect();
    let listed: std::collections::BTreeSet<_> = DeviceCommand::KINDS.iter().copied().collect();
    assert_eq!(kinds, listed);
    assert_eq!(
        DeviceCommand::KINDS.len(),
        listed.len(),
        "a kind is listed twice"
    );
    assert_eq!(listed.len(), 13);
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

/// An enum's `ALL`, `key` and `from_key` agree with each other, with the serde name and with the
/// explicit table (which pins the wire names and lists every variant).
fn check_names<T>(
    table: &[(T, &str)],
    all: &[T],
    key: fn(T) -> &'static str,
    from_key: fn(&str) -> Option<T>,
) where
    T: Copy + std::fmt::Debug + PartialEq + Serialize + DeserializeOwned,
{
    assert_eq!(
        all,
        table.iter().map(|(t, _)| *t).collect::<Vec<_>>(),
        "ALL lists every variant, in order"
    );
    for (item, name) in table {
        assert_eq!(serde_json::to_value(item).unwrap(), json!(name), "{item:?}");
        assert_eq!(serde_json::from_value::<T>(json!(name)).unwrap(), *item);
        assert_eq!(key(*item), *name);
        assert_eq!(from_key(name), Some(*item));
    }
    assert_eq!(from_key("no_such_name"), None);
}

#[test]
fn keys_have_their_snake_case_names() {
    check_names(
        &[
            (DeviceKey::Back, "back"),
            (DeviceKey::Home, "home"),
            (DeviceKey::Enter, "enter"),
            (DeviceKey::AppSwitch, "app_switch"),
            (DeviceKey::Delete, "delete"),
            (DeviceKey::VolumeUp, "volume_up"),
            (DeviceKey::VolumeDown, "volume_down"),
            (DeviceKey::Power, "power"),
        ],
        DeviceKey::ALL,
        DeviceKey::key,
        DeviceKey::from_key,
    );
}

#[test]
fn statuses_have_their_snake_case_names() {
    check_names(
        &[
            (CommandStatus::Queued, "queued"),
            (CommandStatus::Leased, "leased"),
            (CommandStatus::Done, "done"),
            (CommandStatus::Failed, "failed"),
            (CommandStatus::Expired, "expired"),
            (CommandStatus::Canceled, "canceled"),
        ],
        CommandStatus::ALL,
        CommandStatus::key,
        CommandStatus::from_key,
    );
}

#[test]
fn reasons_have_their_snake_case_names() {
    check_names(
        &[
            (FailReason::DeviceOffline, "device_offline"),
            (FailReason::ElementNotFound, "element_not_found"),
            (FailReason::UnicodeUnsupported, "unicode_unsupported"),
            (FailReason::UnsupportedOnPlatform, "unsupported_on_platform"),
            (FailReason::UnsupportedByBridge, "unsupported_by_bridge"),
            (FailReason::AdbError, "adb_error"),
            (FailReason::ScreenBusy, "screen_busy"),
            (FailReason::Timeout, "timeout"),
            (FailReason::BridgeError, "bridge_error"),
            (FailReason::Unknown, "unknown"),
        ],
        FailReason::ALL,
        FailReason::key,
        FailReason::from_key,
    );
}

#[test]
fn platforms_have_their_snake_case_names() {
    check_names(
        &[(Platform::Android, "android"), (Platform::Ios, "ios")],
        Platform::ALL,
        Platform::key,
        Platform::from_key,
    );
}

#[test]
fn events_have_their_snake_case_names() {
    let table = [
        (LifecycleEvent::Leased, "leased"),
        (LifecycleEvent::Done, "done"),
        (LifecycleEvent::Failed, "failed"),
        (LifecycleEvent::Expired, "expired"),
        (LifecycleEvent::Canceled, "canceled"),
    ];
    assert_eq!(
        LifecycleEvent::ALL,
        table.iter().map(|(e, _)| *e).collect::<Vec<_>>()
    );
    for (event, name) in table {
        assert_eq!(serde_json::to_value(event).unwrap(), json!(name));
        assert_eq!(event.key(), name);
    }
}

#[test]
fn a_reason_from_a_newer_bridge_is_unknown_not_an_error() {
    // An older server must not reject a whole batch of results over a reason it has never heard of.
    let reasons: Vec<FailReason> =
        serde_json::from_value(json!(["timeout", "holographic_jam", "adb_error"])).unwrap();
    assert_eq!(
        reasons,
        [
            FailReason::Timeout,
            FailReason::Unknown,
            FailReason::AdbError
        ]
    );
    // A stored name that no variant owns is not "unknown": only the wire is forgiving.
    assert_eq!(FailReason::from_key("holographic_jam"), None);
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

#[test]
fn screenshot_refuses_extra_fields() {
    // `screenshot` takes no arguments: whatever comes with it is a mistake, not something to drop.
    let extra = json!({"kind": "screenshot", "region": [0, 0, 1, 1]});
    assert!(serde_json::from_value::<DeviceCommand>(extra).is_err());
    // The bare form is the only one, in both directions.
    let bare = json!({"kind": "screenshot"});
    assert_eq!(
        serde_json::from_value::<DeviceCommand>(bare.clone()).unwrap(),
        DeviceCommand::Screenshot {}
    );
    assert_eq!(
        serde_json::to_value(DeviceCommand::Screenshot {}).unwrap(),
        bare
    );
    // `observe` has a field, so its unknown fields were refused all along: pinned here too.
    assert!(serde_json::from_value::<DeviceCommand>(json!({"kind": "observe", "foo": 1})).is_err());
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

fn shell(argv: Vec<String>) -> DeviceCommand {
    DeviceCommand::Shell { argv }
}

fn open_url(url: &str) -> DeviceCommand {
    DeviceCommand::OpenUrl { url: url.into() }
}

fn launch_app(app_id: &str) -> DeviceCommand {
    DeviceCommand::LaunchApp {
        app_id: app_id.into(),
    }
}

fn push_file(dest: &str) -> DeviceCommand {
    DeviceCommand::PushFile {
        file_id: file_id(),
        dest: dest.into(),
    }
}

fn pull_file(path: &str) -> DeviceCommand {
    DeviceCommand::PullFile { path: path.into() }
}

fn tap_on_text(target: &str) -> DeviceCommand {
    DeviceCommand::TapOn {
        target: ElementTarget::Text(target.into()),
        exact: false,
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
    assert_eq!(invalid(&shell(vec![])), "argv");
    assert_eq!(
        invalid(&shell(vec!["a".to_owned(); MAX_SHELL_ARGS + 1])),
        "argv"
    );
    assert_eq!(invalid(&shell(vec!["a".repeat(MAX_ARG_CHARS + 1)])), "argv");
    assert_eq!(
        invalid(&shell(vec!["ok".into(), "a".repeat(MAX_ARG_CHARS + 1)])),
        "argv"
    );
    assert_eq!(
        shell(vec!["a".to_owned(); MAX_SHELL_ARGS]).validate(),
        Ok(())
    );
    assert_eq!(shell(vec!["a".repeat(MAX_ARG_CHARS)]).validate(), Ok(()));

    // Names and paths: not empty, not blank.
    for blank in ["", "  ", "\t\n"] {
        assert_eq!(invalid(&launch_app(blank)), "app_id");
        assert_eq!(invalid(&open_url(blank)), "url");
        assert_eq!(invalid(&push_file(blank)), "dest");
        assert_eq!(invalid(&pull_file(blank)), "path");
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
fn string_fields_have_their_own_length_bounds() {
    // Each bound is in characters: the over-long string is one character too many, and the
    // longest allowed one made of two-byte characters is still fine.
    type Build = fn(&str) -> DeviceCommand;
    let fields: [(Build, &str, usize); 5] = [
        (open_url, "url", MAX_URL_CHARS),
        (launch_app, "app_id", MAX_APP_ID_CHARS),
        (push_file, "dest", MAX_PATH_CHARS),
        (pull_file, "path", MAX_PATH_CHARS),
        (tap_on_text, "target", MAX_TEXT_CHARS),
    ];
    for (build, field, max) in fields {
        assert_eq!(build(&"a".repeat(max)).validate(), Ok(()), "{field}");
        assert_eq!(build(&"ş".repeat(max)).validate(), Ok(()), "{field}");
        assert_eq!(invalid(&build(&"a".repeat(max + 1))), field);
        assert_eq!(invalid(&build(&"ş".repeat(max + 1))), field);
    }
    // The other two kinds of target are bounded the same way.
    for target in [
        ElementTarget::Id("a".repeat(MAX_TEXT_CHARS + 1)),
        ElementTarget::Desc("a".repeat(MAX_TEXT_CHARS + 1)),
    ] {
        let command = DeviceCommand::TapOn {
            target,
            exact: true,
        };
        assert_eq!(invalid(&command), "target");
    }
    assert_eq!(
        (MAX_URL_CHARS, MAX_APP_ID_CHARS, MAX_PATH_CHARS),
        (8192, 256, 4096)
    );
}

#[test]
fn shell_arguments_are_bounded_together() {
    // The separators count: a space between arguments, one per argument.
    assert_eq!(MAX_SHELL_TOTAL_CHARS, 16_384);
    // 4 arguments of 4095 characters and 4 separators are exactly the limit ...
    let at_limit = vec!["a".repeat(MAX_ARG_CHARS - 1); 4];
    assert_eq!(shell(at_limit).validate(), Ok(()));
    // ... and one character more is over it, though every argument is within its own bound.
    let mut over = vec!["a".repeat(MAX_ARG_CHARS - 1); 3];
    over.push("a".repeat(MAX_ARG_CHARS));
    assert_eq!(invalid(&shell(over)), "argv");
    // 64 arguments of 255 characters reach the limit only with the separators counted: the
    // characters alone are 16320, and one character more per argument is over it.
    assert_eq!(shell(vec!["a".repeat(255); 64]).validate(), Ok(()));
    assert_eq!(invalid(&shell(vec!["a".repeat(256); 64])), "argv");
    // Characters, not bytes.
    assert_eq!(shell(vec!["ş".repeat(255); 64]).validate(), Ok(()));
}

#[test]
fn a_nul_character_is_refused_in_every_process_argument() {
    // Well-formedness, not policy: a NUL ends a C string, so the device would see something other
    // than what was asked.
    let nul = "a\0b";
    assert_eq!(invalid(&shell(vec![nul.into()])), "argv");
    assert_eq!(invalid(&shell(vec!["ok".into(), nul.into()])), "argv");
    assert_eq!(invalid(&open_url(nul)), "url");
    assert_eq!(invalid(&launch_app(nul)), "app_id");
    assert_eq!(invalid(&push_file(nul)), "dest");
    assert_eq!(invalid(&pull_file(nul)), "path");
    assert_eq!(invalid(&text(nul)), "value");
    for target in [
        ElementTarget::Text(nul.into()),
        ElementTarget::Id(nul.into()),
        ElementTarget::Desc(nul.into()),
    ] {
        let command = DeviceCommand::TapOn {
            target,
            exact: false,
        };
        assert_eq!(invalid(&command), "target");
    }
    // A string that is only a NUL is no better, and at the ends of a field it is the same.
    assert_eq!(invalid(&open_url("\0")), "url");
    assert_eq!(invalid(&text("abc\0")), "value");
    assert_eq!(invalid(&text("\0abc")), "value");
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

    // Every move there is. A command finishes only after a lease (`Queued` then `Done` is not a
    // thing), but it can fail, expire or be canceled before one. A result that comes in after
    // the command expired or was canceled is still the truth: it replaces that status.
    let allowed = [
        (Queued, E::Leased, Leased),
        (Queued, E::Failed, Failed),
        (Queued, E::Expired, Expired),
        (Queued, E::Canceled, Canceled),
        (Leased, E::Leased, Leased),
        (Leased, E::Done, Done),
        (Leased, E::Failed, Failed),
        (Leased, E::Expired, Expired),
        (Leased, E::Canceled, Canceled),
        (Expired, E::Done, Done),
        (Expired, E::Failed, Failed),
        (Canceled, E::Done, Done),
        (Canceled, E::Failed, Failed),
    ];
    for from in CommandStatus::ALL {
        for event in LifecycleEvent::ALL {
            let expected = allowed
                .iter()
                .find(|(f, e, _)| f == from && e == event)
                .map(|(_, _, to)| *to);
            assert_eq!(
                next_status(*from, *event),
                expected.ok_or(LifecycleError {
                    from: *from,
                    event: *event
                }),
                "{from:?} then {event:?}"
            );
        }
    }

    // The ones that matter, by name.
    assert!(next_status(Queued, E::Done).is_err());
    assert_eq!(next_status(Queued, E::Failed), Ok(Failed));
    assert_eq!(next_status(Leased, E::Leased), Ok(Leased));
}

#[test]
fn late_result_replaces_an_expired_or_canceled_status() {
    use CommandStatus::*;
    use LifecycleEvent as E;
    for from in [Expired, Canceled] {
        assert_eq!(next_status(from, E::Done), Ok(Done));
        assert_eq!(next_status(from, E::Failed), Ok(Failed));
        // Such a command is never leased again, nor ended another way.
        assert!(next_status(from, E::Leased).is_err());
        assert!(next_status(from, E::Expired).is_err());
        assert!(next_status(from, E::Canceled).is_err());
    }
    // A result that was already recorded is not replaced by another.
    for from in [Done, Failed] {
        for event in LifecycleEvent::ALL {
            assert!(
                next_status(from, *event).is_err(),
                "{from:?} then {event:?}"
            );
        }
    }
}

#[test]
fn is_final_means_no_more_leasing_or_waiting() {
    use CommandStatus::*;
    for status in [Done, Failed, Expired, Canceled] {
        assert!(status.is_final(), "{status:?}");
    }
    assert!(!Queued.is_final());
    assert!(!Leased.is_final());
}

#[test]
fn lifecycle_error_shows_wire_names() {
    let shown = next_status(CommandStatus::Done, LifecycleEvent::Canceled)
        .unwrap_err()
        .to_string();
    assert_eq!(shown, "a done command cannot be canceled");
    let shown = next_status(CommandStatus::Queued, LifecycleEvent::Done)
        .unwrap_err()
        .to_string();
    assert_eq!(shown, "a queued command cannot be done");
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
    assert!(!supports(&[], &DeviceCommand::Screenshot {}));

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
    assert_eq!(MAX_ELEMENTS, 300);
}

fn element(n: usize) -> Element {
    Element {
        text: Some(format!("e{n}")),
        id: None,
        desc: None,
        class: None,
        bounds: [0, 0, 1, 1],
        tap_point: [0, 0],
        clickable: false,
        editable: false,
        focused: false,
    }
}

fn observation_of(count: usize) -> Observation {
    Observation {
        screen: Screen {
            w: 1080,
            h: 2400,
            rotation: 0,
        },
        foreground_app: None,
        elements: (0..count).map(element).collect(),
        truncated: false,
        screenshot_file_id: None,
    }
}

#[test]
fn cap_elements_cuts_a_long_screen_and_says_so() {
    let mut long = observation_of(MAX_ELEMENTS + 50);
    long.cap_elements();
    assert_eq!(long.elements.len(), MAX_ELEMENTS);
    assert!(long.truncated);
    // The first elements are the ones kept, in order.
    assert_eq!(long.elements[0], element(0));
    assert_eq!(long.elements[MAX_ELEMENTS - 1], element(MAX_ELEMENTS - 1));

    // One over the cap is already too many.
    let mut one_over = observation_of(MAX_ELEMENTS + 1);
    one_over.cap_elements();
    assert_eq!(one_over.elements.len(), MAX_ELEMENTS);
    assert!(one_over.truncated);
}

#[test]
fn cap_elements_leaves_a_screen_within_the_cap_alone() {
    let mut exact = observation_of(MAX_ELEMENTS);
    let before = exact.clone();
    exact.cap_elements();
    assert_eq!(exact, before);
    assert!(!exact.truncated);

    // An observation a driver already marked as cut keeps its mark.
    let mut cut = observation_of(3);
    cut.truncated = true;
    cut.cap_elements();
    assert_eq!(cut.elements.len(), 3);
    assert!(cut.truncated);

    let mut empty = observation_of(0);
    empty.cap_elements();
    assert!(empty.elements.is_empty());
    assert!(!empty.truncated);
}
