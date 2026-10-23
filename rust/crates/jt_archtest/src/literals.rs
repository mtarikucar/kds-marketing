//! String literals in Rust sources, read with a small lexer: the SQL statements an adapter sends.

use std::fs;
use std::path::{Path, PathBuf};

/// The comment line that marks the next SQL literal as deliberately platform-wide: it runs on a
/// platform or user transaction (`app.platform = 'on'`), not scoped to one workspace.
pub const PLATFORM_WIDE_MARKER: &str = "// archtest: platform-wide";

/// The words that make a string literal a SQL statement (matched case-insensitively).
const SQL_KEYWORDS: &[&str] = &["select", "insert", "update", "delete"];

/// A string literal that reads as SQL.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SqlLiteral {
    pub path: PathBuf,
    /// The 1-based line the literal starts on.
    pub line: usize,
    /// The literal's value: escapes resolved and `\`-continued lines joined, as the database
    /// receives it.
    pub text: String,
    /// The last non-blank line before `line`, as written (empty when there is none), where a
    /// [`PLATFORM_WIDE_MARKER`] would stand.
    pub preceding_line: String,
}

/// Every `.rs` file under `crate_dir/src` (tests and benches live outside it), with its text,
/// sorted by path.
///
/// Panics when `crate_dir/src` cannot be read or holds no Rust file, so a moved crate cannot make
/// a scan pass vacuously.
pub fn rust_sources_in(crate_dir: &Path) -> Vec<(PathBuf, String)> {
    let src = crate_dir.join("src");
    let mut paths = Vec::new();
    collect_rust_files(&src, &mut paths);
    assert!(!paths.is_empty(), "no Rust file under {}", src.display());
    paths.sort();
    paths
        .into_iter()
        .map(|path| {
            let text = fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
            (path, text)
        })
        .collect()
}

fn collect_rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries =
        fs::read_dir(dir).unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()));
    for entry in entries {
        let path = entry.expect("cannot read a directory entry").path();
        if path.is_dir() {
            collect_rust_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// The string literals (normal and raw, single- or multi-line) of the `.rs` files under
/// `crate_dir/src` that contain `select`, `insert`, `update` or `delete` in any case.
pub fn sql_literals_in(crate_dir: &Path) -> Vec<SqlLiteral> {
    rust_sources_in(crate_dir)
        .into_iter()
        .flat_map(|(path, source)| sql_literals_of(&path, &source))
        .collect()
}

/// The SQL literals of one file's `source`.
pub(crate) fn sql_literals_of(path: &Path, source: &str) -> Vec<SqlLiteral> {
    let lines: Vec<&str> = source.lines().collect();
    string_literals(source)
        .into_iter()
        .filter(|(_, text)| {
            let lower = text.to_lowercase();
            SQL_KEYWORDS.iter().any(|k| lower.contains(k))
        })
        .map(|(line, text)| SqlLiteral {
            path: path.to_path_buf(),
            line,
            text,
            preceding_line: lines[..line - 1]
                .iter()
                .rev()
                .find(|l| !l.trim().is_empty())
                .map(|l| (*l).to_owned())
                .unwrap_or_default(),
        })
        .collect()
}

/// Whether `text` contains `word` as a whole word (not inside a longer identifier), ignoring case.
pub fn mentions_word(text: &str, word: &str) -> bool {
    if word.is_empty() {
        return false;
    }
    let (text, word) = (text.to_lowercase(), word.to_lowercase());
    text.match_indices(&word).any(|(at, _)| {
        let before = text[..at].chars().next_back();
        let after = text[at + word.len()..].chars().next();
        !before.is_some_and(is_ident) && !after.is_some_and(is_ident)
    })
}

fn is_ident(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Every string literal in `source` with the 1-based line it starts on. Comments, character
/// literals and lifetimes are skipped; byte and C strings count as strings.
pub(crate) fn string_literals(source: &str) -> Vec<(usize, String)> {
    let mut lx = Lexer {
        chars: source.chars().collect(),
        pos: 0,
        line: 1,
    };
    let mut out = Vec::new();
    while let Some(c) = lx.peek(0) {
        match c {
            '/' if lx.peek(1) == Some('/') => lx.skip_line_comment(),
            '/' if lx.peek(1) == Some('*') => lx.skip_block_comment(),
            '"' => {
                let line = lx.line;
                lx.bump();
                out.push((line, lx.cooked_string()));
            }
            'r' | 'b' | 'c' if !lx.after_ident() => {
                // `r"…"`, `r#"…"#`, `br"…"`, `cr#"…"#`; a plain `b"…"` / `b'…'` is read by the
                // string and character arms once the prefix is consumed.
                let r_at = if c == 'r' { 0 } else { 1 };
                let hashes = (r_at + 1..)
                    .take_while(|&k| lx.peek(k) == Some('#'))
                    .count();
                if lx.peek(r_at) == Some('r') && lx.peek(r_at + 1 + hashes) == Some('"') {
                    let line = lx.line;
                    for _ in 0..r_at + 2 + hashes {
                        lx.bump();
                    }
                    out.push((line, lx.raw_string(hashes)));
                } else {
                    lx.bump();
                }
            }
            '\'' => lx.skip_char_or_lifetime(),
            _ => {
                lx.bump();
            }
        }
    }
    out
}

struct Lexer {
    chars: Vec<char>,
    pos: usize,
    line: usize,
}

impl Lexer {
    fn peek(&self, ahead: usize) -> Option<char> {
        self.chars.get(self.pos + ahead).copied()
    }

    fn bump(&mut self) -> Option<char> {
        let c = self.peek(0)?;
        self.pos += 1;
        if c == '\n' {
            self.line += 1;
        }
        Some(c)
    }

    /// Whether the current character continues an identifier (so `r`, `b` or `c` here is not a
    /// string prefix).
    fn after_ident(&self) -> bool {
        self.pos > 0 && is_ident(self.chars[self.pos - 1])
    }

    fn skip_line_comment(&mut self) {
        while self.peek(0).is_some_and(|c| c != '\n') {
            self.bump();
        }
    }

    /// Skips a `/* … */` comment, nested ones included.
    fn skip_block_comment(&mut self) {
        self.bump();
        self.bump();
        let mut depth = 1;
        while depth > 0 {
            match (self.peek(0), self.peek(1)) {
                (None, _) => return,
                (Some('/'), Some('*')) => {
                    self.bump();
                    self.bump();
                    depth += 1;
                }
                (Some('*'), Some('/')) => {
                    self.bump();
                    self.bump();
                    depth -= 1;
                }
                _ => {
                    self.bump();
                }
            }
        }
    }

    /// The rest of a normal string whose opening quote is consumed, up to its closing quote.
    /// A `\` before a line break drops the break and the next line's leading whitespace, as
    /// Rust does; `\n`, `\t`, `\r`, `\0`, `\\`, `\"` and `\'` are resolved; other escapes
    /// (`\x…`, `\u{…}`) are kept as written.
    fn cooked_string(&mut self) -> String {
        let mut s = String::new();
        while let Some(c) = self.bump() {
            match c {
                '"' => break,
                '\\' => match self.bump() {
                    Some('\n') => {
                        while self
                            .peek(0)
                            .is_some_and(|c| matches!(c, ' ' | '\t' | '\n' | '\r'))
                        {
                            self.bump();
                        }
                    }
                    Some('n') => s.push('\n'),
                    Some('t') => s.push('\t'),
                    Some('r') => s.push('\r'),
                    Some('0') => s.push('\0'),
                    Some(e @ ('\\' | '"' | '\'')) => s.push(e),
                    Some(other) => {
                        s.push('\\');
                        s.push(other);
                    }
                    None => break,
                },
                _ => s.push(c),
            }
        }
        s
    }

    /// The rest of a raw string with `hashes` hashes whose opening is consumed.
    fn raw_string(&mut self, hashes: usize) -> String {
        let mut s = String::new();
        while let Some(c) = self.bump() {
            if c == '"' && (0..hashes).all(|k| self.peek(k) == Some('#')) {
                for _ in 0..hashes {
                    self.bump();
                }
                break;
            }
            s.push(c);
        }
        s
    }

    /// Skips a character literal (`'x'`, `'"'`, `'\''`, `'\u{…}'`); for a lifetime or label
    /// (`'a`, `'static`) only the quote is consumed.
    fn skip_char_or_lifetime(&mut self) {
        self.bump();
        match (self.peek(0), self.peek(1)) {
            (Some('\\'), _) => {
                self.bump();
                self.bump();
                while self.bump().is_some_and(|c| c != '\'') {}
            }
            (Some(_), Some('\'')) => {
                self.bump();
                self.bump();
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(source: &str) -> Vec<(usize, String)> {
        string_literals(source)
    }

    #[test]
    fn normal_strings_resolve_escapes_and_join_continued_lines() {
        let source =
            "let q = \"select a, \\\n         b from t where x = '\\\\' and y = \\\"z\\\"\";";
        assert_eq!(
            values(source),
            [(
                1,
                "select a, b from t where x = '\\' and y = \"z\"".to_owned()
            )]
        );
    }

    #[test]
    fn raw_strings_span_lines_and_keep_quotes() {
        let source = "fn f() {}\nlet q = r#\"select \"x\"\nfrom t\"#;\nlet p = br\"delete\";\nlet s = r\"a\";";
        assert_eq!(
            values(source),
            [
                (2, "select \"x\"\nfrom t".to_owned()),
                (4, "delete".to_owned()),
                (5, "a".to_owned()),
            ]
        );
    }

    #[test]
    fn comments_chars_and_lifetimes_are_not_strings() {
        let source = r#"
            // a "select" in a comment
            /* "update" /* nested "x" */ "still a comment" */
            fn f<'a>(x: &'a str) -> &'static str {
                let q = '"';
                let e = '\'';
                let b = '\\';
                let u = '\u{22}';
                let byte = b'"';
                'outer: loop { break 'outer; }
                "insert"
            }
            let return_value = c"x"; let raw_ident = r#type;
        "#;
        assert_eq!(
            values(source),
            [(11, "insert".to_owned()), (13, "x".to_owned())]
        );
    }

    #[test]
    fn sql_literals_carry_the_preceding_non_blank_line() {
        let source = "let a = \"no sql here\";\nquery(\n    // archtest: platform-wide\n\n    \"SELECT 1 from roles\",\n);\nlet b = \"Update x\";";
        let found = sql_literals_of(Path::new("x.rs"), source);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].line, 5);
        assert_eq!(found[0].text, "SELECT 1 from roles");
        assert_eq!(found[0].preceding_line.trim(), PLATFORM_WIDE_MARKER);
        assert_eq!(found[1].line, 7);
        assert_eq!(found[1].preceding_line, ");");
        let first = sql_literals_of(Path::new("y.rs"), "\"delete\"");
        assert_eq!(first[0].preceding_line, "");
    }

    #[test]
    fn words_match_whole_identifiers_only() {
        assert!(mentions_word("select 1 from roles r", "roles"));
        assert!(mentions_word("FROM ROLES", "roles"));
        assert!(mentions_word("join roles\nwhere", "roles"));
        assert!(!mentions_word("from user_roles", "roles"));
        assert!(!mentions_word("policy roles_ws", "roles"));
        assert!(!mentions_word("where workspace_id = $1", "workspaces"));
        assert!(!mentions_word("anything", ""));
    }
}
