//! SMS segment accounting for the default GSM-7 alphabet and UTF-16 fallback.

/// Count billable SMS segments, with no transliteration or national language shift tables.
/// Empty text is zero. GSM-7 uses 160/153 septets (extension characters take two); otherwise
/// the entire message uses UTF-16 code units with 70/67 units per segment.
///
/// # Panics
/// Panics if the count exceeds u16. Send boundaries must reject oversized bodies before
/// calling this helper; it never wraps or silently undercounts an oversized message.
pub fn sms_segments(text: &str) -> u16 {
    let septets = text
        .chars()
        .try_fold(0usize, |count, c| gsm_units(c).map(|units| count + units));
    let (units, single, multipart) = match septets {
        Some(count) => (count, 160, 153),
        None => (text.encode_utf16().count(), 70, 67),
    };
    let segments = if units == 0 {
        0
    } else if units <= single {
        1
    } else {
        units.div_ceil(multipart)
    };
    u16::try_from(segments).expect("SMS segment count exceeds u16")
}

fn gsm_units(c: char) -> Option<usize> {
    match c {
        '\u{000c}' | '^' | '{' | '}' | '\\' | '[' | '~' | ']' | '|' | '€' => Some(2),
        ' '..='?'
        | 'A'..='Z'
        | 'a'..='z'
        | '@'
        | '£'
        | '¥'
        | 'è'
        | 'é'
        | 'ù'
        | 'ì'
        | 'ò'
        | 'Ç'
        | '\n'
        | 'Ø'
        | 'ø'
        | '\r'
        | 'Å'
        | 'å'
        | 'Δ'
        | '_'
        | 'Φ'
        | 'Γ'
        | 'Λ'
        | 'Ω'
        | 'Π'
        | 'Ψ'
        | 'Σ'
        | 'Θ'
        | 'Ξ'
        | 'Æ'
        | 'æ'
        | 'ß'
        | 'É'
        | '¤'
        | '¡'
        | 'Ä'
        | 'Ö'
        | 'Ñ'
        | 'Ü'
        | '§'
        | '¿'
        | 'ä'
        | 'ö'
        | 'ñ'
        | 'ü'
        | 'à' => Some(1),
        _ => None,
    }
}
