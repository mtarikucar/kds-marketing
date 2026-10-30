use jeeta_voice_bridge::netgsm::{dial_string, hangup_cause, permanent_failure};

#[test]
fn only_turkish_numbers_are_dialled_in_national_form() {
    assert_eq!(dial_string("+905321234567").as_deref(), Some("05321234567"));
    assert_eq!(dial_string("+902125550000").as_deref(), Some("02125550000"));
    assert_eq!(dial_string("+4915112345678"), None);
    assert_eq!(dial_string("+90532"), None);
    assert_eq!(dial_string("05321234567"), None);
}

/// B4 review I6 (2026-10-29): geographic (2, 3, 4) and mobile (5) numbers, 0800 and 0850; nothing
/// that leaves the country (00…), costs more (0900…) or is not a subscriber's line.
#[test]
fn the_line_calls_geographic_mobile_free_and_national_numbers_only() {
    for (e164, dialled) in [
        ("+902125550000", "02125550000"),
        ("+903125550000", "03125550000"),
        ("+904125550000", "04125550000"),
        ("+905321234567", "05321234567"),
        ("+908001234567", "08001234567"),
        ("+908501234567", "08501234567"),
    ] {
        assert_eq!(dial_string(e164).as_deref(), Some(dialled), "{e164}");
    }
    for e164 in [
        // International through the national prefix.
        "+900491511234",
        // Short codes, unassigned ranges and premium numbers.
        "+901121234567",
        "+906001234567",
        "+907001234567",
        "+909001234567",
        "+908881234567",
        "+908221234567",
        "+908991234567",
        // Not ten digits, or not digits.
        "+9053212345678",
        "+90532123456",
        "+90532123456a",
        "+90 532123456",
    ] {
        assert_eq!(dial_string(e164), None, "{e164}");
    }
}

#[test]
fn q850_causes_map_to_the_cores_words() {
    assert_eq!(hangup_cause(Some(16), true), "normal");
    assert_eq!(hangup_cause(Some(17), false), "busy");
    assert_eq!(hangup_cause(Some(21), false), "busy");
    assert_eq!(hangup_cause(Some(19), false), "no_answer");
    assert_eq!(hangup_cause(Some(34), false), "congestion");
    assert_eq!(hangup_cause(Some(1), false), "failed");
    assert_eq!(hangup_cause(None, false), "no_answer");
}

/// B4 review M5: a number that cannot be called at all is a permanent failure, reported as the
/// call's error (`permanent: …`), so it is not taken for a line that may answer later.
#[test]
fn a_number_that_cannot_be_called_is_a_permanent_failure() {
    for cause in [1, 3, 28] {
        let line = permanent_failure(Some(cause), false).expect("permanent");
        assert!(line.starts_with("permanent: bridge: "), "{line}");
        assert!(line.ends_with(&format!("(Q.850 {cause})")), "{line}");
    }
    for cause in [Some(16), Some(17), Some(19), Some(21), Some(34), None] {
        assert_eq!(permanent_failure(cause, false), None, "{cause:?}");
    }
    // After the answer the line closed normally, whatever the cause.
    assert_eq!(permanent_failure(Some(1), true), None);
}
