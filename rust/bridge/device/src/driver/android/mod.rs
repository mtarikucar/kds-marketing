//! Android phones over `adb` (spec §4.1): [`AndroidRegistry`] lists the phones attached to this
//! computer, and an [`AndroidAdbDriver`] reports one phone and carries out its commands. Every
//! call names the phone (`adb -s <serial>`), and every call is an argument list ([`adb`]).
//!
//! - `adb`: the [`AdbRunner`] seam, the real runner ([`SystemAdb`]) and the phone's command line.
//! - `observe`: the screen, distilled from `uiautomator dump`.
//! - `commands`: each command kind as `adb` calls.
//!
//! # What the phones taught
//!
//! Seen on the owner's Redmi 10C (Android 13, MIUI 14):
//! - A dump is judged by the file it wrote: MIUI's `uiautomator dump` prints a Java stack trace
//!   about a theme file and dumps all the same. Only "could not get idle state", a moving screen
//!   refused with exit code 0, is a refusal: retried once after [`IDLE_RETRY_PAUSE`], then
//!   `screen_busy`, never an empty screen.
//! - Without Xiaomi's "USB debugging (Security settings)", `input` refuses to inject with a
//!   `SecurityException` and exit code 0: that output is an `adb_error` naming the setting.
//! - ADBKeyBoard loses a broadcast sent before it has bound to the focused field, and
//!   `am broadcast` answers `result=0` either way. After `ime set` the driver waits, at most
//!   [`IME_BIND_TIMEOUT`], until `dumpsys input_method` shows it bound.
//! - Auto-rotate turns the screen: its size and rotation are read on every observation.
//!
//! # Cancellation
//!
//! The loop may drop a command's future at any `.await`. Every `adb` call is bounded
//! ([`ADB_TIMEOUT`], [`ADB_SHELL_TIMEOUT`], [`ADB_TRANSFER_TIMEOUT`]) and leaves no `adb` running
//! when dropped; a temporary file is removed by its guard. The input method a Unicode `text`
//! command sets is recorded before it is set, and [`PhoneDriver::recover`] puts the recorded one
//! back when the command was cut off. The first recovery also looks at the phone itself, which a
//! bridge killed mid-command may have left on ADBKeyBoard.
//!
//! # Logging
//!
//! The serial (control characters blanked), the phone's state in `adb devices`, and failure
//! reasons. Never a command's values, what a phone printed or shows, an input method's name or a
//! path.

mod adb;
mod commands;
mod observe;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use jt_device_protocol::{
    CommandResult, DeviceCommand, FailReason, MAX_ID_CHARS, MAX_SCREEN_PX, PhoneReport, Platform,
    Screen, TEXT_UNICODE,
};
use tracing::{info, warn};

pub use adb::{
    ADB_SHELL_TIMEOUT, ADB_TIMEOUT, ADB_TRANSFER_TIMEOUT, AdbError, AdbOutput, AdbRunner,
    MAX_CAPTURE_BYTES, MAX_DEVICE_LINE_BYTES, SystemAdb,
};

use self::adb::DeviceLine;
use crate::driver::{AttachedPhone, DriverError, FileTransfer, PhoneDriver, PhoneRegistry};
use crate::run_loop::loggable;

/// Where `uiautomator dump` writes the screen on the phone.
pub const DUMP_PATH: &str = "/sdcard/jeeta_ui.xml";
/// The pause before a dump refused for a moving screen is tried again, once.
pub const IDLE_RETRY_PAUSE: Duration = Duration::from_millis(700);
/// ADBKeyBoard's package: an input method that types the text it is sent by broadcast, which
/// `input text` cannot do outside ASCII.
pub const ADB_KEYBOARD: &str = "com.android.adbkeyboard";
/// ADBKeyBoard's input method id.
pub const ADB_KEYBOARD_IME: &str = "com.android.adbkeyboard/.AdbIME";
/// How long the driver waits for ADBKeyBoard to bind to the focused field after selecting it.
pub const IME_BIND_TIMEOUT: Duration = Duration::from_secs(5);
/// How often it looks meanwhile.
pub const IME_BIND_POLL: Duration = Duration::from_millis(200);
/// How many of the screen's labels a `tap_on` that found nothing names.
pub const MAX_LABELS: usize = 20;

/// One Android phone, reached through `adb` by its serial.
pub struct AndroidAdbDriver {
    serial: String,
    adb: Arc<dyn AdbRunner>,
    /// The input method to put back: recorded before a Unicode `text` selects ADBKeyBoard, and
    /// cleared once the phone shows it again.
    restore_ime: Mutex<Option<String>>,
    /// Whether a recovery has looked at the phone's input method since the driver was made.
    looked: AtomicBool,
    /// What the last reports read, standing in for a fact a report leaves out.
    facts: Mutex<Facts>,
}

#[derive(Default)]
struct Facts {
    model: Option<String>,
    os_version: Option<String>,
    screen: Option<Screen>,
    unicode: bool,
}

impl AndroidAdbDriver {
    /// The driver of the phone `adb` knows as `serial`.
    pub fn new(serial: impl Into<String>, adb: Arc<dyn AdbRunner>) -> AndroidAdbDriver {
        AndroidAdbDriver {
            serial: serial.into(),
            adb,
            restore_ime: Mutex::new(None),
            looked: AtomicBool::new(false),
            facts: Mutex::default(),
        }
    }

    /// The phone's `adb` serial.
    pub fn serial(&self) -> &str {
        &self.serial
    }

    /// One `adb` call within `bound`. `adb` that cannot run, cannot reach the phone or does not
    /// answer in time is a failure; anything else is the call's output, whatever its exit code.
    async fn adb(&self, args: &[&str], bound: Duration) -> Result<AdbOutput, DriverError> {
        match tokio::time::timeout(bound, self.adb.run(&self.serial, args)).await {
            Err(_) => Err(DriverError::new(
                FailReason::Timeout,
                format!("the phone did not answer within {} s", bound.as_secs()),
            )),
            Ok(Err(error)) => Err(DriverError::new(FailReason::AdbError, error.to_string())),
            Ok(Ok(out)) => match unreachable(&out) {
                Some(error) => Err(error),
                None => Ok(out),
            },
        }
    }

    /// `adb shell <line>` within `bound`; a line too long to send is refused before `adb` runs.
    async fn shell(&self, line: &DeviceLine, bound: Duration) -> Result<AdbOutput, DriverError> {
        check(line)?;
        let args: Vec<&str> = std::iter::once("shell").chain(line.words()).collect();
        self.adb(&args, bound).await
    }

    /// A line whose program tells of a failure in what it prints: an exception or an error line
    /// (some exit with 0 all the same), or else a status other than 0.
    async fn act(&self, line: &DeviceLine) -> Result<AdbOutput, DriverError> {
        let out = self.shell(line, ADB_TIMEOUT).await?;
        match refusal(line.program(), &out) {
            Some(error) => Err(error),
            None => Ok(out),
        }
    }

    /// The phone's input method now; `None` when it has none.
    async fn current_ime(&self) -> Result<Option<String>, DriverError> {
        let line = DeviceLine::new("settings")
            .word("get")
            .word("secure")
            .word("default_input_method");
        let out = self.act(&line).await?;
        let id = out.stdout_text().trim().to_owned();
        Ok((!id.is_empty() && id != "null").then_some(id))
    }

    /// The input methods enabled on the phone, in the order it lists them.
    async fn enabled_imes(&self) -> Result<Vec<String>, DriverError> {
        let out = self
            .act(&DeviceLine::new("ime").word("list").word("-s"))
            .await?;
        Ok(out
            .stdout_text()
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect())
    }

    async fn adbkeyboard_installed(&self) -> Result<bool, DriverError> {
        let line = DeviceLine::new("pm")
            .word("list")
            .word("packages")
            .word(ADB_KEYBOARD);
        let out = self.act(&line).await?;
        let wanted = format!("package:{ADB_KEYBOARD}");
        Ok(out.stdout_text().lines().any(|line| line.trim() == wanted))
    }

    /// Whether ADBKeyBoard is installed and enabled as an input method.
    async fn unicode_ready(&self) -> Result<bool, DriverError> {
        let (installed, enabled) = tokio::join!(self.adbkeyboard_installed(), self.enabled_imes());
        Ok(installed? && enabled?.iter().any(|ime| ime == ADB_KEYBOARD_IME))
    }

    fn recorded_ime(&self) -> Option<String> {
        self.restore_ime.lock().unwrap().clone()
    }

    /// Records `ime` to be put back, unless one is recorded already: that one is the phone's
    /// own, from before an earlier command that could not put it back.
    fn record_ime(&self, ime: Option<String>) {
        let mut recorded = self.restore_ime.lock().unwrap();
        if recorded.is_none() {
            *recorded = ime;
        }
    }

    fn clear_record(&self, ime: &str) {
        let mut recorded = self.restore_ime.lock().unwrap();
        if recorded.as_deref() == Some(ime) {
            *recorded = None;
        }
    }

    /// Puts the recorded input method back, if one is recorded, and clears the record once the
    /// phone shows it. One that could not be put back stays recorded for the next try: the
    /// phone's next recovery or Unicode `text`.
    async fn put_ime_back(&self) {
        let Some(ime) = self.recorded_ime() else {
            return;
        };
        let restored = async {
            self.act(&DeviceLine::new("ime").word("set").arg(&ime))
                .await?;
            Ok::<_, DriverError>(self.current_ime().await?.as_deref() == Some(ime.as_str()))
        }
        .await;
        match restored {
            Ok(true) => self.clear_record(&ime),
            Ok(false) => warn!(
                serial = %loggable(&self.serial),
                "the phone's input method was not put back; it is tried again later"
            ),
            Err(error) => warn!(
                serial = %loggable(&self.serial),
                reason = error.reason.key(),
                "the phone's input method could not be put back; it is tried again later"
            ),
        }
    }

    async fn read_report(&self) -> Result<PhoneReport, DriverError> {
        let getprop = DeviceLine::new("getprop");
        let size = DeviceLine::new("wm").word("size");
        let (props, size, unicode) = tokio::join!(
            self.shell(&getprop, ADB_TIMEOUT),
            self.shell(&size, ADB_TIMEOUT),
            self.unicode_ready(),
        );
        // A phone that does not tell its properties has no report: the loop stands in its last.
        let props = props?;
        if !props.success() {
            return Err(DriverError::new(
                FailReason::AdbError,
                "getprop failed on the phone",
            ));
        }
        let text = props.stdout_text();
        let props = properties(&text);
        let mut facts = self.facts.lock().unwrap();
        if let Some(model) = model(&props) {
            facts.model = Some(model);
        }
        if let Some(os_version) = os_version(&props) {
            facts.os_version = Some(os_version);
        }
        if let Ok(size) = size
            && size.success()
            && let Some((w, h)) = observe::screen_size(&size.stdout_text())
            && (1..=MAX_SCREEN_PX).contains(&w)
            && (1..=MAX_SCREEN_PX).contains(&h)
        {
            facts.screen = Some(observe::screen((w, h), 0));
        }
        if let Ok(unicode) = unicode {
            facts.unicode = unicode;
        }
        let mut features: Vec<String> = DeviceCommand::KINDS
            .iter()
            .map(|kind| (*kind).to_owned())
            .collect();
        if facts.unicode {
            features.push(TEXT_UNICODE.to_owned());
        }
        Ok(PhoneReport {
            platform: Platform::Android,
            serial: self.serial.clone(),
            model: facts.model.clone(),
            os_version: facts.os_version.clone(),
            screen: facts.screen,
            features,
        })
    }
}

#[async_trait]
impl PhoneDriver for AndroidAdbDriver {
    fn platform(&self) -> Platform {
        Platform::Android
    }

    /// The phone's model and Android version (`getprop`, kept from an earlier report when this
    /// one leaves them out), its screen in its natural orientation (`wm size`; an observation
    /// reads the rotation), and every command kind, with [`TEXT_UNICODE`] when ADBKeyBoard is
    /// installed and enabled. It takes no lock a command holds.
    async fn report(&self) -> Result<PhoneReport, DriverError> {
        self.read_report().await
    }

    async fn execute(
        &self,
        cmd: &DeviceCommand,
        files: &dyn FileTransfer,
    ) -> Result<CommandResult, DriverError> {
        self.carry_out(cmd, files).await
    }

    /// Puts back the input method a cut-off Unicode `text` left on ADBKeyBoard. The first call
    /// also looks at the phone, which a bridge killed mid-command may have left on ADBKeyBoard,
    /// and sets the first other enabled input method then. With nothing recorded after that
    /// first look, it makes no call.
    async fn recover(&self) {
        let recorded = self.recorded_ime();
        if recorded.is_none() && self.looked.load(Ordering::SeqCst) {
            return;
        }
        let current = match self.current_ime().await {
            Ok(current) => current,
            Err(error) => {
                warn!(
                    serial = %loggable(&self.serial),
                    reason = error.reason.key(),
                    "the phone's input method could not be read while recovering"
                );
                return;
            }
        };
        self.looked.store(true, Ordering::SeqCst);
        if current.as_deref() != Some(ADB_KEYBOARD_IME) {
            // Not on ADBKeyBoard: nothing to undo.
            if let Some(ime) = recorded {
                self.clear_record(&ime);
            }
            return;
        }
        if recorded.is_none() {
            let other = self
                .enabled_imes()
                .await
                .ok()
                .and_then(|enabled| other_ime(&enabled));
            let Some(other) = other else {
                warn!(
                    serial = %loggable(&self.serial),
                    "the phone is left on ADBKeyBoard: no other input method is enabled"
                );
                return;
            };
            self.record_ime(Some(other));
        }
        self.put_ime_back().await;
    }
}

/// The first enabled input method other than ADBKeyBoard.
fn other_ime(enabled: &[String]) -> Option<String> {
    enabled.iter().find(|ime| *ime != ADB_KEYBOARD_IME).cloned()
}

/// Refuses a line longer than [`MAX_DEVICE_LINE_BYTES`].
fn check(line: &DeviceLine) -> Result<(), DriverError> {
    let bytes = line.bytes();
    if bytes > MAX_DEVICE_LINE_BYTES {
        return Err(DriverError::new(
            FailReason::BridgeError,
            format!(
                "the command line for the phone is {bytes} bytes once quoted for its shell, \
                 over the {MAX_DEVICE_LINE_BYTES} bytes the bridge sends"
            ),
        ));
    }
    Ok(())
}

/// What `adb` itself prints when it cannot reach the phone (`adb.exe: device '…' not found`),
/// as opposed to what a program on the phone printed.
fn unreachable(out: &AdbOutput) -> Option<DriverError> {
    if out.success() {
        return None;
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let line = stderr
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    let message = ["adb.exe: ", "adb: ", "error: "]
        .iter()
        .find_map(|prefix| line.strip_prefix(prefix))?;
    let gone = (message.starts_with("device '") && message.ends_with("not found"))
        || [
            "device offline",
            "device unauthorized",
            "device still authorizing",
            "no devices/emulators found",
        ]
        .iter()
        .any(|state| message.starts_with(state));
    gone.then(|| {
        DriverError::new(
            FailReason::DeviceOffline,
            format!("adb cannot reach the phone: {}", clean(message)),
        )
    })
}

/// The failure a program on the phone reported in its output, if any.
fn refusal(program: &str, out: &AdbOutput) -> Option<DriverError> {
    let text = out.text();
    let failures: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| tells_of_failure(line))
        .collect();
    // `input` prints nothing when it works.
    let injection = match program {
        "input" => text.contains("SecurityException") || text.contains("Exception occurred"),
        _ => failures.iter().any(|line| line.contains("INJECT_EVENTS")),
    };
    if injection {
        return Some(DriverError::new(
            FailReason::AdbError,
            "the phone refused to inject input (SecurityException, INJECT_EVENTS); on a Xiaomi \
             phone, turn on \"USB debugging (Security settings)\" in Developer options",
        ));
    }
    if let Some(line) = failures.first() {
        return Some(DriverError::new(
            FailReason::AdbError,
            format!("{program} failed on the phone: {}", clean(line)),
        ));
    }
    if !out.success() {
        let code = out
            .code
            .map_or_else(|| "no status".to_owned(), |code| code.to_string());
        return Some(DriverError::new(
            FailReason::AdbError,
            format!(
                "{program} exited with {code} on the phone: {}",
                clean(first_line(&text))
            ),
        ));
    }
    None
}

/// Whether a line a program printed tells of its failure: an error line (`Error: …`, monkey's
/// `** …`), or an exception (`Exception occurred while executing …`, a line that begins with
/// the exception's class, `java.lang.SecurityException: …`). A line that only mentions one,
/// such as `am start` repeating the address it opens, does not.
fn tells_of_failure(line: &str) -> bool {
    let head = line.split(':').next().unwrap_or("");
    line.starts_with("Error")
        || line.starts_with("** ")
        || line.starts_with("Exception occurred")
        || (head.ends_with("Exception") && !head.contains(char::is_whitespace))
}

/// The first line of `text` with something on it.
fn first_line(text: &str) -> &str {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
}

/// A line the phone printed, fit for a failure's detail: control characters blanked, short.
fn clean(line: &str) -> String {
    line.chars()
        .take(200)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

/// `getprop`'s `[name]: [value]` lines.
fn properties(getprop: &str) -> HashMap<&str, &str> {
    getprop
        .lines()
        .filter_map(|line| {
            let (name, value) = line.trim().split_once("]: [")?;
            Some((name.strip_prefix('[')?, value.strip_suffix(']')?))
        })
        .collect()
}

/// A fact for a report: not blank, no NUL, at most [`MAX_ID_CHARS`] characters.
fn fact(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| {
        value
            .chars()
            .take(MAX_ID_CHARS)
            .map(|c| if c == '\0' { '\u{FFFD}' } else { c })
            .collect()
    })
}

/// The phone's market name where the maker sets one (`Redmi 10C`), else its model (`220333QAG`).
fn model(props: &HashMap<&str, &str>) -> Option<String> {
    ["ro.product.marketname", "ro.product.model"]
        .iter()
        .find_map(|name| props.get(name).and_then(|value| fact(value)))
}

/// `13 (API 33)`, or the release alone.
fn os_version(props: &HashMap<&str, &str>) -> Option<String> {
    let release = props
        .get("ro.build.version.release")
        .and_then(|v| fact(v))?;
    match props.get("ro.build.version.sdk").and_then(|v| fact(v)) {
        Some(sdk) => fact(&format!("{release} (API {sdk})")),
        None => Some(release),
    }
}

/// The phones attached to this computer, as `adb devices -l` lists them.
///
/// Only phones `adb` calls ready (`device`) are listed, and only the configured serials. A phone
/// that waits for its USB debugging prompt (`unauthorized`), or is attached but not ready, is
/// logged when its state changes. The same phone keeps its driver (the same `Arc`) while it
/// stays attached; one that left and came back gets a new one.
pub struct AndroidRegistry {
    adb: Arc<dyn AdbRunner>,
    serials: Option<Vec<String>>,
    drivers: Mutex<HashMap<String, Arc<AndroidAdbDriver>>>,
    /// The phones seen attached but not ready, and in which state.
    not_ready: Mutex<HashMap<String, String>>,
}

impl AndroidRegistry {
    /// The phones `adb` lists, only those in `serials` when it is set.
    pub fn new(adb: Arc<dyn AdbRunner>, serials: Option<Vec<String>>) -> AndroidRegistry {
        AndroidRegistry {
            adb,
            serials,
            drivers: Mutex::default(),
            not_ready: Mutex::default(),
        }
    }

    fn wanted(&self, serial: &str) -> bool {
        self.serials
            .as_ref()
            .is_none_or(|serials| serials.iter().any(|s| s == serial))
    }

    /// Logs each phone whose not-ready state is new.
    fn note_not_ready(&self, listed: &[(String, String)]) {
        let now: HashMap<String, String> = listed
            .iter()
            .filter(|(serial, state)| state != "device" && self.wanted(serial))
            .cloned()
            .collect();
        let mut before = self.not_ready.lock().unwrap();
        for (serial, state) in &now {
            if before.get(serial) == Some(state) {
                continue;
            }
            if state == "unauthorized" {
                info!(
                    serial = %loggable(serial),
                    "a phone waits for its USB debugging prompt to be accepted on its screen"
                );
            } else {
                info!(
                    serial = %loggable(serial),
                    state = %loggable(state),
                    "a phone is attached but not ready"
                );
            }
        }
        *before = now;
    }
}

#[async_trait]
impl PhoneRegistry for AndroidRegistry {
    async fn attached(&self) -> Result<Vec<AttachedPhone>, DriverError> {
        let out = match tokio::time::timeout(ADB_TIMEOUT, self.adb.devices()).await {
            Err(_) => {
                return Err(DriverError::new(
                    FailReason::Timeout,
                    format!(
                        "adb devices did not answer within {} s",
                        ADB_TIMEOUT.as_secs()
                    ),
                ));
            }
            Ok(Err(error)) => {
                return Err(DriverError::new(FailReason::AdbError, error.to_string()));
            }
            Ok(Ok(out)) => out,
        };
        if !out.success() {
            return Err(DriverError::new(
                FailReason::AdbError,
                format!("adb devices failed: {}", clean(first_line(&out.text()))),
            ));
        }
        let listed = devices(&out.stdout_text());
        self.note_not_ready(&listed);
        let ready: Vec<String> = listed
            .into_iter()
            .filter(|(serial, state)| state == "device" && self.wanted(serial))
            .map(|(serial, _)| serial)
            .collect();
        let mut drivers = self.drivers.lock().unwrap();
        drivers.retain(|serial, _| ready.contains(serial));
        Ok(ready
            .into_iter()
            .map(|serial| {
                let driver = drivers
                    .entry(serial.clone())
                    .or_insert_with(|| {
                        Arc::new(AndroidAdbDriver::new(serial.clone(), self.adb.clone()))
                    })
                    .clone();
                AttachedPhone { serial, driver }
            })
            .collect())
    }
}

/// `adb devices -l`: each phone's serial and state, from the lines after the heading.
fn devices(listing: &str) -> Vec<(String, String)> {
    let lines: Vec<&str> = listing.lines().map(str::trim).collect();
    let after = lines
        .iter()
        .position(|line| line.starts_with("List of devices"))
        .map_or(0, |heading| heading + 1);
    lines[after..]
        .iter()
        .filter(|line| !line.is_empty() && !line.starts_with('*'))
        .filter_map(|line| {
            let mut words = line.split_whitespace();
            Some((words.next()?.to_owned(), words.next()?.to_owned()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devices_are_read_after_the_heading() {
        let listing = "* daemon not running; starting now at tcp:5037\r\n* daemon started successfully\r\nList of devices attached\r\n18cf9fbb               device product:fog_tr model:220333QAG device:fog transport_id:1\r\nR58N0TEST0A    no permissions (missing udev rules?)\r\n\r\n";
        assert_eq!(
            devices(listing),
            [
                ("18cf9fbb".to_owned(), "device".to_owned()),
                ("R58N0TEST0A".to_owned(), "no".to_owned()),
            ]
        );
        assert!(devices("List of devices attached\n\n").is_empty());
    }

    #[test]
    fn adb_that_cannot_reach_the_phone() {
        let gone = |stderr: &str| unreachable(&AdbOutput::new(1, "", stderr)).map(|e| e.reason);
        assert_eq!(
            gone("adb.exe: device '18cf9fbb' not found\r\n"),
            Some(FailReason::DeviceOffline)
        );
        assert_eq!(
            gone("error: device offline\n"),
            Some(FailReason::DeviceOffline)
        );
        assert_eq!(
            gone("adb: device unauthorized.\n"),
            Some(FailReason::DeviceOffline)
        );
        // A program on the phone that failed is not adb failing.
        assert_eq!(gone("ls: /x: No such file or directory\n"), None);
        assert_eq!(
            unreachable(&AdbOutput::new(0, "", "adb: device offline")).map(|e| e.reason),
            None
        );
    }

    #[test]
    fn a_program_that_reports_a_failure() {
        let failed = |code: i32, stdout: &str, stderr: &str| {
            refusal("am", &AdbOutput::new(code, stdout, stderr)).map(|e| e.reason)
        };
        assert_eq!(
            failed(
                0,
                "Starting: Intent { act=android.intent.action.VIEW }\nError: Activity not started, unable to resolve Intent\n",
                ""
            ),
            Some(FailReason::AdbError)
        );
        assert_eq!(
            failed(
                0,
                "Starting: Intent { act=android.intent.action.VIEW }\n",
                ""
            ),
            None
        );
        assert_eq!(failed(1, "", ""), Some(FailReason::AdbError));
        // `am start` repeats the address it opens: words in it are not a failure.
        assert_eq!(
            failed(
                0,
                "Starting: Intent { act=android.intent.action.VIEW dat=https://example.com/Exception/INJECT_EVENTS }\n",
                ""
            ),
            None
        );
        assert_eq!(
            failed(
                0,
                "",
                "Exception occurred while executing 'start':\njava.lang.IllegalArgumentException: Unknown\n"
            ),
            Some(FailReason::AdbError)
        );
        let injection = refusal(
            "monkey",
            &AdbOutput::new(0, "", "java.lang.SecurityException: Injecting input events requires the INJECT_EVENTS permission.\n"),
        )
        .unwrap();
        assert!(
            injection
                .detail
                .contains("USB debugging (Security settings)")
        );
        assert_eq!(
            refusal(
                "monkey",
                &AdbOutput::new(
                    252,
                    "  bash arg: -p\n** No activities found to run, monkey aborted.\n",
                    ""
                )
            )
            .map(|e| e.reason),
            Some(FailReason::AdbError)
        );
    }

    #[test]
    fn properties_and_facts() {
        let props = properties(
            "[ro.product.model]: [220333QAG]\r\n[ro.product.marketname]: [ ]\n[ro.build.version.release]: [13]\nnot a property\n",
        );
        assert_eq!(model(&props).as_deref(), Some("220333QAG"));
        assert_eq!(os_version(&props).as_deref(), Some("13"));
        assert_eq!(
            fact(&"x".repeat(200)).map(|f| f.chars().count()),
            Some(MAX_ID_CHARS)
        );
        assert_eq!(fact("a\0b").as_deref(), Some("a\u{FFFD}b"));
    }
}
