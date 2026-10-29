use jeeta_voice_bridge::netgsm::{dial_string, hangup_cause};

#[test]
fn only_turkish_numbers_are_dialled_in_national_form() {
    assert_eq!(dial_string("+905321234567").as_deref(), Some("05321234567"));
    assert_eq!(dial_string("+902125550000").as_deref(), Some("02125550000"));
    assert_eq!(dial_string("+4915112345678"), None);
    assert_eq!(dial_string("+90532"), None);
    assert_eq!(dial_string("05321234567"), None);
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
