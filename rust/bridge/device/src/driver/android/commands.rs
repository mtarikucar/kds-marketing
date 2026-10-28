//! Each command kind as `adb` calls (spec §4.1).

use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use jt_device_protocol::{
    CommandResult, DeviceCommand, DeviceKey, ElementTarget, FailReason, MAX_SCREEN_PX, Observation,
};
use tokio::time::Instant;
use uuid::Uuid;

use super::adb::{DeviceLine, Limits, MAX_CAPTURE_BYTES, MAX_READ_BYTES};
use super::observe::{self, Dump};
use super::{
    ADB_KEYBOARD_IME, AndroidAdbDriver, DUMP_PATH, IDLE_RETRY_PAUSE, IME_BIND_POLL,
    IME_BIND_TIMEOUT, LABEL_CHARS, MAX_LABELS, MAX_PULL_BYTES, check, clean, first_line,
};
use crate::driver::{ContentType, DriverError, FileTransfer};

/// The first bytes of every PNG file.
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

impl AndroidAdbDriver {
    pub(super) async fn carry_out(
        &self,
        cmd: &DeviceCommand,
        files: &dyn FileTransfer,
    ) -> Result<CommandResult, DriverError> {
        let input = || DeviceLine::new("input");
        match cmd {
            DeviceCommand::Observe { screenshot } => self.observe(*screenshot, files).await,
            DeviceCommand::Tap { x, y } => {
                self.done(input().word("tap").number(*x).number(*y)).await
            }
            DeviceCommand::TapOn { target, exact } => self.tap_on(target, *exact).await,
            // A swipe that does not move is a press held for its duration.
            DeviceCommand::LongPress { x, y, ms } => {
                let line = input().word("swipe").number(*x).number(*y);
                self.done(line.number(*x).number(*y).number(*ms)).await
            }
            DeviceCommand::Swipe { x1, y1, x2, y2, ms } => {
                let line = input().word("swipe").number(*x1).number(*y1);
                self.done(line.number(*x2).number(*y2).number(*ms)).await
            }
            DeviceCommand::Text { value } if value.is_ascii() => self.type_ascii(value).await,
            DeviceCommand::Text { value } => self.type_unicode(value).await,
            DeviceCommand::Key { key } => {
                self.done(input().word("keyevent").number(keycode(*key)))
                    .await
            }
            DeviceCommand::OpenUrl { url } => {
                let line = DeviceLine::new("am")
                    .word("start")
                    .word("-a")
                    .word("android.intent.action.VIEW")
                    .word("-d")
                    .arg(url);
                self.done(line).await
            }
            DeviceCommand::LaunchApp { app_id } => {
                let line = DeviceLine::new("monkey")
                    .word("-p")
                    .arg(app_id)
                    .word("-c")
                    .word("android.intent.category.LAUNCHER")
                    .word("1");
                self.done(line).await
            }
            DeviceCommand::Shell { argv } => {
                let out = self
                    .shell(&DeviceLine::from_argv(argv), Limits::AGENT_SHELL)
                    .await?;
                Ok(CommandResult::shell(
                    out.code.unwrap_or(-1),
                    &out.stdout,
                    &out.stderr,
                ))
            }
            DeviceCommand::PushFile { dest, .. } => self.push(dest, files).await,
            DeviceCommand::PullFile { path } => self.pull(path, files).await,
            DeviceCommand::Screenshot {} => Ok(CommandResult::File {
                file_id: self.capture(files).await?,
            }),
        }
    }

    /// Runs `line`, which leaves nothing to report.
    async fn done(&self, line: DeviceLine) -> Result<CommandResult, DriverError> {
        self.act(&line).await?;
        Ok(CommandResult::Done {})
    }

    async fn observe(
        &self,
        screenshot: bool,
        files: &dyn FileTransfer,
    ) -> Result<CommandResult, DriverError> {
        let size = DeviceLine::new("wm").word("size");
        let focus = DeviceLine::new("dumpsys")
            .word("window")
            .word("|")
            .word("grep")
            .word("mCurrentFocus");
        let (dump, size, focus) = tokio::join!(
            self.read_screen(),
            self.shell(&size, Limits::ORDINARY),
            self.shell(&focus, Limits::ORDINARY),
        );
        let (dump, cut) = dump?;
        let Some(natural) = observe::screen_size(&size?.stdout_text()) else {
            return Err(DriverError::new(
                FailReason::AdbError,
                "wm size gave no screen size",
            ));
        };
        let screen = observe::screen(natural, dump.rotation);
        let sides = 1..=MAX_SCREEN_PX;
        if !sides.contains(&screen.w) || !sides.contains(&screen.h) {
            return Err(DriverError::new(
                FailReason::AdbError,
                format!(
                    "wm size gave a screen of {}x{}, outside 1 to {MAX_SCREEN_PX} pixels a side",
                    screen.w, screen.h
                ),
            ));
        }
        let mut seen = Observation {
            screen,
            foreground_app: focus
                .ok()
                .and_then(|out| observe::foreground_app(&out.stdout_text())),
            elements: dump.elements,
            // A dump larger than the bridge reads was cut, and its last elements are missing.
            truncated: cut,
            screenshot_file_id: None,
        };
        seen.cap_elements();
        if screenshot {
            seen.screenshot_file_id = Some(self.capture(files).await?);
        }
        Ok(CommandResult::Observation(seen))
    }

    /// The screen, from a fresh `uiautomator dump`, and whether the dump was cut to
    /// [`MAX_READ_BYTES`]. A moving screen is tried again once. The dump's file is removed once
    /// it is read.
    async fn read_screen(&self) -> Result<(Dump, bool), DriverError> {
        // The file an earlier dump left (one cut off before it was removed) must not pass for
        // this one's.
        let dump = DeviceLine::new("rm")
            .word("-f")
            .word(DUMP_PATH)
            .word(";")
            .word("uiautomator")
            .word("dump")
            .word(DUMP_PATH);
        let mut retried = false;
        loop {
            let out = self.shell(&dump, Limits::ORDINARY).await?;
            if out.text().contains("could not get idle state") {
                if retried {
                    return Err(DriverError::new(
                        FailReason::ScreenBusy,
                        "the screen kept moving (uiautomator: could not get idle state), also \
                         when tried again; try again once it is still",
                    ));
                }
                retried = true;
                tokio::time::sleep(IDLE_RETRY_PAUSE).await;
                continue;
            }
            let file = self
                .adb(&["exec-out", "cat", DUMP_PATH], Limits::ORDINARY)
                .await?;
            // Removed whatever came of the reading; one left behind goes before the next dump.
            let remove = DeviceLine::new("rm").word("-f").word(DUMP_PATH);
            let _ = self.shell(&remove, Limits::ORDINARY).await;
            let xml = String::from_utf8_lossy(&file.stdout);
            if !xml.contains("<node") {
                return Err(DriverError::new(
                    FailReason::ScreenBusy,
                    "uiautomator wrote no screen; try again",
                ));
            }
            let cut = file.stdout.len() >= MAX_READ_BYTES;
            return Ok((observe::parse_dump(&xml), cut));
        }
    }

    async fn tap_on(
        &self,
        target: &ElementTarget,
        exact: bool,
    ) -> Result<CommandResult, DriverError> {
        let (dump, _) = self.read_screen().await?;
        let Some(hit) = observe::find(&dump.nodes, target, exact) else {
            return Err(DriverError::new(
                FailReason::ElementNotFound,
                not_found(target, exact, &dump),
            ));
        };
        let [x, y] = hit.tap_point;
        self.done(DeviceLine::new("input").word("tap").number(x).number(y))
            .await
    }

    /// `input text`, which reads `%s` as a space: spaces are written so, and a `%s` that is in
    /// the text is typed in two calls. Every line is checked before the first is typed.
    async fn type_ascii(&self, value: &str) -> Result<CommandResult, DriverError> {
        let lines: Vec<DeviceLine> = pieces(value)
            .into_iter()
            .map(|piece| {
                DeviceLine::new("input")
                    .word("text")
                    .arg(&piece.replace(' ', "%s"))
            })
            .collect();
        for line in &lines {
            check(line)?;
        }
        for line in &lines {
            self.act(line).await?;
        }
        Ok(CommandResult::Done {})
    }

    /// Through ADBKeyBoard: select it, wait until it holds the focused field, send the text,
    /// put the phone's input method back.
    async fn type_unicode(&self, value: &str) -> Result<CommandResult, DriverError> {
        let enabled = self.enabled_imes().await?;
        if !enabled.iter().any(|ime| ime == ADB_KEYBOARD_IME) {
            return Err(self.unicode_refusal().await);
        }
        let broadcast = DeviceLine::new("am")
            .word("broadcast")
            .word("-a")
            .word("ADB_INPUT_B64")
            .word("--es")
            .word("msg")
            .arg(&STANDARD.encode(value.as_bytes()));
        check(&broadcast)?;
        let current = self.current_ime().await?;
        if current.as_deref() != Some(ADB_KEYBOARD_IME) {
            let back = match current {
                Some(current) => Some(current),
                None => self.ime_to_go_back_to(&enabled).await,
            };
            // Recorded before it is set: a command cut off from here on is undone by `recover`.
            self.set_record(back);
            let select = DeviceLine::new("ime").word("set").word(ADB_KEYBOARD_IME);
            if let Err(error) = self.act(&select).await {
                self.put_ime_back().await;
                return Err(error);
            }
        }
        let typed = match self.wait_for_binding().await {
            Ok(()) => self.act(&broadcast).await.map(drop),
            Err(error) => Err(error),
        };
        self.put_ime_back().await;
        typed.map(|()| CommandResult::Done {})
    }

    async fn unicode_refusal(&self) -> DriverError {
        let detail = if self.adbkeyboard_installed().await.unwrap_or(false) {
            "the text has characters outside ASCII; ADBKeyBoard is installed but not enabled as \
             an input method in the phone's keyboard settings"
        } else {
            "the text has characters outside ASCII, which input text would type wrong; install \
             ADBKeyBoard (com.android.adbkeyboard) and enable it as an input method"
        };
        DriverError::new(FailReason::UnicodeUnsupported, detail)
    }

    /// Waits until `dumpsys input_method` shows ADBKeyBoard holding the focused field
    /// ([`bound_to_a_field`]), at most [`IME_BIND_TIMEOUT`].
    async fn wait_for_binding(&self) -> Result<(), DriverError> {
        let line = DeviceLine::new("dumpsys").word("input_method");
        let deadline = Instant::now() + IME_BIND_TIMEOUT;
        loop {
            let out = self.shell(&line, Limits::ORDINARY).await?;
            if bound_to_a_field(&out.stdout_text()) {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(DriverError::new(
                    FailReason::AdbError,
                    format!(
                        "ADBKeyBoard did not take the focused field within {} ms; tap a text \
                         field first",
                        IME_BIND_TIMEOUT.as_millis()
                    ),
                ));
            }
            tokio::time::sleep(IME_BIND_POLL).await;
        }
    }

    async fn push(
        &self,
        dest: &str,
        files: &dyn FileTransfer,
    ) -> Result<CommandResult, DriverError> {
        not_an_option("dest", dest)?;
        let local = TempFile::new("push");
        files.download(local.path()).await?;
        // A path goes to adb's file transfer, not to a shell: as it is.
        let out = self
            .adb(&["push", local.arg()?, dest], Limits::TRANSFER)
            .await?;
        transferred("push", &out)?;
        Ok(CommandResult::Done {})
    }

    /// `adb pull` of one regular file of at most [`MAX_PULL_BYTES`], checked on the phone first
    /// (`stat`, which follows a link as the copy does), so a folder or a huge file never fills
    /// this computer's temporary folder.
    async fn pull(
        &self,
        path: &str,
        files: &dyn FileTransfer,
    ) -> Result<CommandResult, DriverError> {
        not_an_option("path", path)?;
        let stat = DeviceLine::new("stat")
            .word("-L")
            .word("-c")
            .arg("%F %s")
            .arg(path);
        let out = self.shell(&stat, Limits::ORDINARY).await?;
        if !out.success() {
            let said = String::from_utf8_lossy(&out.stderr);
            return Err(DriverError::new(
                FailReason::AdbError,
                format!("pull_file: {}", clean(first_line(&said))),
            ));
        }
        let said = out.stdout_text();
        let read = first_line(&said)
            .rsplit_once(' ')
            .and_then(|(kind, size)| Some((kind, size.parse::<u64>().ok()?)));
        let Some((kind, size)) = read else {
            return Err(DriverError::new(
                FailReason::AdbError,
                format!("pull_file: stat gave {:?}", clean(first_line(&said))),
            ));
        };
        if kind != "regular file" && kind != "regular empty file" {
            return Err(DriverError::new(
                FailReason::BridgeError,
                format!(
                    "pull_file copies one file, and the path is a {}",
                    clean(kind)
                ),
            ));
        }
        if size > MAX_PULL_BYTES {
            return Err(DriverError::new(
                FailReason::BridgeError,
                format!(
                    "the file is {size} bytes, over the {MAX_PULL_BYTES} bytes pull_file copies"
                ),
            ));
        }
        let local = TempFile::new("pull");
        let out = self
            .adb(&["pull", path, local.arg()?], Limits::TRANSFER)
            .await?;
        transferred("pull", &out)?;
        let is_file = tokio::fs::metadata(local.path())
            .await
            .is_ok_and(|meta| meta.is_file());
        if !is_file {
            return Err(DriverError::new(
                FailReason::BridgeError,
                "pull_file copies one file, and the path is not one",
            ));
        }
        let file_id = files
            .upload_file(local.path(), ContentType::OctetStream)
            .await?;
        Ok(CommandResult::File { file_id })
    }

    /// A screenshot, uploaded as a Jeeta file. `exec-out` hands over what the phone's program
    /// wrote to either of its streams, so the image is taken from where its signature begins.
    async fn capture(&self, files: &dyn FileTransfer) -> Result<Uuid, DriverError> {
        let out = self
            .adb(&["exec-out", "screencap", "-p"], Limits::SCREENSHOT)
            .await?;
        if out.stdout.len() >= MAX_CAPTURE_BYTES {
            return Err(DriverError::new(
                FailReason::AdbError,
                format!(
                    "the screenshot is larger than the {MAX_CAPTURE_BYTES} bytes the bridge reads"
                ),
            ));
        }
        let mut bytes = out.stdout;
        let Some(at) = bytes
            .windows(PNG_SIGNATURE.len())
            .position(|window| window == PNG_SIGNATURE)
        else {
            return Err(DriverError::new(
                FailReason::AdbError,
                "screencap gave no PNG image",
            ));
        };
        let png = bytes.split_off(at);
        files.upload(png, ContentType::Png).await
    }
}

/// The detail of a `tap_on` that found nothing: the target and up to [`MAX_LABELS`] of the
/// screen's labels, each at most [`LABEL_CHARS`] characters, so that all of them fit a
/// failure's detail.
fn not_found(target: &ElementTarget, exact: bool, dump: &Dump) -> String {
    let (field, needle) = match target {
        ElementTarget::Text(v) => ("text", v),
        ElementTarget::Id(v) => ("id", v),
        ElementTarget::Desc(v) => ("desc", v),
    };
    let needle = observe::short(needle, 16);
    let labels = observe::labels(&dump.elements, MAX_LABELS, LABEL_CHARS);
    let shown = if labels.is_empty() {
        "nothing".to_owned()
    } else {
        labels.join(", ")
    };
    let how = if exact { "exactly " } else { "" };
    format!("not found: {field} {how}{needle:?}; on screen: {shown}")
}

/// The Android key code of `key` (`KeyEvent.KEYCODE_*`).
fn keycode(key: DeviceKey) -> u32 {
    match key {
        DeviceKey::Back => 4,
        DeviceKey::Home => 3,
        DeviceKey::Enter => 66,
        DeviceKey::AppSwitch => 187,
        DeviceKey::Delete => 67,
        DeviceKey::VolumeUp => 24,
        DeviceKey::VolumeDown => 25,
        DeviceKey::Power => 26,
    }
}

/// `value` cut so that no piece holds `%s`: each `%s` ends a piece after its `%`.
fn pieces(value: &str) -> Vec<&str> {
    let mut pieces = Vec::new();
    let mut start = 0;
    for (at, _) in value.match_indices("%s") {
        pieces.push(&value[start..=at]);
        start = at + 1;
    }
    pieces.push(&value[start..]);
    pieces
}

/// Whether `dumpsys input_method` shows ADBKeyBoard holding the focused field, on both sides:
/// the input method manager has it selected (`mCurMethodId`) and bound (its line
/// `mCurId=… mBoundToMethod=true`), and the focused app's client is bound to it too (its line
/// `mActive=… mBindSequence=… mCurId=…`) with a field's connection served
/// (`mServedInputConnection` other than `null`). An app serves a connection again as soon as
/// its input restarts, while still bound to the input method before, so the connection and the
/// selection alone prove nothing.
fn bound_to_a_field(dumpsys: &str) -> bool {
    let named = |line: &str, field: &str| {
        line.split_whitespace()
            .find_map(|word| word.strip_prefix(field)?.strip_prefix('='))
            == Some(ADB_KEYBOARD_IME)
    };
    let mut selected = false;
    let mut bound = false;
    let mut client = false;
    let mut served = false;
    for line in dumpsys.lines().map(str::trim) {
        selected |= line.starts_with("mCurMethodId=") && named(line, "mCurMethodId");
        bound |= line.starts_with("mCurId=")
            && named(line, "mCurId")
            && line
                .split_whitespace()
                .any(|word| word == "mBoundToMethod=true");
        client |= line.contains("mBindSequence=") && named(line, "mCurId");
        if let Some(connection) = line.strip_prefix("mServedInputConnection=") {
            let connection = connection.trim();
            served |= !connection.is_empty() && !connection.starts_with("null");
        }
    }
    selected && bound && client && served
}

/// A device path that begins with `-` would be read by `adb` as an option.
fn not_an_option(field: &'static str, path: &str) -> Result<(), DriverError> {
    if path.starts_with('-') {
        return Err(DriverError::new(
            FailReason::BridgeError,
            format!("{field} begins with '-', which adb would read as an option"),
        ));
    }
    Ok(())
}

/// An `adb push` or `adb pull` that did not exit with 0, with the line `adb` gave.
fn transferred(op: &str, out: &super::AdbOutput) -> Result<(), DriverError> {
    if out.success() {
        return Ok(());
    }
    let said = String::from_utf8_lossy(&out.stderr);
    let line = match first_line(&said) {
        "" => first_line(&out.stdout_text()).to_owned(),
        line => line.to_owned(),
    };
    Err(DriverError::new(
        FailReason::AdbError,
        format!("adb {op} failed: {}", clean(&line)),
    ))
}

/// A path in this computer's temporary folder for one transfer, removed (a file, or a folder an
/// `adb pull` made) when dropped: when the command ends, fails or is cut off.
struct TempFile(PathBuf);

impl TempFile {
    fn new(purpose: &str) -> TempFile {
        TempFile(
            std::env::temp_dir().join(format!("jeeta-device-bridge-{purpose}-{}", Uuid::now_v7())),
        )
    }

    fn path(&self) -> &Path {
        &self.0
    }

    /// The path as an argument for `adb`.
    fn arg(&self) -> Result<&str, DriverError> {
        self.0.to_str().ok_or_else(|| {
            DriverError::new(
                FailReason::BridgeError,
                "this computer's temporary folder has a path adb cannot be given",
            )
        })
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        if self.0.is_dir() {
            let _ = std::fs::remove_dir_all(&self.0);
        } else {
            let _ = std::fs::remove_file(&self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use jt_device_protocol::{Element, MAX_DETAIL_CHARS};

    use super::*;

    #[test]
    fn a_percent_s_in_the_text_ends_a_piece() {
        assert_eq!(pieces("hello"), ["hello"]);
        assert_eq!(pieces("50%sale"), ["50%", "sale"]);
        assert_eq!(pieces("%s%s"), ["%", "s%", "s"]);
        assert_eq!(pieces("%%s"), ["%%", "s"]);
        assert!(
            pieces("a %s b %")
                .iter()
                .all(|p| !p.contains("%s") && !p.is_empty())
        );
    }

    #[test]
    fn bound_only_when_both_sides_hold_adbkeyboard() {
        let fixture = |name: &str| {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests")
                .join("fixtures")
                .join(name);
            std::fs::read_to_string(path).unwrap()
        };
        assert!(bound_to_a_field(&fixture("input_method_bound.txt")));
        assert!(!bound_to_a_field(&fixture("input_method_other_ime.txt")));
        assert!(!bound_to_a_field(&fixture(
            "input_method_adbime_unbound.txt"
        )));
        // The app served a connection again, still bound to the keyboard before.
        assert!(!bound_to_a_field(&fixture("input_method_in_between.txt")));
        // The same with the client bound to nothing yet.
        let in_between = fixture("input_method_in_between.txt").replace(
            "mBindSequence=354 mCurId=com.preff.kb.xm/com.preff.kb.LatinIME",
            "mBindSequence=-1 mCurId=null",
        );
        assert!(!bound_to_a_field(&in_between));
        // The manager selected it, but has not bound to it yet.
        let selected = fixture("input_method_bound.txt")
            .replace("mBoundToMethod=true", "mBoundToMethod=false");
        assert!(!bound_to_a_field(&selected));
        // Windows' line ends are read the same.
        assert!(bound_to_a_field(
            &fixture("input_method_bound.txt").replace('\n', "\r\n")
        ));
    }

    #[test]
    fn twenty_labels_fit_a_failure_detail() {
        let element = |n: usize| Element {
            text: Some(format!("L{n:02} is a rather long label")),
            id: None,
            desc: None,
            class: None,
            bounds: [0, 0, 10, 10],
            tap_point: [5, 5],
            clickable: true,
            editable: false,
            focused: false,
        };
        let elements: Vec<Element> = (1..=30).map(element).collect();
        let dump = Dump {
            rotation: 0,
            nodes: elements.clone(),
            elements,
        };
        let target = ElementTarget::Desc("x".repeat(4000));
        let detail = not_found(&target, true, &dump);
        assert!(
            detail.chars().count() <= MAX_DETAIL_CHARS,
            "{} characters: {detail}",
            detail.chars().count()
        );
        assert_eq!(detail.matches(" is a ").count(), MAX_LABELS, "{detail}");
    }

    #[test]
    fn a_temporary_file_is_removed_when_dropped() {
        let file = TempFile::new("test");
        std::fs::write(file.path(), b"x").unwrap();
        let path = file.path().to_owned();
        drop(file);
        assert!(!path.exists());
        let folder = TempFile::new("test");
        std::fs::create_dir(folder.path()).unwrap();
        std::fs::write(folder.path().join("inner"), b"x").unwrap();
        let path = folder.path().to_owned();
        drop(folder);
        assert!(!path.exists());
    }
}
