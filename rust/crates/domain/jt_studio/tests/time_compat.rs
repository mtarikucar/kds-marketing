//! Studio timestamps are written as RFC 3339 text and read back either as that text or as the
//! `time` crate's compact tuples that rows stored before `time_compat` carry.

use std::collections::BTreeMap;

use jt_studio::{ApprovalReceipt, MeasurementFailure};
use jt_tenancy::UserId;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::macros::{date, datetime};
use time::{Date, OffsetDateTime};
use uuid::Uuid;

#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct Probe {
    #[serde(with = "jt_studio::time_compat")]
    at: OffsetDateTime,
    #[serde(default, with = "jt_studio::time_compat::option")]
    maybe: Option<OffsetDateTime>,
    #[serde(default, with = "jt_studio::time_compat::date_option")]
    day: Option<Date>,
    #[serde(default, with = "jt_studio::time_compat::window_option")]
    window: Option<(OffsetDateTime, OffsetDateTime)>,
    #[serde(default, with = "jt_studio::time_compat::window_map")]
    windows: BTreeMap<String, (OffsetDateTime, OffsetDateTime)>,
}

/// How `time`'s own serde (the encoding stored before) writes `value`: a tuple, never text.
fn legacy<T: Serialize>(value: T) -> Value {
    let encoded = serde_json::to_value(value).unwrap();
    assert!(encoded.is_array(), "{encoded}");
    encoded
}

#[test]
fn round_trips_rfc3339() {
    let at = datetime!(2026-10-27 09:30:15.250 +03:00);
    let receipt = ApprovalReceipt {
        revision: 3,
        by: UserId(Uuid::now_v7()),
        at,
    };
    let wire = serde_json::to_value(&receipt).unwrap();
    assert_eq!(wire["at"], "2026-10-27T09:30:15.25+03:00");
    let back: ApprovalReceipt = serde_json::from_value(wire).unwrap();
    assert_eq!(back, receipt);
    assert_eq!(back.at.offset(), at.offset());

    let failure = MeasurementFailure {
        category: "throttle".into(),
        attempts: 2,
        retry_at: datetime!(2026-10-27 06:00 UTC),
    };
    let wire = serde_json::to_value(&failure).unwrap();
    assert_eq!(wire["retry_at"], "2026-10-27T06:00:00Z");
    assert_eq!(
        serde_json::from_value::<MeasurementFailure>(wire).unwrap(),
        failure
    );
}

#[test]
fn decodes_legacy_tuple() {
    let at = datetime!(2026-10-27 09:30:15.000000123 +03:00);
    let tuple = legacy(at);
    assert_eq!(tuple, json!([2026, 300, 9, 30, 15, 123, 3, 0, 0]));
    let receipt: ApprovalReceipt = serde_json::from_value(json!({
        "revision": 1,
        "by": Uuid::now_v7(),
        "at": tuple,
    }))
    .unwrap();
    assert_eq!(receipt.at, at);
    assert_eq!(receipt.at.offset(), at.offset());
    // Written again, it is text.
    assert_eq!(
        serde_json::to_value(&receipt).unwrap()["at"],
        "2026-10-27T09:30:15.000000123+03:00"
    );
    // A negative offset and UTC come back too; a short, long or out-of-range tuple is refused.
    for at in [
        datetime!(2025-01-01 00:00 -05:30),
        datetime!(2024-12-31 23:59:59 UTC),
    ] {
        let probe: Probe = serde_json::from_value(json!({ "at": legacy(at) })).unwrap();
        assert_eq!(probe.at, at);
    }
    for bad in [
        json!([2026, 300, 9, 30, 15, 0, 3, 0]),
        json!([2026, 300, 9, 30, 15, 0, 3, 0, 0, 1]),
        json!([2026, 367, 9, 30, 15, 0, 3, 0, 0]),
        json!([2026, 300, 25, 30, 15, 0, 3, 0, 0]),
        json!("27.10.2026 09:30"),
        json!(1_761_550_000),
    ] {
        assert!(
            serde_json::from_value::<Probe>(json!({ "at": bad })).is_err(),
            "{bad}"
        );
    }
}

#[test]
fn decodes_legacy_date_tuple() {
    let day = date!(2026 - 10 - 27);
    assert_eq!(legacy(day), json!([2026, 300]));
    let at = datetime!(2026-10-27 00:00 UTC);
    let probe: Probe =
        serde_json::from_value(json!({ "at": legacy(at), "day": legacy(day) })).unwrap();
    assert_eq!(probe.day, Some(day));
    let wire = serde_json::to_value(&probe).unwrap();
    assert_eq!(wire["day"], "2026-10-27");
    assert_eq!(serde_json::from_value::<Probe>(wire).unwrap(), probe);
    assert!(
        serde_json::from_value::<Probe>(json!({ "at": legacy(at), "day": [2026, 400] })).is_err()
    );
}

#[test]
fn option_and_window() {
    let (start, end) = (
        datetime!(2026-10-26 21:00 UTC),
        datetime!(2026-10-27 21:00 UTC),
    );
    // Absent and null options read as none; present ones as either encoding.
    let bare: Probe = serde_json::from_value(json!({ "at": "2026-10-27T09:00:00Z" })).unwrap();
    assert_eq!(
        (bare.maybe, bare.day, bare.window, bare.windows.len()),
        (None, None, None, 0)
    );
    let nulls: Probe = serde_json::from_value(
        json!({ "at": "2026-10-27T09:00:00Z", "maybe": null, "day": null, "window": null }),
    )
    .unwrap();
    assert_eq!(nulls, bare);

    let old: Probe = serde_json::from_value(json!({
        "at": legacy(start),
        "maybe": legacy(end),
        "window": [legacy(start), legacy(end)],
        "windows": { "item-1": [legacy(start), legacy(end)] },
    }))
    .unwrap();
    assert_eq!(old.maybe, Some(end));
    assert_eq!(old.window, Some((start, end)));
    assert_eq!(old.windows["item-1"], (start, end));

    let wire = serde_json::to_value(&old).unwrap();
    assert_eq!(
        wire,
        json!({
            "at": "2026-10-26T21:00:00Z",
            "maybe": "2026-10-27T21:00:00Z",
            "day": null,
            "window": ["2026-10-26T21:00:00Z", "2026-10-27T21:00:00Z"],
            "windows": { "item-1": ["2026-10-26T21:00:00Z", "2026-10-27T21:00:00Z"] },
        })
    );
    assert_eq!(serde_json::from_value::<Probe>(wire).unwrap(), old);
}
