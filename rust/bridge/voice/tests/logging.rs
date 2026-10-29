//! What the bridge may log and print, read from its sources (lib.rs, Logging; B4 review I7).
//!
//! An allowlist, not a list of forbidden words: a denylist of a few identifiers misses a
//! `?command` whose derived `Debug` holds the sentence, a field called `utterance`, a message that
//! interpolates `{text}`, an `#[instrument]` that records every argument, and a `println!`. So:
//! - a log call (`trace!` … `error!`, `event!`, the `span!` family) carries named fields from
//!   [`FIELDS`] only (ids, kinds, states, counts, durations, error kinds), and formats a value with
//!   `Debug` (`?`) only under [`DEBUG_FIELDS`], whose values hold no text; its message is a literal
//!   that interpolates nothing; no value names one of [`TEXT_WORDS`];
//! - `#[instrument]` only with `skip_all`;
//! - no `dbg!`, and `println!`, `eprintln!`, `print!` or `eprint!` only in the console programs
//!   ([`CONSOLE`]), where no interpolated value names one of [`TEXT_WORDS`] but the slice's opt-in
//!   transcript line ([`TRANSCRIPT_OPT_IN`], behind `--show-transcript`);
//! - a file that names `reqwest::Error` strips its address (`without_url`).
//!
//! The types that carry a sentence print no text in `Debug` either (`tests/redaction.rs`), so a
//! value passed under an allowed field by mistake shows a length. jt_calls' `Command` and
//! `BridgeEvent` keep their derived `Debug` (the core's types); the `?` rule keeps them out of the
//! bridge's logs. The rules are checked on samples first, so the scan is not vacuous before the
//! bridge has log calls of its own.
use std::path::{Path, PathBuf};

const LOG_MACROS: [&str; 12] = [
    "trace",
    "debug",
    "info",
    "warn",
    "error",
    "event",
    "span",
    "trace_span",
    "debug_span",
    "info_span",
    "warn_span",
    "error_span",
];
const PRINT_MACROS: [&str; 5] = ["println", "eprintln", "print", "eprint", "dbg"];
/// The fields a log call may carry.
const FIELDS: [&str; 13] = [
    "call", "command", "kind", "state", "cause", "reason", "status", "count", "ms", "seq", "set",
    "index", "error",
];
/// The fields whose values may be formatted with `Debug`: enums and numbers, no text.
const DEBUG_FIELDS: [&str; 5] = ["cause", "status", "state", "kind", "set"];
/// Identifiers no logged or printed value may name.
const TEXT_WORDS: [&str; 21] = [
    "text",
    "texts",
    "transcript",
    "sentence",
    "sentences",
    "utterance",
    "words",
    "digit",
    "digits",
    "e164",
    "to_e164",
    "dial",
    "phone",
    "number",
    "password",
    "key",
    "url",
    "body",
    "hotwords",
    "pcm",
    "audio",
];
/// The console programs, whose output goes to the operator's terminal.
const CONSOLE: [&str; 2] = ["main.rs", "slice.rs"];
/// The one console line that prints what the caller said: the slice's, behind
/// `--show-transcript` (plan B6).
const TRANSCRIPT_OPT_IN: &str = r#"println!("caller: {text}")"#;

/// `code` without its `//` comments (strings and char literals kept).
fn strip_comments(code: &str) -> String {
    let chars: Vec<char> = code.chars().collect();
    let mut out = String::new();
    let (mut i, mut in_string) = (0, false);
    while i < chars.len() {
        let c = chars[i];
        if in_string {
            out.push(c);
            if c == '\\' && i + 1 < chars.len() {
                out.push(chars[i + 1]);
                i += 1;
            } else if c == '"' {
                in_string = false;
            }
        } else if c == '"' {
            in_string = true;
            out.push(c);
        } else if c == '\'' && chars.get(i + 2) == Some(&'\'') {
            out.extend(&chars[i..i + 3]);
            i += 2;
        } else if c == '\'' && chars.get(i + 1) == Some(&'\\') {
            let end = (i + 2..chars.len())
                .find(|j| chars[*j] == '\'')
                .unwrap_or(chars.len() - 1);
            out.extend(&chars[i..=end]);
            i = end;
        } else if c == '/' && chars.get(i + 1) == Some(&'/') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        } else {
            out.push(c);
        }
        i += 1;
    }
    out
}

/// The calls of the macros `names` in `code`: each macro's name and its text, `name!(…)` whole.
fn calls(code: &str, names: &[&str]) -> Vec<(String, String)> {
    let chars: Vec<char> = code.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let starts_word = i == 0 || !(chars[i - 1].is_alphanumeric() || chars[i - 1] == '_');
        let name = names.iter().find(|n| {
            let n: Vec<char> = n.chars().collect();
            starts_word
                && chars[i..].starts_with(&n)
                && chars.get(i + n.len()) == Some(&'!')
                && chars.get(i + n.len() + 1) == Some(&'(')
        });
        let Some(name) = name else {
            i += 1;
            continue;
        };
        let open = i + name.chars().count() + 1;
        let (mut depth, mut j, mut in_string) = (0, open, false);
        while j < chars.len() {
            let c = chars[j];
            if in_string {
                if c == '\\' {
                    j += 1;
                } else if c == '"' {
                    in_string = false;
                }
            } else if c == '"' {
                in_string = true;
            } else if c == '(' {
                depth += 1;
            } else if c == ')' {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            j += 1;
        }
        let end = j.min(chars.len() - 1);
        out.push(((*name).to_owned(), chars[i..=end].iter().collect()));
        i = end + 1;
    }
    out
}

/// The arguments of a call's text (`name!(a, b)`), split at its top-level commas.
fn arguments(call: &str) -> Vec<String> {
    let inner = &call[call.find('(').map_or(0, |p| p + 1)..call.len().saturating_sub(1)];
    let (mut out, mut current, mut depth, mut in_string, mut escaped) =
        (Vec::new(), String::new(), 0i32, false, false);
    for c in inner.chars() {
        if in_string {
            current.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => in_string = true,
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            ',' if depth == 0 => {
                out.push(std::mem::take(&mut current).trim().to_owned());
                continue;
            }
            _ => {}
        }
        current.push(c);
    }
    if !current.trim().is_empty() {
        out.push(current.trim().to_owned());
    }
    out
}

fn words(s: &str) -> Vec<&str> {
    s.split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty())
        .collect()
}

/// The values a format literal interpolates (`{name}`, `{name:?}`, `{}`), `{{` excepted.
fn interpolations(literal: &str) -> Vec<String> {
    let chars: Vec<char> = literal.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '{' {
            if chars.get(i + 1) == Some(&'{') {
                i += 2;
                continue;
            }
            let end = (i..chars.len())
                .find(|j| chars[*j] == '}')
                .unwrap_or(chars.len());
            let inside: String = chars[i + 1..end].iter().collect();
            out.push(inside.split(':').next().unwrap_or_default().to_owned());
            i = end;
        }
        i += 1;
    }
    out
}

fn names_text(value: &str) -> Option<&str> {
    words(value).into_iter().find(|w| TEXT_WORDS.contains(w))
}

/// What is wrong with log call `call`.
fn log_call_problems(call: &str) -> Vec<String> {
    let mut problems = Vec::new();
    let mut message_seen = false;
    for arg in arguments(call) {
        if arg.starts_with('"') {
            if message_seen {
                problems.push(format!("a second literal: {call}"));
            }
            message_seen = true;
            if !interpolations(&arg).is_empty() {
                problems.push(format!("the message interpolates a value: {call}"));
            }
            continue;
        }
        if message_seen {
            problems.push(format!("the message formats a value: {call}"));
            continue;
        }
        // `event!`'s level, and `target:` / `parent:` / `name:`.
        let plain = arg.split_whitespace().collect::<String>();
        if plain.starts_with("Level::")
            || plain.starts_with("tracing::Level::")
            || ["target:", "parent:", "name:"]
                .iter()
                .any(|k| plain.starts_with(k))
        {
            continue;
        }
        let (name, value) = match arg.split_once('=') {
            Some((name, value)) if !value.starts_with('=') => {
                (name.trim().to_owned(), value.trim().to_owned())
            }
            _ => {
                let name = arg.trim_start_matches(['%', '?']).trim().to_owned();
                (name, arg.clone())
            }
        };
        let name = name.trim_start_matches(['%', '?']).to_owned();
        if !FIELDS.contains(&name.as_str()) {
            problems.push(format!("the field `{name}` is not on the list: {call}"));
        }
        if value.starts_with('?') && !DEBUG_FIELDS.contains(&name.as_str()) {
            problems.push(format!("`{name}` is formatted with Debug: {call}"));
        }
        if let Some(word) = names_text(&value) {
            problems.push(format!("a value names `{word}`: {call}"));
        }
    }
    problems
}

/// What is wrong with print call `call` in a console program.
fn print_call_problems(call: &str) -> Vec<String> {
    if call.split_whitespace().collect::<Vec<_>>().join(" ") == TRANSCRIPT_OPT_IN {
        return Vec::new();
    }
    let mut problems = Vec::new();
    for arg in arguments(call) {
        let values = if arg.starts_with('"') {
            interpolations(&arg)
        } else {
            vec![arg.clone()]
        };
        for value in values {
            if let Some(word) = names_text(&value) {
                problems.push(format!("a printed value names `{word}`: {call}"));
            }
        }
    }
    problems
}

/// What is wrong with source file `file` (its name decides whether it may print).
fn problems(file: &str, code: &str) -> (Vec<String>, usize) {
    let code = strip_comments(code);
    let mut out = Vec::new();
    let log_calls = calls(&code, &LOG_MACROS);
    for (_, call) in &log_calls {
        out.extend(log_call_problems(call));
    }
    let console = CONSOLE.contains(&file);
    for (name, call) in calls(&code, &PRINT_MACROS) {
        if name == "dbg" || !console {
            out.push(format!("{file} prints: {call}"));
        } else {
            out.extend(print_call_problems(&call));
        }
    }
    let compact: String = code.chars().filter(|c| !c.is_whitespace()).collect();
    for (at, _) in compact
        .match_indices("#[instrument")
        .chain(compact.match_indices("#[tracing::instrument"))
    {
        let attribute = &compact[at..compact[at..].find(']').map_or(compact.len(), |e| at + e)];
        if !attribute.contains("skip_all") {
            out.push(format!(
                "{file}: #[instrument] without skip_all records every argument"
            ));
        }
    }
    if code.contains("reqwest::Error") && !code.contains("without_url") {
        out.push(format!(
            "{file} names reqwest::Error and never strips its URL"
        ));
    }
    (out, log_calls.len())
}

fn sources(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(next) = pending.pop() {
        for entry in std::fs::read_dir(&next).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
            } else if path.extension().is_some_and(|e| e == "rs") {
                files.push(path);
            }
        }
    }
    files.sort();
    files
}

#[test]
fn the_rules_pass_what_the_bridge_logs_and_prints() {
    for (file, code) in [
        (
            "call.rs",
            r#"info!(call = %id, cause = ?cause, "the line closed before an answer");"#,
        ),
        (
            "call.rs",
            r#"warn!(call = %id, reason, "the call's media did not come up");"#,
        ),
        (
            "call.rs",
            r#"info!(call = %self.id, ms, "first audio after the answer");"#,
        ),
        (
            "run_loop.rs",
            r#"warn!(error = %e, "the command poll failed");"#,
        ),
        (
            "run_loop.rs",
            r#"info!(status = ?out.status, "registered with the core");"#,
        ),
        (
            "run_loop.rs",
            r#"warn!(command = %c.id, kind = %c.kind, "a command this build cannot read");"#,
        ),
        (
            "run_loop.rs",
            r#"warn!(count, "hung up the channels left from before");"#,
        ),
        (
            "run_loop.rs",
            r#"info!("the line is up"); // info!(text = %t, "a comment")"#,
        ),
        (
            "run_loop.rs",
            r#"tracing::event!(tracing::Level::INFO, call = %id, "{{literal}}");"#,
        ),
        (
            "call.rs",
            "#[tracing::instrument(skip_all, fields(call = %id))]\nfn f() {}",
        ),
        (
            "client.rs",
            "impl From<reqwest::Error> for E { fn from(e: reqwest::Error) -> E { E(e.without_url()) } }",
        ),
        ("slice.rs", r#"println!("caller: {text}");"#),
        (
            "slice.rs",
            r#"println!("said {seq} cut at {interrupted_at_char:?}");"#,
        ),
        (
            "slice.rs",
            r#"println!("trace {}", serde_json::to_string(&trace).unwrap_or_default());"#,
        ),
        (
            "main.rs",
            r#"eprintln!("usage: jeeta-voice-bridge slice --opening TEXT --reply TEXT");"#,
        ),
    ] {
        let (found, _) = problems(file, code);
        assert!(found.is_empty(), "{file}: {code}: {found:?}");
    }
}

#[test]
fn the_rules_catch_what_would_leak() {
    for (file, code) in [
        ("call.rs", r#"info!(call = %id, heard = ?h, "a turn");"#),
        (
            "call.rs",
            r#"warn!(call = %id, command = ?command, "a command");"#,
        ),
        ("call.rs", r#"info!("the caller said {text}");"#),
        ("call.rs", r#"info!("said {}", sentence);"#),
        ("call.rs", r#"info!(call = %text, "a turn");"#),
        ("call.rs", r#"debug!(sentence = %s, "synthesising");"#),
        ("call.rs", r#"info!(utterance = %u, "heard");"#),
        ("call.rs", r#"info!(digit = %d, "a key");"#),
        ("call.rs", r#"info!(phone_number = %p, "dialling");"#),
        ("call.rs", r#"tracing::event!(Level::INFO, sentence = %s);"#),
        (
            "call.rs",
            r#"tracing::info_span!("call", transcript = ?t);"#,
        ),
        ("call.rs", r#"warn!(error = %e.url, "refused");"#),
        ("call.rs", "#[instrument]\nasync fn say(text: String) {}"),
        (
            "call.rs",
            "#[tracing::instrument(fields(call = %id))]\nfn f() {}",
        ),
        ("call.rs", r#"println!("caller: {text}");"#),
        ("call.rs", r#"eprintln!("{e}");"#),
        ("slice.rs", "dbg!(item);"),
        ("slice.rs", r#"println!("dialling {dial}");"#),
        ("slice.rs", r#"println!("{}", item.text);"#),
        (
            "client.rs",
            "fn f(e: reqwest::Error) -> String { e.to_string() }",
        ),
    ] {
        let (found, _) = problems(file, code);
        assert!(!found.is_empty(), "not caught in {file}: {code}");
    }
}

#[test]
fn no_log_or_print_call_of_the_bridge_carries_a_text_a_number_or_a_secret() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let files = sources(&dir);
    assert!(files.len() >= 5, "{files:?}");
    let mut checked = 0;
    for path in &files {
        let code = std::fs::read_to_string(path).unwrap();
        let name = path.file_name().unwrap().to_str().unwrap();
        let (found, logs) = problems(name, &code);
        assert!(found.is_empty(), "{}: {found:#?}", path.display());
        checked += logs;
    }
    // Not vacuous once the run loop exists (task D2): it logs.
    assert!(
        checked > 0 || !dir.join("run_loop.rs").exists(),
        "no log call found"
    );
}
