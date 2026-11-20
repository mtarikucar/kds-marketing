//! Texts and lists of lines, as written.

use crate::Invalid;

/// `raw` trimmed, when `min..=max` characters are left (characters, not bytes); else `empty`
/// (nothing left but at least one wanted) or `too_long`, naming `field`.
pub fn validate_text(field: &str, raw: &str, min: usize, max: usize) -> Result<String, Invalid> {
    let text = raw.trim();
    let len = text.chars().count();
    if len < min {
        return Err(Invalid::new(
            field,
            "empty",
            format!("{field} must not be empty"),
        ));
    }
    if len > max {
        return Err(Invalid::new(
            field,
            "too_long",
            format!("{field} must be at most {max} characters, got {len}"),
        ));
    }
    Ok(text.to_owned())
}

/// The lines of `raw`, each trimmed, the empty ones dropped, in order: `too_long` naming
/// `field[i]` (`i` the index as written) for a line over `max_chars`, `too_many` naming `field`
/// for more than `max_items` lines left.
pub fn validate_lines(
    field: &str,
    raw: &[String],
    max_items: usize,
    max_chars: usize,
) -> Result<Vec<String>, Invalid> {
    let mut lines = Vec::new();
    for (i, line) in raw.iter().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let len = line.chars().count();
        if len > max_chars {
            return Err(Invalid::new(
                format!("{field}[{i}]"),
                "too_long",
                format!("a line is at most {max_chars} characters, got {len}"),
            ));
        }
        lines.push(line.to_owned());
    }
    if lines.len() > max_items {
        return Err(Invalid::new(
            field,
            "too_many",
            format!("at most {max_items} lines, got {}", lines.len()),
        ));
    }
    Ok(lines)
}

/// `text` with at most `max` characters: whole when it fits, else its first `max - 1` and `…`.
pub fn cut(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// `text` with every run of whitespace (line breaks too) one space, trimmed.
pub(crate) fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}
