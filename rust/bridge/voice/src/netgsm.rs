//! The line's rules: extension 102 may call Turkish numbers only (Dahili, Şehiriçi, GSM; no
//! international), dialled in national form; Asterisk's Q.850 causes become the core's words.

/// `+90XXXXXXXXXX` as the PBX dials it (`0XXXXXXXXXX`); `None` for any other number.
pub fn dial_string(e164: &str) -> Option<String> {
    let national = e164.strip_prefix("+90")?;
    (national.len() == 10 && national.bytes().all(|b| b.is_ascii_digit()))
        .then(|| format!("0{national}"))
}

/// The core's word for why a line closed (`jt_calls` reads `busy`, `failed`, `congestion`, and any
/// other word before the answer as no answer): after the answer always `normal`.
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
