//! The line's rules: extension 102 calls Turkish subscribers' numbers only, dialled in national
//! form: geographic (area codes 2xx, 3xx, 4xx), mobile (5xx), 0800 and 0850. No international
//! number, not even through the national prefix ("+90 0…"), no premium or other non-geographic
//! range (0900, the other 8xx) and no short code (1xx). Asterisk's Q.850 causes become the core's
//! words, and the causes that say the number cannot be called at all a permanent failure.

/// `+90XXXXXXXXXX` as the PBX dials it (`0XXXXXXXXXX`) when the line may call it (see the module
/// docs); `None` for any other number.
pub fn dial_string(e164: &str) -> Option<String> {
    let national = e164.strip_prefix("+90")?;
    let digits = national.len() == 10 && national.bytes().all(|b| b.is_ascii_digit());
    let callable = matches!(national.as_bytes().first(), Some(b'2'..=b'5'))
        || national.starts_with("800")
        || national.starts_with("850");
    (digits && callable).then(|| format!("0{national}"))
}

/// The core's word for why a line closed (`jt_calls` reads `busy`, `failed`, `congestion`, and any
/// other word before the answer as no answer): after the answer always `normal`. A cause
/// [`permanent_failure`] names is reported with that line instead.
pub fn hangup_cause(q850: Option<u32>, answered: bool) -> &'static str {
    if answered {
        return "normal";
    }
    match q850 {
        Some(17 | 21) => "busy",
        Some(1 | 3 | 28) => "failed",
        Some(34 | 38 | 41 | 42 | 44 | 58) => "congestion",
        _ => "no_answer",
    }
}

/// The failure line of a line that closed before the answer because the number cannot be called
/// at all (Q.850 1 unallocated, 3 no route, 28 invalid number format): reported as the call's
/// `error`, whose `permanent` kind tells the agent not to try the number again, where a `hangup`
/// would read as a transient failure (`jt_calls`: `transient: bridge: failed`).
pub fn permanent_failure(q850: Option<u32>, answered: bool) -> Option<&'static str> {
    if answered {
        return None;
    }
    match q850 {
        Some(1) => Some("permanent: bridge: the number is not in use (Q.850 1)"),
        Some(3) => Some("permanent: bridge: the number cannot be reached (Q.850 3)"),
        Some(28) => Some("permanent: bridge: the number is not valid (Q.850 28)"),
        _ => None,
    }
}
