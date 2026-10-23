//! Masking credentials out of free text: error reasons that quote a provider's response, a
//! request line or a value's `Debug` output.

use jt_capability::is_secret_looking_key;

/// What a masked value is replaced with.
const MASK: &str = "***";

/// Names whose value is a secret whatever [`is_secret_looking_key`] says: the fields of an OAuth
/// code exchange. `code` and `code_verifier` do not look like secrets by name; the rest do, and
/// are listed so this rule does not depend on that predicate's fragments. Compared ignoring case,
/// `_` and `-` (`codeVerifier` is `code_verifier`).
const OAUTH_SECRET_NAMES: &[&str] = &[
    "code",
    "code_verifier",
    "client_secret",
    "refresh_token",
    "access_token",
    "app_secret",
];

/// The longest run of digits under the name `code` that reads as a provider's status or error
/// code (Meta's `"code": 190`, NetGSM's `"code": "30"`) rather than an OAuth authorization code,
/// which is never a short number.
const MAX_STATUS_CODE_DIGITS: usize = 8;

/// `text` with every credential it may carry replaced by `***`:
///
/// - after an HTTP authorization scheme: `Bearer <token>` and `Basic <credentials>` (any case,
///   the scheme a word of its own, so `instagram_basic` is left alone);
/// - the value of a JSON-looking `"key": value` pair whose key names a secret (below): a string,
///   also when the JSON is escaped inside another JSON string and when the text ends before the
///   closing quote; a whole array or object; or a scalar other than `null`, `true` and `false`;
/// - the quoted value of a bare or single-quoted key: `key: "value"` (Rust `Debug` style, also
///   `key: Some("value")`), `key="value"`, `key='value'`, `'key': 'value'`, with or without
///   spaces around `:` or `=`;
/// - the unquoted value of a query-string or form pair `key=value`.
///
/// A key names a secret when it is one of [`jt_capability::REDACTED_KEYS`] by exact name, or
/// contains `pass`, `secret`, `token`, `key`, `auth` or `credential`, in any case
/// ([`is_secret_looking_key`]), or is a field of an OAuth code exchange (`code`, `code_verifier`,
/// `client_secret`, `refresh_token`, `access_token`, `app_secret`). A short number under `code`
/// is a status code and is kept.
///
/// Everything else is kept byte for byte, including an unquoted `key: value` (prose such as
/// `token: expired`). It errs on the side of masking: prose such as `"basic setup"` loses its
/// second word.
pub fn redact_reason(text: &str) -> String {
    let text = mask_auth_schemes(text);
    let text = mask_json_pairs(&text);
    mask_bare_pairs(&text)
}

/// Whether the value under `key` is masked: the key names a secret, and the value is not a short
/// status code under `code`.
fn masks(key: &str, value: &str) -> bool {
    names_secret(key) && !is_status_code(key, value)
}

/// Whether `key` names a secret (see [`redact_reason`]).
fn names_secret(key: &str) -> bool {
    let bare = |k: &str| -> String {
        k.chars()
            .filter(|c| *c != '_' && *c != '-')
            .map(|c| c.to_ascii_lowercase())
            .collect()
    };
    is_secret_looking_key(key) || OAUTH_SECRET_NAMES.iter().any(|n| bare(n) == bare(key))
}

/// Whether `value` under `key` is a provider's status code: the key is `code` and the value 1 to
/// [`MAX_STATUS_CODE_DIGITS`] ASCII digits.
fn is_status_code(key: &str, value: &str) -> bool {
    key.eq_ignore_ascii_case("code")
        && (1..=MAX_STATUS_CODE_DIGITS).contains(&value.len())
        && value.bytes().all(|b| b.is_ascii_digit())
}

/// `text` with each byte range of `ranges` (in order, not overlapping, each starting and ending
/// next to an ASCII byte or at an end of the text) replaced by [`MASK`].
fn apply_masks(text: &str, ranges: &[(usize, usize)]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for &(start, end) in ranges {
        out.push_str(&text[last..start]);
        out.push_str(MASK);
        last = end;
    }
    out.push_str(&text[last..]);
    out
}

/// A byte of a key name: `[A-Za-z0-9_.-]`.
fn is_key_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.')
}

/// A byte of an identifier word: `[A-Za-z0-9_]`.
fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// A byte of an authorization credential (RFC 7235 `token68`, plus `%` for encoded ones).
fn is_credential_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b'+' | b'/' | b'=' | b'%')
}

/// A byte that ends an unquoted JSON scalar.
fn ends_scalar(b: u8) -> bool {
    b.is_ascii_whitespace() || matches!(b, b',' | b'}' | b']' | b'"' | b'\\')
}

/// A byte that ends the unquoted value of a query-string or form pair.
fn ends_query_value(b: u8) -> bool {
    b.is_ascii_whitespace() || matches!(b, b'&' | b'"' | b'\'' | b'<' | b'>' | b'\\')
}

fn skip_spaces(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && b[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

/// How many backslashes stand right before `b[i]`.
fn backslashes_before(b: &[u8], i: usize) -> usize {
    b[..i].iter().rev().take_while(|&&c| c == b'\\').count()
}

/// Whether `b[at..]` starts with exactly `run` backslashes and the quote `quote`: a quote at the
/// escaping level `run` (0 in plain text, 1 in JSON escaped inside a JSON string, ...).
fn quote_at(b: &[u8], at: usize, run: usize, quote: u8) -> bool {
    at + run < b.len() && b[at..at + run].iter().all(|&c| c == b'\\') && b[at + run] == quote
}

/// The quote that opens a value at `at`, with its escaping level: some backslashes, then `"` or
/// `'`.
fn opening_quote(b: &[u8], at: usize) -> Option<(u8, usize)> {
    let run = b.get(at..)?.iter().take_while(|&&c| c == b'\\').count();
    match b.get(at + run) {
        Some(&q @ (b'"' | b'\'')) => Some((q, run)),
        _ => None,
    }
}

/// Where the value that starts at `from` ends: the index of the first quote `quote` whose
/// backslashes are exactly `run` (a quote escaped once more belongs to the value), minus those
/// backslashes; `b.len()` when there is none.
fn closing_quote(b: &[u8], from: usize, run: usize, quote: u8) -> usize {
    (from..b.len())
        .find(|&q| b[q] == quote && q >= from + run && backslashes_before(b, q) == run)
        .map_or(b.len(), |q| q - run)
}

/// Where the array or object that opens at `start` ends (one past its closing bracket), skipping
/// brackets inside strings of escaping level `run`; `b.len()` when it is not closed.
fn container_end(b: &[u8], start: usize, run: usize) -> usize {
    let mut depth = 0usize;
    let mut k = start;
    while k < b.len() {
        match b[k] {
            b'"' if backslashes_before(b, k) == run => {
                let close = closing_quote(b, k + 1, run, b'"');
                if close >= b.len() {
                    return b.len();
                }
                k = close + run + 1;
                continue;
            }
            b'{' | b'[' => depth += 1,
            b'}' | b']' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return k + 1;
                }
            }
            _ => {}
        }
        k += 1;
    }
    b.len()
}

/// Masks the credential after `Bearer` and `Basic`.
fn mask_auth_schemes(text: &str) -> String {
    const SCHEMES: [&[u8]; 2] = [b"bearer", b"basic"];
    let b = text.as_bytes();
    let mut ranges = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let word_start = i == 0 || !is_word_byte(b[i - 1]);
        let scheme = SCHEMES.iter().find(|s| {
            word_start && b.len() >= i + s.len() && b[i..i + s.len()].eq_ignore_ascii_case(s)
        });
        let Some(scheme) = scheme else {
            i += 1;
            continue;
        };
        let mut j = i + scheme.len();
        let spaces = j;
        while j < b.len() && matches!(b[j], b' ' | b'\t') {
            j += 1;
        }
        if j == spaces {
            // Part of a longer word ("Basically") or the last word of the text.
            i += 1;
            continue;
        }
        let start = j;
        while j < b.len() && is_credential_byte(b[j]) {
            j += 1;
        }
        if j > start {
            ranges.push((start, j));
        }
        i = j;
    }
    apply_masks(text, &ranges)
}

/// Masks the value of each `"key": value` pair whose key names a secret, at any escaping level.
fn mask_json_pairs(text: &str) -> String {
    let b = text.as_bytes();
    let mut ranges = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'"' {
            i += 1;
            continue;
        }
        // A key: key bytes between two quotes of the same escaping level.
        let run = backslashes_before(b, i);
        let key_start = i + 1;
        let mut j = key_start;
        while j < b.len() && is_key_byte(b[j]) {
            j += 1;
        }
        if j == key_start || !quote_at(b, j, run, b'"') {
            i += 1;
            continue;
        }
        let key = &text[key_start..j];
        let after_key = j + run + 1;
        let colon = skip_spaces(b, after_key);
        if colon >= b.len() || b[colon] != b':' {
            i = after_key;
            continue;
        }
        let value = skip_spaces(b, colon + 1);
        if quote_at(b, value, run, b'"') {
            let start = value + run + 1;
            let end = closing_quote(b, start, run, b'"');
            if end > start && masks(key, &text[start..end]) {
                ranges.push((start, end));
                i = end + run + 1;
            } else {
                // Not secret: look inside, it may hold escaped JSON.
                i = value;
            }
        } else if value < b.len() && matches!(b[value], b'{' | b'[') {
            if names_secret(key) {
                // The whole container, and whatever clings to it up to the next delimiter.
                let mut end = container_end(b, value, run);
                while end < b.len() && !ends_scalar(b[end]) {
                    end += 1;
                }
                ranges.push((value, end));
                i = end;
            } else {
                i = value;
            }
        } else if value < b.len() && !matches!(b[value], b'"' | b'\\') {
            let mut end = value;
            while end < b.len() && !ends_scalar(b[end]) {
                end += 1;
            }
            let scalar = &text[value..end];
            if end > value && masks(key, scalar) && !matches!(scalar, "null" | "true" | "false") {
                ranges.push((value, end));
            }
            i = end;
        } else {
            // A quote of another level, or the end: look inside.
            i = value;
        }
    }
    apply_masks(text, &ranges)
}

/// Masks the value of each bare or single-quoted `key: "value"`, `key = 'value'` and
/// `key=value` pair whose key names a secret.
fn mask_bare_pairs(text: &str) -> String {
    let b = text.as_bytes();
    let mut ranges = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if !is_key_byte(b[i]) || (i > 0 && is_key_byte(b[i - 1])) {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < b.len() && is_key_byte(b[j]) {
            j += 1;
        }
        let key = &text[i..j];
        // A single-quoted key: `'key': 'value'`.
        let after_key = if i > 0 && b[i - 1] == b'\'' && j < b.len() && b[j] == b'\'' {
            j + 1
        } else {
            j
        };
        let sep = skip_spaces(b, after_key);
        if sep >= b.len() || !matches!(b[sep], b':' | b'=') {
            i = j;
            continue;
        }
        let mut value = skip_spaces(b, sep + 1);
        // Rust `Debug` of an optional value: `Some("...")`.
        if b[value..].starts_with(b"Some(") {
            value += "Some(".len();
        }
        if let Some((quote, run)) = opening_quote(b, value) {
            let start = value + run + 1;
            let end = closing_quote(b, start, run, quote);
            if end > start && masks(key, &text[start..end]) {
                ranges.push((start, end));
                i = end + run + 1;
            } else {
                // Not secret: look inside, it may quote pairs of its own.
                i = start;
            }
        } else if b[sep] == b'=' && sep == j && value == sep + 1 {
            // A query-string or form pair: no spaces, the value runs to a delimiter.
            let mut end = value;
            while end < b.len() && !ends_query_value(b[end]) {
                end += 1;
            }
            if end > value && masks(key, &text[value..end]) {
                ranges.push((value, end));
                i = end;
            } else {
                // Not secret: look inside, an unencoded URL may hold pairs of its own.
                i = value;
            }
        } else {
            // An unquoted `key: value` is prose ("token: expired"): left alone.
            i = j;
        }
    }
    apply_masks(text, &ranges)
}
