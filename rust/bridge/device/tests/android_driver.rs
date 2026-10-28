//! The Android driver against a fake `adb`: a scripted phone behind the `AdbRunner` seam that
//! answers from fixtures and records every call, so no test runs the real `adb`.
//!
//! Fixtures (`tests/fixtures/`), as no emulator was at hand to record from:
//! - read on the owner's Redmi 10C (Android 13, MIUI 14) with read-only commands, then scrubbed:
//!   `dump_home_miui.xml` (the home screen; its clock, date and unread counts replaced),
//!   `getprop.txt` (a subset of non-identifying properties), `ime_list.txt`, `wm_size.txt`,
//!   `current_focus.txt`, `dump_written.txt`, `miui_theme_stack_trace.txt`, the first phone of
//!   `devices_l.txt`, and `input_method_other_ime.txt` (two sections of `dumpsys input_method`);
//! - edited from that last one: `input_method_adbime_unbound.txt` (ADBKeyBoard selected, bound to
//!   no field) and `input_method_bound.txt` (bound to a focused field);
//! - written by hand in the shapes the plan's findings record: `dump_whatsapp.xml`,
//!   `dump_numeric_refs.xml`, `idle_state_error.txt`, `inject_events_refusal.txt` and the other
//!   phones of `devices_l.txt`.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use jeeta_device_bridge::driver::android::{
    ADB_TIMEOUT, AdbError, AdbOutput, AdbRunner, AndroidAdbDriver, AndroidRegistry,
    IDLE_RETRY_PAUSE, IME_BIND_TIMEOUT, MAX_DEVICE_LINE_BYTES,
};
use jeeta_device_bridge::{ContentType, DriverError, FileTransfer, PhoneDriver, PhoneRegistry};
use jt_device_protocol::{
    CommandResult, DeviceCommand, DeviceKey, Element, ElementTarget, FailReason, Observation,
    Platform, Screen, TEXT_UNICODE,
};
use uuid::Uuid;

const SERIAL: &str = "18cf9fbb";
const ADB_IME: &str = "com.android.adbkeyboard/.AdbIME";
/// The owner's phone's own keyboard, its input method when the tests begin.
const PREFF: &str = "com.preff.kb.xm/com.preff.kb.LatinIME";
/// The first input method `ime list -s` lists on the owner's phone.
const FIRST_ENABLED: &str = "com.google.android.tts/com.google.android.apps.speech.tts.googletts.settings.asr.voiceime.VoiceInputMethodService";
const DUMP_LINE: &str = "shell rm -f /sdcard/jeeta_ui.xml ; uiautomator dump /sdcard/jeeta_ui.xml";
const CAT_LINE: &str = "exec-out cat /sdcard/jeeta_ui.xml";
const FILE_ID: Uuid = Uuid::from_u128(0x0190_0000_0000_7000_8000_0000_0000_0f11);
const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfake screen";
const DOWNLOAD: &[u8] = b"the file the agent pushes";
const PULLED: &[u8] = b"a file pulled from the phone";

fn fixture(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn ok(stdout: impl Into<Vec<u8>>) -> AdbOutput {
    AdbOutput::new(0, stdout, Vec::new())
}

// ---------------------------------------------------------------------------------------------
// The fake phone

/// What one `uiautomator dump` does.
#[derive(Clone)]
enum Dump {
    /// Writes this screen to the dump file.
    Xml(String),
    /// Refuses a moving screen, with exit code 0, and writes nothing.
    Idle,
}

struct State {
    /// The next dumps; the last one repeats.
    dumps: VecDeque<Dump>,
    /// What a dump writes to stderr besides.
    dump_stderr: String,
    /// What the dump file holds.
    file: Option<String>,
    wm_size: String,
    focus: String,
    /// `None`: `getprop` fails.
    getprop: Option<String>,
    /// `None`: `wm size` fails.
    wm_size_works: bool,
    current_ime: String,
    enabled_imes: Vec<String>,
    adbkeyboard_installed: bool,
    /// After ADBKeyBoard is selected, `dumpsys input_method` says it is bound to no field this
    /// many times.
    unbound_polls: usize,
    polls_since_selected: usize,
    /// What ADBKeyBoard was sent, decoded.
    typed: Vec<String>,
    /// `input` answers with the INJECT_EVENTS refusal, exit code 0.
    inject_refused: bool,
    /// Calls that begin with one of these never answer.
    hang: Vec<&'static str>,
    /// Fixed answers, by call.
    answers: Vec<(String, AdbOutput)>,
    /// `adb push`: the destination and the bytes of the local file.
    pushed: Vec<(String, Vec<u8>)>,
    devices: String,
}

struct FakeAdb {
    /// Every call: the serial and the arguments.
    calls: Mutex<Vec<(String, Vec<String>)>>,
    state: Mutex<State>,
}

impl FakeAdb {
    /// The owner's phone on a chat screen, with its own keyboard and ADBKeyBoard enabled.
    fn phone() -> FakeAdb {
        FakeAdb {
            calls: Mutex::default(),
            state: Mutex::new(State {
                dumps: VecDeque::from([Dump::Xml(fixture("dump_whatsapp.xml"))]),
                dump_stderr: String::new(),
                file: None,
                wm_size: "Physical size: 1080x2400\n".to_owned(),
                focus:
                    "  mCurrentFocus=Window{8f1c2d4 u0 com.whatsapp/com.whatsapp.Conversation}\n"
                        .to_owned(),
                getprop: Some(fixture("getprop.txt")),
                wm_size_works: true,
                current_ime: PREFF.to_owned(),
                enabled_imes: fixture("ime_list.txt").lines().map(str::to_owned).collect(),
                adbkeyboard_installed: true,
                unbound_polls: 0,
                polls_since_selected: 0,
                typed: Vec::new(),
                inject_refused: false,
                hang: Vec::new(),
                answers: Vec::new(),
                pushed: Vec::new(),
                devices: fixture("devices_l.txt"),
            }),
        }
    }

    fn with(self, change: impl FnOnce(&mut State)) -> FakeAdb {
        change(&mut self.state.lock().unwrap());
        self
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap()
    }

    /// Every call, its arguments joined by spaces.
    fn lines(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .map(|(_, args)| args.join(" "))
            .collect()
    }

    fn count(&self, line: &str) -> usize {
        self.lines().iter().filter(|l| *l == line).count()
    }

    fn answer(&self, args: &[&str], line: &str) -> AdbOutput {
        let mut state = self.state();
        if let Some((_, out)) = state.answers.iter().find(|(l, _)| l == line) {
            return out.clone();
        }
        match line {
            DUMP_LINE => {
                let next = if state.dumps.len() > 1 {
                    state.dumps.pop_front().unwrap()
                } else {
                    state.dumps[0].clone()
                };
                state.file = None;
                return match next {
                    Dump::Xml(xml) => {
                        state.file = Some(xml);
                        AdbOutput::new(0, fixture("dump_written.txt"), state.dump_stderr.clone())
                    }
                    Dump::Idle => ok(fixture("idle_state_error.txt")),
                };
            }
            CAT_LINE => {
                return match &state.file {
                    Some(xml) => ok(xml.clone()),
                    None => ok("cat: /sdcard/jeeta_ui.xml: No such file or directory\n"),
                };
            }
            "shell wm size" if state.wm_size_works => return ok(state.wm_size.clone()),
            "shell wm size" => return AdbOutput::new(1, "", "wm: failure\n"),
            "shell dumpsys window | grep mCurrentFocus" => return ok(state.focus.clone()),
            "shell getprop" => {
                return match &state.getprop {
                    Some(props) => ok(props.clone()),
                    None => AdbOutput::new(1, "", "getprop: failure\n"),
                };
            }
            "shell pm list packages com.android.adbkeyboard" => {
                return ok(if state.adbkeyboard_installed {
                    "package:com.android.adbkeyboard\n"
                } else {
                    ""
                });
            }
            "shell ime list -s" => return ok(state.enabled_imes.join("\n") + "\n"),
            "shell settings get secure default_input_method" => {
                return ok(format!("{}\n", state.current_ime));
            }
            "shell dumpsys input_method" => {
                if state.current_ime != ADB_IME {
                    return ok(fixture("input_method_other_ime.txt"));
                }
                state.polls_since_selected += 1;
                return ok(if state.polls_since_selected > state.unbound_polls {
                    fixture("input_method_bound.txt")
                } else {
                    fixture("input_method_adbime_unbound.txt")
                });
            }
            "exec-out screencap -p" => return ok(PNG),
            _ => {}
        }
        if let Some(ime) = line.strip_prefix("shell ime set ") {
            state.current_ime = ime.to_owned();
            state.polls_since_selected = 0;
            return ok(format!("Input method {ime} selected for user #0\n"));
        }
        if let Some(message) = line.strip_prefix("shell am broadcast -a ADB_INPUT_B64 --es msg ") {
            // Quoted for the phone's shell when it ends in `=`, which the shell then takes off.
            let bytes = STANDARD.decode(message.trim_matches('\'')).unwrap();
            state.typed.push(String::from_utf8(bytes).unwrap());
            return ok(
                "Broadcasting: Intent { act=ADB_INPUT_B64 flg=0x400000 (has extras) }\nBroadcast completed: result=0\n",
            );
        }
        if line.starts_with("shell input ") && state.inject_refused {
            return AdbOutput::new(0, "", fixture("inject_events_refusal.txt"));
        }
        if args[0] == "push" {
            let bytes = std::fs::read(args[1]).unwrap();
            state.pushed.push((args[2].to_owned(), bytes));
            return ok(format!("{}: 1 file pushed, 0 skipped.\n", args[1]));
        }
        if args[0] == "pull" {
            std::fs::write(args[2], PULLED).unwrap();
            return ok(format!("{}: 1 file pulled, 0 skipped.\n", args[1]));
        }
        ok("")
    }
}

#[async_trait]
impl AdbRunner for FakeAdb {
    async fn run(&self, serial: &str, args: &[&str]) -> Result<AdbOutput, AdbError> {
        let line = args.join(" ");
        self.calls.lock().unwrap().push((
            serial.to_owned(),
            args.iter().map(|a| (*a).to_owned()).collect(),
        ));
        let hangs = self.state().hang.iter().any(|h| line.starts_with(h));
        if hangs {
            std::future::pending::<()>().await;
        }
        Ok(self.answer(args, &line))
    }

    async fn devices(&self) -> Result<AdbOutput, AdbError> {
        self.calls
            .lock()
            .unwrap()
            .push((String::new(), vec!["devices".to_owned(), "-l".to_owned()]));
        Ok(ok(self.state().devices.clone()))
    }
}

/// The files of one command: uploads are kept, a download writes [`DOWNLOAD`].
#[derive(Default)]
struct FakeFiles {
    uploads: Mutex<Vec<(ContentType, Vec<u8>)>>,
}

#[async_trait]
impl FileTransfer for FakeFiles {
    async fn upload(&self, bytes: Vec<u8>, content_type: ContentType) -> Result<Uuid, DriverError> {
        self.uploads.lock().unwrap().push((content_type, bytes));
        Ok(FILE_ID)
    }

    async fn upload_file(
        &self,
        path: &Path,
        content_type: ContentType,
    ) -> Result<Uuid, DriverError> {
        let bytes = std::fs::read(path).unwrap();
        self.uploads.lock().unwrap().push((content_type, bytes));
        Ok(FILE_ID)
    }

    async fn download(&self, dest: &Path) -> Result<u64, DriverError> {
        std::fs::write(dest, DOWNLOAD).unwrap();
        Ok(DOWNLOAD.len() as u64)
    }
}

fn driver(adb: &Arc<FakeAdb>) -> AndroidAdbDriver {
    AndroidAdbDriver::new(SERIAL, adb.clone())
}

async fn run(driver: &AndroidAdbDriver, cmd: DeviceCommand) -> Result<CommandResult, DriverError> {
    assert_eq!(cmd.validate(), Ok(()), "the tests send valid commands");
    driver.execute(&cmd, &FakeFiles::default()).await
}

async fn observe(driver: &AndroidAdbDriver) -> Observation {
    match run(driver, DeviceCommand::Observe { screenshot: false }).await {
        Ok(CommandResult::Observation(seen)) => seen,
        other => panic!("not an observation: {other:?}"),
    }
}

fn text(value: &str) -> DeviceCommand {
    DeviceCommand::Text {
        value: value.to_owned(),
    }
}

fn tap_on(target: ElementTarget, exact: bool) -> DeviceCommand {
    DeviceCommand::TapOn { target, exact }
}

fn failed(result: Result<CommandResult, DriverError>) -> DriverError {
    match result {
        Err(error) => error,
        Ok(result) => panic!("the command did not fail: {result:?}"),
    }
}

/// A screen of one node per `(text, bounds)`, each clickable.
fn screen_of(nodes: &[(&str, &str, &str)]) -> String {
    let mut xml = String::from(
        "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\"><node index=\"0\" text=\"\" resource-id=\"\" class=\"android.widget.FrameLayout\" package=\"com.example\" content-desc=\"\" clickable=\"false\" focused=\"false\" bounds=\"[0,0][1080,2400]\">",
    );
    for (text, id, bounds) in nodes {
        xml.push_str(&format!(
            "<node index=\"0\" text=\"{text}\" resource-id=\"{id}\" class=\"android.widget.Button\" package=\"com.example\" content-desc=\"\" clickable=\"true\" focused=\"false\" bounds=\"{bounds}\" />"
        ));
    }
    xml.push_str("</node></hierarchy>");
    xml
}

fn element<'a>(seen: &'a Observation, label: &str) -> &'a Element {
    seen.elements
        .iter()
        .find(|e| e.text.as_deref() == Some(label) || e.desc.as_deref() == Some(label))
        .unwrap_or_else(|| panic!("no element {label:?}"))
}

// ---------------------------------------------------------------------------------------------
// Observe

#[tokio::test]
async fn dump_distills_elements() {
    let adb = Arc::new(FakeAdb::phone());
    let seen = observe(&driver(&adb)).await;
    assert_eq!(
        seen.screen,
        Screen {
            w: 1080,
            h: 2400,
            rotation: 0
        }
    );
    assert_eq!(seen.foreground_app.as_deref(), Some("com.whatsapp"));
    assert!(!seen.truncated);
    assert_eq!(seen.screenshot_file_id, None);
    // Layout scaffolding (the root, the toolbar, the list, the rows) and the zero-size row are
    // left out; what a person could read or press stays, in screen order.
    let labels: Vec<&str> = seen
        .elements
        .iter()
        .map(|e| e.text.as_deref().or(e.desc.as_deref()).unwrap())
        .collect();
    assert_eq!(
        labels,
        [
            "Geri",
            "Test Kişi",
            "Diğer seçenekler",
            "Merhaba, sipariş hazır mı?",
            "Fiyat < 100 & kargo > 0",
            "Emoji",
            "Mesaj",
            "Gönder",
        ]
    );
    assert_eq!(
        element(&seen, "Mesaj"),
        &Element {
            text: Some("Mesaj".to_owned()),
            id: Some("com.whatsapp:id/entry".to_owned()),
            desc: None,
            class: Some("android.widget.EditText".to_owned()),
            bounds: [126, 2210, 930, 2330],
            tap_point: [528, 2270],
            clickable: true,
            editable: true,
            focused: true,
        }
    );
    let send = element(&seen, "Gönder");
    assert_eq!(send.tap_point, [1005, 2270]);
    assert!(send.clickable && !send.editable && !send.focused);
    assert!(!element(&seen, "Test Kişi").editable);

    // The real home screen of the owner's phone.
    let adb = Arc::new(FakeAdb::phone().with(|s| {
        s.dumps = VecDeque::from([Dump::Xml(fixture("dump_home_miui.xml"))]);
        s.wm_size = fixture("wm_size.txt");
        s.focus = fixture("current_focus.txt");
    }));
    let seen = observe(&driver(&adb)).await;
    assert_eq!(seen.foreground_app.as_deref(), Some("com.miui.home"));
    let settings = seen
        .elements
        .iter()
        .find(|e| e.desc.as_deref() == Some("Ayarlar") && e.clickable)
        .unwrap();
    assert_eq!(settings.bounds, [360, 1147, 528, 1359]);
    assert_eq!(settings.tap_point, [444, 1253]);
    assert!(
        seen.elements
            .iter()
            .any(|e| e.text.as_deref() == Some("Mi Tarayıcı"))
    );
    assert!(
        seen.elements
            .iter()
            .all(|e| e.bounds[2] > e.bounds[0] && e.bounds[3] > e.bounds[1]),
        "no element without size"
    );
    assert!(seen.elements.len() < 164, "the scaffolding is left out");
}

#[tokio::test]
async fn numeric_references_decoded() {
    let adb = Arc::new(FakeAdb::phone().with(|s| {
        s.dumps = VecDeque::from([Dump::Xml(fixture("dump_numeric_refs.xml"))]);
    }));
    let seen = observe(&driver(&adb)).await;
    let texts: Vec<&str> = seen
        .elements
        .iter()
        .filter_map(|e| e.text.as_deref())
        .collect();
    assert_eq!(
        texts,
        [
            "Devam edin\nçay",
            "Kabul et & devam",
            "😀 gülümse",
            // A character beyond the first plane written as its two UTF-16 halves is whole again;
            // a lone half is U+FFFD.
            "😀 ve \u{FFFD}",
            // NUL and a number that is no character are U+FFFD; what is no reference stays.
            "a\u{FFFD}b \u{FFFD} &nbsp; &bogus; 5 > 3 'x'",
        ]
    );
    assert_eq!(seen.elements[1].desc.as_deref(), Some("\"Kabul\" düğmesi"));
}

#[tokio::test(start_paused = true)]
async fn idle_state_retried_then_screen_busy() {
    // Moving twice: retried once after a pause, then refused as busy, never read as empty.
    let adb = Arc::new(FakeAdb::phone().with(|s| {
        s.dumps = VecDeque::from([Dump::Idle, Dump::Idle]);
    }));
    let started = tokio::time::Instant::now();
    let error = failed(run(&driver(&adb), DeviceCommand::Observe { screenshot: false }).await);
    assert_eq!(error.reason, FailReason::ScreenBusy);
    assert_eq!(adb.count(DUMP_LINE), 2);
    assert_eq!(adb.count(CAT_LINE), 0, "a refused dump is not read");
    assert!(started.elapsed() >= IDLE_RETRY_PAUSE);

    // Moving once: the retry reads the screen.
    let adb = Arc::new(FakeAdb::phone().with(|s| {
        s.dumps = VecDeque::from([Dump::Idle, Dump::Xml(fixture("dump_whatsapp.xml"))]);
    }));
    let seen = observe(&driver(&adb)).await;
    assert_eq!(seen.elements.len(), 8);
    assert_eq!(adb.count(DUMP_LINE), 2);

    // A dump that claims success but leaves no screen in its file is busy too, not empty.
    let adb = Arc::new(FakeAdb::phone().with(|s| {
        s.dumps = VecDeque::from([Dump::Xml(
            "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\" />"
                .to_owned(),
        )]);
    }));
    let error = failed(run(&driver(&adb), DeviceCommand::Observe { screenshot: false }).await);
    assert_eq!(error.reason, FailReason::ScreenBusy);
}

#[tokio::test]
async fn observe_reports_rotated_screen() {
    // The owner's phone was seen at ROTATION_270: its 720x1650 screen read as 1650x720.
    let rotated = fixture("dump_home_miui.xml").replace("rotation=\"0\"", "rotation=\"3\"");
    let adb = Arc::new(FakeAdb::phone().with(|s| {
        s.dumps = VecDeque::from([Dump::Xml(rotated), Dump::Xml(fixture("dump_home_miui.xml"))]);
        s.wm_size = fixture("wm_size.txt");
    }));
    let phone = driver(&adb);
    assert_eq!(
        observe(&phone).await.screen,
        Screen {
            w: 1650,
            h: 720,
            rotation: 270
        }
    );
    // Read again on the next observation, never kept from the last one or from a report.
    assert_eq!(
        observe(&phone).await.screen,
        Screen {
            w: 720,
            h: 1650,
            rotation: 0
        }
    );
    assert_eq!(adb.count("shell wm size"), 2);

    // A resolution set with `wm size` is the one the screen has.
    let adb = Arc::new(FakeAdb::phone().with(|s| {
        s.wm_size = "Physical size: 1080x2400\nOverride size: 720x1600\n".to_owned();
    }));
    assert_eq!(
        observe(&driver(&adb)).await.screen,
        Screen {
            w: 720,
            h: 1600,
            rotation: 0
        }
    );
}

#[tokio::test]
async fn miui_theme_stack_trace_is_not_a_failure() {
    // MIUI's `uiautomator dump` prints a Java stack trace about a theme file and still dumps.
    let adb = Arc::new(FakeAdb::phone().with(|s| {
        s.dumps = VecDeque::from([Dump::Xml(fixture("dump_home_miui.xml"))]);
        s.dump_stderr = fixture("miui_theme_stack_trace.txt");
        s.wm_size = fixture("wm_size.txt");
        s.focus = fixture("current_focus.txt");
    }));
    let seen = observe(&driver(&adb)).await;
    assert!(seen.elements.len() > 20);
    assert_eq!(seen.foreground_app.as_deref(), Some("com.miui.home"));
    assert_eq!(adb.count(DUMP_LINE), 1, "not retried either");
}

// ---------------------------------------------------------------------------------------------
// Tap on

#[tokio::test]
async fn tap_on_exact_beats_contains() {
    let screen = screen_of(&[
        ("Silinenler", "com.example:id/trash", "[0,100][500,200]"),
        ("Sil", "com.example:id/delete", "[0,300][500,400]"),
        (
            "Tümünü sil",
            "com.example:id/delete_all",
            "[0,500][500,600]",
        ),
    ]);
    let adb = Arc::new(FakeAdb::phone().with(|s| s.dumps = VecDeque::from([Dump::Xml(screen)])));
    let phone = driver(&adb);
    let tapped = |adb: &FakeAdb| adb.lines().last().unwrap().clone();

    // "Sil" is also in "Silinenler", which comes first: the exact one wins.
    run(&phone, tap_on(ElementTarget::Text("Sil".to_owned()), false))
        .await
        .unwrap();
    assert_eq!(tapped(&adb), "shell input tap 250 350");
    let lines = adb.lines();
    assert_eq!(lines[lines.len() - 2], CAT_LINE, "the screen is read first");

    // No exact match: a part of the text, whatever its case.
    run(
        &phone,
        tap_on(ElementTarget::Text("SILIN".to_owned()), false),
    )
    .await
    .unwrap();
    assert_eq!(tapped(&adb), "shell input tap 250 150");
    // Of the texts "sil" is a part of, the closest: the shortest.
    run(&phone, tap_on(ElementTarget::Text("sil".to_owned()), false))
        .await
        .unwrap();
    assert_eq!(tapped(&adb), "shell input tap 250 350");

    // `exact` takes no part.
    let before = adb.lines().len();
    let error = failed(run(&phone, tap_on(ElementTarget::Text("Sili".to_owned()), true)).await);
    assert_eq!(error.reason, FailReason::ElementNotFound);
    assert!(
        adb.lines()[before..]
            .iter()
            .all(|l| !l.starts_with("shell input")),
        "nothing tapped"
    );

    // An id matches whole or by its name after the package.
    run(
        &phone,
        tap_on(ElementTarget::Id("delete_all".to_owned()), true),
    )
    .await
    .unwrap();
    assert_eq!(tapped(&adb), "shell input tap 250 550");
    run(
        &phone,
        tap_on(ElementTarget::Id("com.example:id/delete".to_owned()), true),
    )
    .await
    .unwrap();
    assert_eq!(tapped(&adb), "shell input tap 250 350");

    // A description, on the chat screen.
    let adb = Arc::new(FakeAdb::phone());
    run(
        &driver(&adb),
        tap_on(ElementTarget::Desc("Gönder".to_owned()), false),
    )
    .await
    .unwrap();
    assert_eq!(tapped(&adb), "shell input tap 1005 2270");
}

#[tokio::test]
async fn tap_on_missing_lists_labels() {
    let adb = Arc::new(FakeAdb::phone());
    let error = failed(
        run(
            &driver(&adb),
            tap_on(ElementTarget::Text("Ara".to_owned()), false),
        )
        .await,
    );
    assert_eq!(error.reason, FailReason::ElementNotFound);
    for label in ["Geri", "Test Kişi", "Mesaj", "Gönder"] {
        assert!(error.detail.contains(label), "{label}: {}", error.detail);
    }
    assert!(adb.lines().iter().all(|l| !l.starts_with("shell input")));

    // At most 20 labels.
    let names: Vec<String> = (1..=25).map(|n| format!("B{n:02}")).collect();
    let nodes: Vec<(&str, &str, String)> = names
        .iter()
        .enumerate()
        .map(|(i, n)| {
            (
                n.as_str(),
                "",
                format!("[0,{}][100,{}]", i * 10, i * 10 + 10),
            )
        })
        .collect();
    let nodes: Vec<(&str, &str, &str)> =
        nodes.iter().map(|(a, b, c)| (*a, *b, c.as_str())).collect();
    let adb = Arc::new(FakeAdb::phone().with(|s| {
        s.dumps = VecDeque::from([Dump::Xml(screen_of(&nodes))]);
    }));
    let error = failed(
        run(
            &driver(&adb),
            tap_on(ElementTarget::Text("Ara".to_owned()), false),
        )
        .await,
    );
    assert!(error.detail.contains("B20"), "{}", error.detail);
    assert!(!error.detail.contains("B21"), "{}", error.detail);
}

// ---------------------------------------------------------------------------------------------
// Text

#[tokio::test]
async fn ascii_text_escapes_for_device_shell() {
    let adb = Arc::new(FakeAdb::phone());
    let phone = driver(&adb);
    run(&phone, text("hello")).await.unwrap();
    // Spaces as `%s` for `input`, the rest quoted for the phone's shell.
    run(&phone, text("it's 5$ & \"ok\"; (x)|`y`"))
        .await
        .unwrap();
    // `input text` reads `%s` as a space: a `%s` that is in the text is typed in two parts.
    run(&phone, text("50%sale")).await.unwrap();
    assert_eq!(
        adb.lines(),
        [
            "shell input text hello",
            r#"shell input text 'it'\''s%s5$%s&%s"ok";%s(x)|`y`'"#,
            "shell input text 50%",
            "shell input text sale",
        ]
    );
    assert!(adb.state().typed.is_empty(), "ASCII needs no ADBKeyBoard");
}

#[tokio::test]
async fn unicode_text_uses_adbkeyboard_and_restores_ime() {
    let adb = Arc::new(FakeAdb::phone());
    let value = "Merhaba dünya 👋";
    assert_eq!(
        run(&driver(&adb), text(value)).await.unwrap(),
        CommandResult::Done {}
    );
    assert_eq!(adb.state().typed, [value]);
    assert_eq!(
        adb.lines(),
        [
            "shell ime list -s".to_owned(),
            "shell settings get secure default_input_method".to_owned(),
            format!("shell ime set {ADB_IME}"),
            "shell dumpsys input_method".to_owned(),
            // 19 bytes of UTF-8: the base64 ends in `==`, so it is quoted.
            format!(
                "shell am broadcast -a ADB_INPUT_B64 --es msg '{}'",
                STANDARD.encode(value)
            ),
            format!("shell ime set {PREFF}"),
            "shell settings get secure default_input_method".to_owned(),
        ]
    );
    assert_eq!(
        adb.state().current_ime,
        PREFF,
        "the phone's keyboard is back"
    );
}

#[tokio::test(start_paused = true)]
async fn unicode_text_waits_for_ime_binding() {
    // A broadcast sent before ADBKeyBoard holds the focused field is lost.
    let adb = Arc::new(FakeAdb::phone().with(|s| s.unbound_polls = 3));
    run(&driver(&adb), text("çay")).await.unwrap();
    let lines = adb.lines();
    let polls: Vec<usize> = (0..lines.len())
        .filter(|&i| lines[i] == "shell dumpsys input_method")
        .collect();
    let broadcast = lines
        .iter()
        .position(|l| l.starts_with("shell am broadcast"))
        .unwrap();
    assert_eq!(polls.len(), 4);
    assert!(broadcast > *polls.last().unwrap());
    assert_eq!(adb.state().typed, ["çay"]);
    assert_eq!(adb.state().current_ime, PREFF);
}

#[tokio::test(start_paused = true)]
async fn unicode_text_ime_never_binds_is_a_failure_and_restores_ime() {
    let adb = Arc::new(FakeAdb::phone().with(|s| s.unbound_polls = usize::MAX));
    let started = tokio::time::Instant::now();
    let error = failed(run(&driver(&adb), text("çay")).await);
    assert_eq!(error.reason, FailReason::AdbError);
    assert!(error.detail.contains("focused"), "{}", error.detail);
    assert!(started.elapsed() >= IME_BIND_TIMEOUT);
    assert!(adb.state().typed.is_empty());
    assert!(
        adb.lines()
            .iter()
            .all(|l| !l.starts_with("shell am broadcast"))
    );
    assert_eq!(
        adb.state().current_ime,
        PREFF,
        "the phone's keyboard is back"
    );
}

#[tokio::test]
async fn unicode_text_without_adbkeyboard_refused() {
    let adb = Arc::new(FakeAdb::phone().with(|s| {
        s.adbkeyboard_installed = false;
        s.enabled_imes.retain(|i| i != ADB_IME);
    }));
    let error = failed(run(&driver(&adb), text("çay")).await);
    assert_eq!(error.reason, FailReason::UnicodeUnsupported);
    assert!(error.detail.contains("ADBKeyBoard"), "{}", error.detail);
    assert!(
        adb.lines()
            .iter()
            .all(|l| !l.starts_with("shell ime set") && !l.starts_with("shell am broadcast"))
    );

    // Installed, but not enabled as an input method.
    let adb = Arc::new(FakeAdb::phone().with(|s| s.enabled_imes.retain(|i| i != ADB_IME)));
    let error = failed(run(&driver(&adb), text("çay")).await);
    assert_eq!(error.reason, FailReason::UnicodeUnsupported);
    assert!(error.detail.contains("enabled"), "{}", error.detail);
    assert_eq!(adb.state().current_ime, PREFF);
}

// ---------------------------------------------------------------------------------------------
// Refusals

#[tokio::test]
async fn inject_events_refusal_with_exit_0_is_a_failure() {
    // Without Xiaomi's "USB debugging (Security settings)", `input` refuses and exits 0.
    let adb = Arc::new(FakeAdb::phone().with(|s| s.inject_refused = true));
    let phone = driver(&adb);
    for cmd in [
        DeviceCommand::Tap { x: 10, y: 20 },
        DeviceCommand::Key {
            key: DeviceKey::Back,
        },
        text("hi"),
    ] {
        let error = failed(run(&phone, cmd).await);
        assert_eq!(error.reason, FailReason::AdbError);
        assert!(
            error.detail.contains("USB debugging (Security settings)"),
            "{}",
            error.detail
        );
    }
}

#[tokio::test(start_paused = true)]
async fn a_hung_adb_call_is_cut_at_its_bound() {
    let adb = Arc::new(FakeAdb::phone().with(|s| s.hang = vec!["shell input tap"]));
    let started = tokio::time::Instant::now();
    let error = failed(run(&driver(&adb), DeviceCommand::Tap { x: 1, y: 2 }).await);
    assert_eq!(error.reason, FailReason::Timeout);
    assert!(started.elapsed() >= ADB_TIMEOUT);
}

#[tokio::test]
async fn a_phone_adb_cannot_reach_is_offline() {
    let adb = Arc::new(FakeAdb::phone().with(|s| {
        s.answers.push((
            "shell input tap 1 2".to_owned(),
            AdbOutput::new(1, "", "adb.exe: device '18cf9fbb' not found\n"),
        ));
    }));
    let error = failed(run(&driver(&adb), DeviceCommand::Tap { x: 1, y: 2 }).await);
    assert_eq!(error.reason, FailReason::DeviceOffline);
}

// ---------------------------------------------------------------------------------------------
// Shell

#[tokio::test]
async fn shell_passes_argv_separately() {
    let argv = ["sh", "-c", "echo $HOME; ls", "it's", "", "a b"];
    let adb = Arc::new(FakeAdb::phone().with(|s| {
        s.answers.push((
            r"shell sh -c 'echo $HOME; ls' 'it'\''s' '' 'a b'".to_owned(),
            AdbOutput::new(3, "out\n", "err\n"),
        ));
    }));
    let result = run(
        &driver(&adb),
        DeviceCommand::Shell {
            argv: argv.iter().map(|a| (*a).to_owned()).collect(),
        },
    )
    .await
    .unwrap();
    // A program that fails is a result, with its exit code: not a failed command.
    assert_eq!(
        result,
        CommandResult::Shell {
            exit_code: 3,
            stdout: "out\n".to_owned(),
            stderr: "err\n".to_owned(),
            truncated: false,
        }
    );
    let calls = adb.calls.lock().unwrap();
    assert_eq!(
        calls[0].1,
        [
            "shell",
            "sh",
            "-c",
            "'echo $HOME; ls'",
            r"'it'\''s'",
            "''",
            "'a b'"
        ],
        "one adb argument per argument, each quoted for the phone's shell"
    );
}

#[tokio::test]
async fn shell_overlong_after_quoting_refused_with_bridge_error() {
    // Valid as sent (16 064 characters in all), four times as long once each quote is quoted.
    let argv = vec!["'".repeat(250); 64];
    let adb = Arc::new(FakeAdb::phone());
    let error = failed(run(&driver(&adb), DeviceCommand::Shell { argv }).await);
    assert_eq!(error.reason, FailReason::BridgeError);
    assert!(
        error.detail.contains(&MAX_DEVICE_LINE_BYTES.to_string()),
        "{}",
        error.detail
    );
    // 64 words of 1 002 bytes (`'` + 250 × `'\''` + `'`) and 63 spaces.
    assert!(
        error.detail.contains("64191"),
        "the length: {}",
        error.detail
    );
    assert!(adb.lines().is_empty(), "refused before any adb call");
}

// ---------------------------------------------------------------------------------------------
// Every kind

#[tokio::test]
async fn each_kind_runs_its_adb_command() {
    let adb = Arc::new(FakeAdb::phone());
    let phone = driver(&adb);
    let done =
        |r: Result<CommandResult, DriverError>| assert_eq!(r.unwrap(), CommandResult::Done {});
    done(run(&phone, DeviceCommand::Tap { x: 10, y: 20 }).await);
    done(
        run(
            &phone,
            DeviceCommand::LongPress {
                x: 5,
                y: 6,
                ms: 800,
            },
        )
        .await,
    );
    done(
        run(
            &phone,
            DeviceCommand::Swipe {
                x1: 1,
                y1: 2,
                x2: 3,
                y2: 4,
                ms: 300,
            },
        )
        .await,
    );
    for key in DeviceKey::ALL {
        done(run(&phone, DeviceCommand::Key { key: *key }).await);
    }
    done(
        run(
            &phone,
            DeviceCommand::OpenUrl {
                url: "https://example.com/?q=a b&c".to_owned(),
            },
        )
        .await,
    );
    done(
        run(
            &phone,
            DeviceCommand::LaunchApp {
                app_id: "com.whatsapp".to_owned(),
            },
        )
        .await,
    );
    assert_eq!(
        adb.lines(),
        [
            "shell input tap 10 20",
            "shell input swipe 5 6 5 6 800",
            "shell input swipe 1 2 3 4 300",
            "shell input keyevent 4",
            "shell input keyevent 3",
            "shell input keyevent 66",
            "shell input keyevent 187",
            "shell input keyevent 67",
            "shell input keyevent 24",
            "shell input keyevent 25",
            "shell input keyevent 26",
            "shell am start -a android.intent.action.VIEW -d 'https://example.com/?q=a b&c'",
            "shell monkey -p com.whatsapp -c android.intent.category.LAUNCHER 1",
        ]
    );

    // Screenshots and files go through the command's transfer.
    let files = FakeFiles::default();
    let shot = phone
        .execute(&DeviceCommand::Screenshot {}, &files)
        .await
        .unwrap();
    assert_eq!(shot, CommandResult::File { file_id: FILE_ID });
    let seen = phone
        .execute(&DeviceCommand::Observe { screenshot: true }, &files)
        .await
        .unwrap();
    let CommandResult::Observation(seen) = seen else {
        panic!("not an observation")
    };
    assert_eq!(seen.screenshot_file_id, Some(FILE_ID));
    phone
        .execute(
            &DeviceCommand::PushFile {
                file_id: FILE_ID,
                dest: "/sdcard/Download/a b.pdf".to_owned(),
            },
            &files,
        )
        .await
        .unwrap();
    let pulled = phone
        .execute(
            &DeviceCommand::PullFile {
                path: "/sdcard/DCIM/x.jpg".to_owned(),
            },
            &files,
        )
        .await
        .unwrap();
    assert_eq!(pulled, CommandResult::File { file_id: FILE_ID });
    assert_eq!(
        *files.uploads.lock().unwrap(),
        [
            (ContentType::Png, PNG.to_vec()),
            (ContentType::Png, PNG.to_vec()),
            (ContentType::OctetStream, PULLED.to_vec()),
        ]
    );
    // Paths go to adb's file transfer, not to a shell: as they are.
    assert_eq!(
        adb.state().pushed,
        [("/sdcard/Download/a b.pdf".to_owned(), DOWNLOAD.to_vec())]
    );
    let lines = adb.lines();
    let pull = lines.iter().find(|l| l.starts_with("pull ")).unwrap();
    assert!(pull.starts_with("pull /sdcard/DCIM/x.jpg "), "{pull}");
    // The temporary files are gone.
    let locals: Vec<String> = adb
        .calls
        .lock()
        .unwrap()
        .iter()
        .filter_map(|(_, args)| match args[0].as_str() {
            "push" => Some(args[1].clone()),
            "pull" => Some(args[2].clone()),
            _ => None,
        })
        .collect();
    assert_eq!(locals.len(), 2);
    for local in locals {
        assert!(!Path::new(&local).exists(), "{local} was left behind");
    }

    // A device path adb would read as an option is refused before adb runs.
    for cmd in [
        DeviceCommand::PullFile {
            path: "--help".to_owned(),
        },
        DeviceCommand::PushFile {
            file_id: FILE_ID,
            dest: "-x".to_owned(),
        },
    ] {
        let error = failed(phone.execute(&cmd, &files).await);
        assert_eq!(error.reason, FailReason::BridgeError);
    }
    assert_eq!(adb.lines().len(), lines.len());
}

#[tokio::test]
async fn every_call_names_the_serial() {
    let adb = Arc::new(FakeAdb::phone());
    let phone = driver(&adb);
    let files = FakeFiles::default();
    for cmd in [
        DeviceCommand::Observe { screenshot: true },
        DeviceCommand::Tap { x: 1, y: 2 },
        tap_on(ElementTarget::Desc("Gönder".to_owned()), false),
        DeviceCommand::LongPress {
            x: 1,
            y: 2,
            ms: 500,
        },
        DeviceCommand::Swipe {
            x1: 1,
            y1: 2,
            x2: 3,
            y2: 4,
            ms: 100,
        },
        text("ascii"),
        text("ünicode"),
        DeviceCommand::Key {
            key: DeviceKey::Home,
        },
        DeviceCommand::OpenUrl {
            url: "https://example.com".to_owned(),
        },
        DeviceCommand::LaunchApp {
            app_id: "com.example".to_owned(),
        },
        DeviceCommand::Shell {
            argv: vec!["getprop".to_owned(), "ro.product.model".to_owned()],
        },
        DeviceCommand::PushFile {
            file_id: FILE_ID,
            dest: "/sdcard/x".to_owned(),
        },
        DeviceCommand::PullFile {
            path: "/sdcard/x".to_owned(),
        },
        DeviceCommand::Screenshot {},
    ] {
        assert_eq!(cmd.validate(), Ok(()));
        phone.execute(&cmd, &files).await.unwrap();
    }
    phone.report().await.unwrap();
    phone.recover().await;
    let calls = adb.calls.lock().unwrap();
    assert!(calls.len() > 20);
    for (serial, args) in calls.iter() {
        assert_eq!(serial, SERIAL, "{args:?}");
    }
}

// ---------------------------------------------------------------------------------------------
// Report and recover

#[tokio::test]
async fn report_merges_getprop() {
    let adb = Arc::new(FakeAdb::phone().with(|s| s.wm_size = fixture("wm_size.txt")));
    let phone = driver(&adb);
    let report = phone.report().await.unwrap();
    assert_eq!(report.platform, Platform::Android);
    assert_eq!(report.serial, SERIAL);
    assert_eq!(report.model.as_deref(), Some("Redmi 10C"));
    assert_eq!(report.os_version.as_deref(), Some("13 (API 33)"));
    assert_eq!(
        report.screen,
        Some(Screen {
            w: 720,
            h: 1650,
            rotation: 0
        })
    );
    let mut every: Vec<String> = DeviceCommand::KINDS
        .iter()
        .map(|k| (*k).to_owned())
        .collect();
    every.push(TEXT_UNICODE.to_owned());
    assert_eq!(report.features, every);
    assert_eq!(report.validate(), Ok(()));

    // A read that leaves a fact out keeps the last one: the facts are merged, never emptied.
    {
        let mut state = adb.state();
        state.getprop =
            Some("[ro.build.version.release]: [14]\n[ro.product.marketname]: []\n".to_owned());
        state.wm_size_works = false;
    }
    let report = phone.report().await.unwrap();
    assert_eq!(report.model.as_deref(), Some("Redmi 10C"));
    assert_eq!(report.os_version.as_deref(), Some("14"));
    assert_eq!(report.screen.map(|s| (s.w, s.h)), Some((720, 1650)));

    // A phone that does not answer has no report: the loop stands in its last one.
    adb.state().getprop = None;
    assert!(phone.report().await.is_err());

    // A phone without ADBKeyBoard types ASCII only; one without the market name has its model.
    let adb = Arc::new(FakeAdb::phone().with(|s| {
        s.adbkeyboard_installed = false;
        s.getprop =
            Some(fixture("getprop.txt").replace("[ro.product.marketname]: [Redmi 10C]\n", ""));
    }));
    let report = driver(&adb).report().await.unwrap();
    assert!(!report.features.iter().any(|f| f == TEXT_UNICODE));
    assert_eq!(report.features.len(), DeviceCommand::KINDS.len());
    assert_eq!(report.model.as_deref(), Some("220333QAG"));
}

#[tokio::test(start_paused = true)]
async fn recover_restores_the_ime_after_a_cut_unicode_text() {
    let adb = Arc::new(FakeAdb::phone().with(|s| s.hang = vec!["shell dumpsys input_method"]));
    let phone = driver(&adb);
    // Cut off as the loop cuts it: the future is dropped while it waits.
    let cut = tokio::time::timeout(Duration::from_secs(1), run(&phone, text("çay"))).await;
    assert!(cut.is_err());
    assert_eq!(adb.state().current_ime, ADB_IME, "left on ADBKeyBoard");

    adb.state().hang.clear();
    phone.recover().await;
    assert_eq!(adb.state().current_ime, PREFF);
    assert!(adb.lines().contains(&format!("shell ime set {PREFF}")));

    // With nothing left to undo, recovering is cheap: no call at all.
    let calls = adb.lines().len();
    phone.recover().await;
    assert_eq!(adb.lines().len(), calls);
}

#[tokio::test]
async fn recover_at_start_restores_a_left_adbkeyboard() {
    // A bridge killed mid-command left ADBKeyBoard as the phone's input method: the first
    // recovery sets the first other enabled one.
    let adb = Arc::new(FakeAdb::phone().with(|s| s.current_ime = ADB_IME.to_owned()));
    let phone = driver(&adb);
    phone.recover().await;
    assert_eq!(adb.state().current_ime, FIRST_ENABLED);
    let calls = adb.lines().len();
    phone.recover().await;
    assert_eq!(adb.lines().len(), calls, "the phone is looked at once");

    // A phone on its own keyboard is left as it is.
    let adb = Arc::new(FakeAdb::phone());
    driver(&adb).recover().await;
    assert_eq!(
        adb.lines(),
        ["shell settings get secure default_input_method"]
    );
    assert_eq!(adb.state().current_ime, PREFF);
}

#[tokio::test]
async fn report_does_not_wait_behind_execute() {
    let adb = Arc::new(FakeAdb::phone().with(|s| s.hang = vec!["shell sleep"]));
    let phone = Arc::new(driver(&adb));
    let running = {
        let phone = phone.clone();
        tokio::spawn(async move {
            let cmd = DeviceCommand::Shell {
                argv: vec!["sleep".to_owned(), "600".to_owned()],
            };
            phone.execute(&cmd, &FakeFiles::default()).await
        })
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        while !adb.lines().iter().any(|l| l == "shell sleep 600") {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the command reached adb");
    let report = tokio::time::timeout(Duration::from_secs(5), phone.report())
        .await
        .expect("the report waited behind the command");
    assert_eq!(report.unwrap().model.as_deref(), Some("Redmi 10C"));
    assert!(!running.is_finished());
    running.abort();
}

// ---------------------------------------------------------------------------------------------
// Registry

#[tokio::test]
async fn registry_returns_the_same_driver_for_the_same_serial() {
    let adb = Arc::new(FakeAdb::phone());
    let registry = AndroidRegistry::new(adb.clone(), None);
    let first = registry.attached().await.unwrap();
    // Ready phones only: not the unauthorized one nor the offline one.
    let serials: Vec<&str> = first.iter().map(|p| p.serial.as_str()).collect();
    assert_eq!(serials, [SERIAL, "emulator-5554"]);
    let second = registry.attached().await.unwrap();
    for (a, b) in first.iter().zip(&second) {
        assert!(Arc::ptr_eq(&a.driver, &b.driver), "{}", a.serial);
    }
    assert!(!Arc::ptr_eq(&first[0].driver, &first[1].driver));
    assert_eq!(first[0].driver.platform(), Platform::Android);

    // A phone that left and came back is a new phone.
    let all = adb.state().devices.clone();
    adb.state().devices = all.replace("emulator-5554", "emulator-5556");
    registry.attached().await.unwrap();
    adb.state().devices = all;
    let back = registry.attached().await.unwrap();
    assert!(Arc::ptr_eq(&first[0].driver, &back[0].driver));
    assert!(!Arc::ptr_eq(&first[1].driver, &back[1].driver));

    // Only the configured serials.
    let only = AndroidRegistry::new(adb.clone(), Some(vec!["emulator-5554".to_owned()]));
    let listed = only.attached().await.unwrap();
    let serials: Vec<&str> = listed.iter().map(|p| p.serial.as_str()).collect();
    assert_eq!(serials, ["emulator-5554"]);
}
