//! No log call of the bridge names a phone number, a text, a key or a password (lib.rs, Logging).
use std::path::Path;

const MACROS: [&str; 5] = ["info!(", "warn!(", "error!(", "debug!(", "trace!("];
const FORBIDDEN: [&str; 11] = [
    "text",
    "e164",
    "to_e164",
    "dial",
    "transcript",
    "password",
    "key",
    "body",
    "url",
    "phone",
    "number",
];

fn words(s: &str) -> Vec<String> {
    s.split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty())
        .map(str::to_owned)
        .collect()
}

#[test]
fn no_log_call_names_a_number_a_text_or_a_secret() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut checked = 0;
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    files.sort();
    for file in files
        .into_iter()
        .filter(|p| p.extension().is_some_and(|e| e == "rs"))
    {
        let code = std::fs::read_to_string(&file).unwrap();
        for m in MACROS {
            let mut rest = code.as_str();
            while let Some(at) = rest.find(m) {
                let call = &rest[at..];
                let end = call.find(");").unwrap_or(call.len());
                for w in words(&call[..end]) {
                    assert!(
                        !FORBIDDEN.contains(&w.as_str()),
                        "{}: a log call names `{w}`: {}",
                        file.display(),
                        &call[..end]
                    );
                }
                checked += 1;
                rest = &call[m.len()..];
            }
        }
    }
    // Not vacuous once the run loop exists (task D2): it logs.
    assert!(
        checked > 0 || !dir.join("run_loop.rs").exists(),
        "no log call found"
    );
}
