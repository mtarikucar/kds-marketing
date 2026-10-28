//! Running `adb`: the [`AdbRunner`] seam the driver calls (a fake one in the tests),
//! [`SystemAdb`], which runs the real program, and [`DeviceLine`], a command line for the
//! phone's shell with every value quoted.
//!
//! `adb` is always given an argument list, never a line for the computer's shell to split. What
//! `adb shell` is given is another matter: it joins its arguments with spaces and the phone's
//! shell reads the result, so every value from a command (typed text, an address, a shell
//! argument) is quoted for the phone's shell first ([`quote`]).

use std::borrow::Cow;
use std::fmt;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use jt_device_protocol::MAX_OUTPUT_BYTES;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

/// How long one `adb` call the driver makes may take: reading the screen, a tap, a property.
pub const ADB_TIMEOUT: Duration = Duration::from_secs(20);
/// How long an agent's own `shell` command may run on the phone. It ends within the loop's
/// command timeout (`Timing::command_timeout`, 120 s), so the driver says what happened.
pub const ADB_SHELL_TIMEOUT: Duration = Duration::from_secs(110);
/// How long `adb push` or `adb pull` may take: within the loop's `Timing::transfer_timeout`
/// (30 min).
pub const ADB_TRANSFER_TIMEOUT: Duration = Duration::from_secs(25 * 60);
/// The longest command line the driver sends to the phone's shell, in bytes, measured as it is
/// sent. Quoting for the phone can make a command that passed `DeviceCommand::validate` several
/// times longer (each `'` becomes four characters). On Windows the computer's own command line
/// quotes it again (each `"`, and the backslashes before one, count twice; a word with a space
/// gains two quotes), and that is counted too, so a line within this fits Windows' limit of
/// 32 767 characters with room for `adb`'s path and `-s <serial> shell`. A longer line is refused
/// before `adb` runs.
pub const MAX_DEVICE_LINE_BYTES: usize = 24 * 1024;
/// The most bytes of one output stream kept from a call of the driver's own (a screen dump, a
/// property list); the rest is read and dropped, so a call that prints without end cannot fill
/// this computer's memory.
pub const MAX_READ_BYTES: usize = 8 * 1024 * 1024;
/// The same for a screenshot.
pub const MAX_CAPTURE_BYTES: usize = 64 * 1024 * 1024;
/// The same for an agent's `shell` command: twice what its result keeps
/// (`MAX_OUTPUT_BYTES`), so an output cut here is still longer than that once Windows' CR LF
/// are undone, and the result says it was cut.
pub const SHELL_CAPTURE_BYTES: usize = 2 * MAX_OUTPUT_BYTES + 2;

/// What one call may take: time, and bytes of each output stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Limits {
    pub(crate) time: Duration,
    pub(crate) output: usize,
}

impl Limits {
    /// A call of the driver's own: reading the screen, a tap, a property.
    pub(crate) const ORDINARY: Limits = Limits {
        time: ADB_TIMEOUT,
        output: MAX_READ_BYTES,
    };
    /// An agent's `shell` command.
    pub(crate) const AGENT_SHELL: Limits = Limits {
        time: ADB_SHELL_TIMEOUT,
        output: SHELL_CAPTURE_BYTES,
    };
    /// `adb push` and `adb pull`.
    pub(crate) const TRANSFER: Limits = Limits {
        time: ADB_TRANSFER_TIMEOUT,
        output: MAX_READ_BYTES,
    };
    /// `screencap`.
    pub(crate) const SCREENSHOT: Limits = Limits {
        time: ADB_TIMEOUT,
        output: MAX_CAPTURE_BYTES,
    };
}

/// What one `adb` call left: its exit code (`None` when it ended without one) and its output.
#[derive(Clone, PartialEq, Eq)]
pub struct AdbOutput {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl AdbOutput {
    /// An output that ended with `code`.
    pub fn new(code: i32, stdout: impl Into<Vec<u8>>, stderr: impl Into<Vec<u8>>) -> AdbOutput {
        AdbOutput {
            code: Some(code),
            stdout: stdout.into(),
            stderr: stderr.into(),
        }
    }

    /// Whether the call exited with 0.
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }

    /// The standard output as text (bytes that are not UTF-8 become U+FFFD).
    pub fn stdout_text(&self) -> Cow<'_, str> {
        String::from_utf8_lossy(&self.stdout)
    }

    /// Both streams as text, the standard output first.
    pub fn text(&self) -> String {
        let mut text = String::from_utf8_lossy(&self.stdout).into_owned();
        text.push('\n');
        text.push_str(&String::from_utf8_lossy(&self.stderr));
        text
    }
}

/// The exit code and the sizes only: the output is the phone's (screen text, a command's
/// output), and a `{:?}` must not carry it into a log.
impl fmt::Debug for AdbOutput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AdbOutput")
            .field("code", &self.code)
            .field("stdout_bytes", &self.stdout.len())
            .field("stderr_bytes", &self.stderr.len())
            .finish()
    }
}

/// `adb` could not be run at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdbError {
    /// There is no program at the configured path (`adb` in the configuration).
    NotFound,
    /// Starting the program or reading what it printed failed.
    Io(std::io::ErrorKind),
}

impl fmt::Display for AdbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AdbError::NotFound => f.write_str(
                "adb was not found; set `adb` in the bridge's configuration to its path",
            ),
            AdbError::Io(kind) => write!(f, "adb could not be run ({kind})"),
        }
    }
}

impl std::error::Error for AdbError {}

/// Runs `adb`. The Android driver's only way to its phone, so the tests put a scripted phone
/// behind it.
///
/// A call's future may be dropped at any `.await` (the driver bounds every call, and the loop
/// cuts a command off by dropping it): an implementation leaves no `adb` running when it is.
#[async_trait]
pub trait AdbRunner: Send + Sync {
    /// `adb -s <serial> <args…>`, each argument handed to `adb` as it is, keeping at most
    /// `max_output` bytes of each output stream.
    async fn run(
        &self,
        serial: &str,
        args: &[&str],
        max_output: usize,
    ) -> Result<AdbOutput, AdbError>;

    /// `adb devices -l`: the one call that names no phone.
    async fn devices(&self) -> Result<AdbOutput, AdbError>;
}

/// The real `adb`, at the configured path.
///
/// Each call is a child process started with `kill_on_drop(true)` and no input, so a dropped
/// call leaves no `adb` behind. Unbounded in time itself: the driver bounds each call.
#[derive(Clone, Debug)]
pub struct SystemAdb {
    program: PathBuf,
}

impl SystemAdb {
    /// `adb` at `program` (a path, or a name found on `PATH`).
    pub fn new(program: impl Into<PathBuf>) -> SystemAdb {
        SystemAdb {
            program: program.into(),
        }
    }

    async fn exec(&self, args: &[&str], max_output: usize) -> Result<AdbOutput, AdbError> {
        let mut child = Command::new(&self.program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => AdbError::NotFound,
                kind => AdbError::Io(kind),
            })?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let (stdout, stderr, status) = tokio::try_join!(
            read_capped(stdout, max_output),
            read_capped(stderr, max_output),
            child.wait(),
        )
        .map_err(|error| AdbError::Io(error.kind()))?;
        Ok(AdbOutput {
            code: status.code(),
            stdout,
            stderr,
        })
    }
}

#[async_trait]
impl AdbRunner for SystemAdb {
    async fn run(
        &self,
        serial: &str,
        args: &[&str],
        max_output: usize,
    ) -> Result<AdbOutput, AdbError> {
        let mut argv = Vec::with_capacity(args.len() + 2);
        argv.extend(["-s", serial]);
        argv.extend_from_slice(args);
        let mut out = self.exec(&argv, max_output).await?;
        // `adb shell` on Windows writes what the phone printed in text mode, each LF as CR LF
        // (seen with adb 37.0.1 on Windows 11; `exec-out` is not changed): undone, so the
        // phone's bytes come back as they were.
        if cfg!(windows) && args.first() == Some(&"shell") {
            out.stdout = without_added_crs(out.stdout);
            out.stderr = without_added_crs(out.stderr);
        }
        Ok(out)
    }

    async fn devices(&self) -> Result<AdbOutput, AdbError> {
        self.exec(&["devices", "-l"], MAX_READ_BYTES).await
    }
}

/// Reads `stream` to its end, keeping its first `cap` bytes.
async fn read_capped(
    stream: Option<impl AsyncRead + Unpin>,
    cap: usize,
) -> std::io::Result<Vec<u8>> {
    let Some(mut stream) = stream else {
        return Ok(Vec::new());
    };
    let mut kept = Vec::new();
    let mut chunk = vec![0; 64 * 1024];
    loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Ok(kept);
        }
        let room = cap.saturating_sub(kept.len());
        kept.extend_from_slice(&chunk[..read.min(room)]);
    }
}

/// `bytes` with the CR dropped that text mode put before each LF. Text mode adds one CR to every
/// LF, so this is exact: a CR LF the phone printed (written as CR CR LF) is CR LF again. An
/// output with a LF that has no CR before it was not written so, and is left as it is.
fn without_added_crs(bytes: Vec<u8>) -> Vec<u8> {
    let translated = bytes
        .iter()
        .enumerate()
        .all(|(i, &byte)| byte != b'\n' || (i > 0 && bytes[i - 1] == b'\r'));
    if !translated {
        return bytes;
    }
    let mut out = Vec::with_capacity(bytes.len());
    for (i, &byte) in bytes.iter().enumerate() {
        if byte == b'\r' && bytes.get(i + 1) == Some(&b'\n') {
            continue;
        }
        out.push(byte);
    }
    out
}

/// A command line for the phone's shell, built word by word. A word the driver wrote is a
/// `&'static str`, so it cannot carry a command's value; a value goes through
/// [`DeviceLine::arg`], which quotes it.
#[derive(Clone, Debug)]
pub(crate) struct DeviceLine {
    words: Vec<String>,
}

impl DeviceLine {
    /// A line that runs `program`.
    pub(crate) fn new(program: &'static str) -> DeviceLine {
        DeviceLine {
            words: vec![program.to_owned()],
        }
    }

    /// An agent's argument list, every argument quoted.
    pub(crate) fn from_argv(argv: &[String]) -> DeviceLine {
        DeviceLine {
            words: argv.iter().map(|arg| quote(arg).into_owned()).collect(),
        }
    }

    /// A word of the driver's own, sent as it is.
    pub(crate) fn word(mut self, word: &'static str) -> DeviceLine {
        self.words.push(word.to_owned());
        self
    }

    pub(crate) fn number(mut self, number: u32) -> DeviceLine {
        self.words.push(number.to_string());
        self
    }

    /// A value, quoted for the phone's shell.
    pub(crate) fn arg(mut self, value: &str) -> DeviceLine {
        self.words.push(quote(value).into_owned());
        self
    }

    /// The program the line runs.
    pub(crate) fn program(&self) -> &str {
        self.words.first().map_or("", String::as_str)
    }

    pub(crate) fn words(&self) -> impl Iterator<Item = &str> {
        self.words.iter().map(String::as_str)
    }

    /// The length of the line as it is sent: the words and a space between each two, with the
    /// quoting Windows' command line adds to each word on Windows ([`windows_quoting`]).
    pub(crate) fn sent_bytes(&self) -> usize {
        let word = |w: &String| w.len() + if cfg!(windows) { windows_quoting(w) } else { 0 };
        self.words.iter().map(word).sum::<usize>() + self.words.len().saturating_sub(1)
    }
}

/// The bytes Windows' command line adds to `word` when a program is started with it (Rust's
/// standard library quotes each argument for the Microsoft C runtime's rules): a `\` before
/// each `"` and one more for each backslash just before it; and, for a word with a space or a
/// tab (or none at all), the two quotes around it and the backslashes at its end once more.
pub(crate) fn windows_quoting(word: &str) -> usize {
    let quoted = word.is_empty() || word.contains([' ', '\t']);
    let mut added = if quoted { 2 } else { 0 };
    let mut backslashes = 0;
    for byte in word.bytes() {
        match byte {
            b'\\' => backslashes += 1,
            b'"' => {
                added += backslashes + 1;
                backslashes = 0;
            }
            _ => backslashes = 0,
        }
    }
    if quoted {
        added += backslashes;
    }
    added
}

/// `value` as one word for the phone's shell (a POSIX shell: `sh` on Android): as it is when
/// every character is plainly safe, else in single quotes, inside which only `'` itself needs
/// care (written `'\''`). An empty value is `''`.
pub(crate) fn quote(value: &str) -> Cow<'_, str> {
    let plain = |c: char| c.is_ascii_alphanumeric() || "_@%+:,./-".contains(c);
    if !value.is_empty() && value.chars().all(plain) {
        return Cow::Borrowed(value);
    }
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('\'');
    for c in value.chars() {
        if c == '\'' {
            quoted.push_str("'\\''");
        } else {
            quoted.push(c);
        }
    }
    quoted.push('\'');
    Cow::Owned(quoted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_leaves_plain_words_and_quotes_the_rest() {
        assert_eq!(quote("com.whatsapp"), "com.whatsapp");
        assert_eq!(quote("/sdcard/a-b_c.txt"), "/sdcard/a-b_c.txt");
        assert_eq!(quote("50%"), "50%");
        assert_eq!(quote(""), "''");
        assert_eq!(quote("a b"), "'a b'");
        assert_eq!(quote("it's"), r"'it'\''s'");
        assert_eq!(quote("$(reboot)"), "'$(reboot)'");
        // A first word with `=` would be an assignment, not a program; `~` would expand.
        assert_eq!(quote("A=1"), "'A=1'");
        assert_eq!(quote("~"), "'~'");
        assert_eq!(quote("çay"), "'çay'");
        assert_eq!(quote("a\nb"), "'a\nb'");
    }

    /// Every value comes back from a POSIX `sh` as it was sent.
    #[cfg(unix)]
    #[test]
    fn quoted_values_read_back_through_sh() {
        let values = [
            "plain",
            "",
            "a b",
            "it's",
            "''",
            "$(echo no) `echo no` $HOME ${X:-y}",
            r#"a"b\c\"#,
            "tab\there",
            "line\nbreak",
            "çay 👋",
            "-n",
            "*",
            "a=b",
            "~",
            "%s",
            "!x",
            "#c",
            "a;b|c&d>e<f",
        ];
        let mut line = String::from(r"printf '%s\0'");
        for value in values {
            line.push(' ');
            line.push_str(&quote(value));
        }
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(line)
            .output()
            .unwrap();
        assert!(out.status.success(), "{out:?}");
        let read: Vec<&[u8]> = out.stdout.split(|byte| *byte == 0).collect();
        // Each value ends with a NUL, so the last piece is empty.
        assert_eq!(read.len(), values.len() + 1);
        for (read, value) in read.iter().zip(values) {
            assert_eq!(*read, value.as_bytes());
        }
    }

    #[test]
    fn a_line_counts_its_words_and_spaces() {
        let line = DeviceLine::new("input").word("tap").number(10).arg("ab");
        assert_eq!(
            line.words().collect::<Vec<_>>(),
            ["input", "tap", "10", "ab"]
        );
        assert_eq!(line.sent_bytes(), "input tap 10 ab".len());
        assert_eq!(line.program(), "input");
        let argv = DeviceLine::from_argv(&["ls".to_owned(), String::new()]);
        assert_eq!(argv.words().collect::<Vec<_>>(), ["ls", "''"]);
    }

    #[test]
    fn windows_quoting_is_counted_on_windows() {
        assert_eq!(windows_quoting("plain"), 0);
        assert_eq!(windows_quoting("a\"b"), 1);
        assert_eq!(windows_quoting(r#"a\\"b"#), 3);
        assert_eq!(windows_quoting("a b"), 2);
        assert_eq!(windows_quoting(r"a b\\"), 4);
        assert_eq!(windows_quoting(""), 2);
        // 5 000 `"` in one word: quoted for the phone it stays near 5 000 bytes, and Windows
        // writes each as `\"`.
        let line = DeviceLine::from_argv(&["\"".repeat(5000)]);
        let expected = if cfg!(windows) { 10_002 } else { 5002 };
        assert_eq!(line.sent_bytes(), expected);
    }

    #[test]
    fn text_mode_line_ends_are_undone_exactly() {
        assert_eq!(without_added_crs(b"33\r\n".to_vec()), b"33\n");
        // The phone printed `a\r\nb\n`; Windows' adb wrote `a\r\r\nb\r\n`.
        assert_eq!(without_added_crs(b"a\r\r\nb\r\n".to_vec()), b"a\r\nb\n");
        assert_eq!(without_added_crs(b"a\rb\r".to_vec()), b"a\rb\r");
        // A LF without its CR: not written in text mode, so kept.
        assert_eq!(without_added_crs(b"a\r\nb\n".to_vec()), b"a\r\nb\n");
        assert_eq!(without_added_crs(b"\n".to_vec()), b"\n");
    }

    #[test]
    fn output_debug_shows_no_output() {
        let out = AdbOutput::new(0, "typed SECRET-TEXT", "");
        let shown = format!("{out:?}");
        assert!(!shown.contains("SECRET"), "{shown}");
        assert!(shown.contains("stdout_bytes: 17"), "{shown}");
    }

    #[tokio::test]
    async fn a_missing_adb_is_not_found() {
        let adb = SystemAdb::new(std::env::temp_dir().join("no-such-dir-jdb").join("adb"));
        assert_eq!(adb.devices().await, Err(AdbError::NotFound));
        assert_eq!(
            adb.run("serial", &["shell", "true"], MAX_READ_BYTES).await,
            Err(AdbError::NotFound)
        );
    }

    #[tokio::test]
    async fn output_is_kept_up_to_its_cap() {
        let bytes = vec![7u8; 200_000];
        let kept = read_capped(Some(&bytes[..]), 1000).await.unwrap();
        assert_eq!(kept, vec![7u8; 1000]);
        let all = read_capped(Some(&bytes[..]), MAX_READ_BYTES).await.unwrap();
        assert_eq!(all.len(), bytes.len());
    }
}
