//! Reading NetGSM's JSON: its ids (job ids of 26 digits and more, callback ids) may come as bare
//! numbers too long for a 64-bit integer, which a JSON reader rounds into a float. They are put in
//! quotes before the text is read, so they keep every digit.

use std::borrow::Cow;

use serde_json::Value;

/// `text` read as JSON, every bare integer too long for `i64`/`u64` read as the string of its
/// digits; `None` when it is not JSON.
pub(crate) fn read(text: &str) -> Option<Value> {
    serde_json::from_str(&quote_long_integers(text)).ok()
}

/// `text` with every bare JSON integer outside a string that does not fit `i64` or `u64` put in
/// quotes. Anything else is kept byte for byte; text that is not JSON stays not JSON.
pub(crate) fn quote_long_integers(text: &str) -> Cow<'_, str> {
    let bytes = text.as_bytes();
    let mut out: Option<String> = None;
    let mut copied = 0;
    let mut i = 0;
    let mut in_string = false;
    while i < bytes.len() {
        let b = bytes[i];
        if in_string {
            match b {
                b'\\' => i += 2,
                b'"' => {
                    in_string = false;
                    i += 1;
                }
                _ => i += 1,
            }
            continue;
        }
        match b {
            b'"' => {
                in_string = true;
                i += 1;
            }
            b'-' | b'0'..=b'9' => {
                let start = i;
                let mut end = i + usize::from(b == b'-');
                while end < bytes.len() && bytes[end].is_ascii_digit() {
                    end += 1;
                }
                let integral = end;
                while end < bytes.len()
                    && matches!(bytes[end], b'.' | b'e' | b'E' | b'+' | b'-' | b'0'..=b'9')
                {
                    end += 1;
                }
                let token = &text[start..end];
                let too_long = integral == end
                    && integral > start + usize::from(b == b'-')
                    && token.parse::<i64>().is_err()
                    && token.parse::<u64>().is_err();
                if too_long {
                    let buffer = out.get_or_insert_with(|| String::with_capacity(text.len() + 8));
                    buffer.push_str(&text[copied..start]);
                    buffer.push('"');
                    buffer.push_str(token);
                    buffer.push('"');
                    copied = end;
                }
                i = end;
            }
            _ => i += 1,
        }
    }
    match out {
        Some(mut buffer) => {
            buffer.push_str(&text[copied..]);
            Cow::Owned(buffer)
        }
        None => Cow::Borrowed(text),
    }
}

/// A non-empty string (trimmed), or an integer as text: how NetGSM's ids and codes come.
pub(crate) fn text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_owned()),
        Value::Number(n) if n.is_i64() || n.is_u64() => Some(n.to_string()),
        _ => None,
    }
}

/// The first of `keys` in `object` that holds a [`text`].
pub(crate) fn pick(object: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| text(&object[*key]))
}

/// The first of `keys` in `object` that holds a whole number (a number or a string of one; a
/// fraction is cut).
pub(crate) fn pick_number(object: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|key| match &object[*key] {
        Value::Number(n) => n.as_i64().or_else(|| {
            n.as_f64()
                .filter(|f| f.is_finite() && f.abs() < 1e15)
                .map(|f| f.trunc() as i64)
        }),
        Value::String(s) => s.trim().parse::<i64>().ok(),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn long_integers_keep_every_digit() {
        assert_eq!(
            read(r#"{"code":"00","jobid":17000000000000000000000009}"#),
            Some(json!({ "code": "00", "jobid": "17000000000000000000000009" }))
        );
        assert_eq!(
            read("[-99999999999999999999999, 18446744073709551615, -9223372036854775808]"),
            Some(json!([
                "-99999999999999999999999",
                18_446_744_073_709_551_615_u64,
                i64::MIN
            ]))
        );
    }

    #[test]
    fn everything_else_is_kept() {
        for text in [
            r#"{"a":"17000000000000000000000009","b":1.5e3,"c":-0.25}"#,
            r#"{"s":"say \"17000000000000000000000009\" \\","n":12}"#,
            "12345678901234567890.5",
            "",
            "-",
            "\"unterminated \\",
        ] {
            assert!(
                matches!(quote_long_integers(text), Cow::Borrowed(_)),
                "{text}"
            );
        }
        assert_eq!(read("1.5e3"), Some(json!(1500.0)));
        // Text that is not JSON stays not JSON.
        assert_eq!(read("not json 99999999999999999999999"), None);
        assert_eq!(read("{"), None);
    }

    #[test]
    fn ids_read_as_text() {
        let row = json!({ "a": " 12 ", "b": 7, "c": 1.5, "d": "", "e": null, "n": "42", "f": 2.9 });
        assert_eq!(pick(&row, &["d", "a"]), Some("12".into()));
        assert_eq!(pick(&row, &["c", "b"]), Some("7".into()));
        assert_eq!(pick(&row, &["e", "missing"]), None);
        assert_eq!(pick_number(&row, &["n"]), Some(42));
        assert_eq!(pick_number(&row, &["f"]), Some(2));
        assert_eq!(pick_number(&row, &["a"]), Some(12));
        assert_eq!(pick_number(&row, &["d", "e"]), None);
    }
}
