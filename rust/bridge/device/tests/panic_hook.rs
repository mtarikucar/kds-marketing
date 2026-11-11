//! The bridge's panic hook, in a test binary of its own: a hook is process-wide, and the loop's
//! tests need the default one to report their own failures.

mod support;

use support::Logs;

#[test]
fn a_panic_is_logged_by_where_it_happened_never_by_its_message() {
    jeeta_device_bridge::install_panic_hook();
    let text = std::thread::spawn(|| {
        let logs = Logs::capture();
        let panicked = std::panic::catch_unwind(|| panic!("typed text PANIC-PAYLOAD-91"));
        assert!(panicked.is_err());
        logs.text()
    })
    .join()
    .unwrap();
    let line = text
        .lines()
        .find(|l| l.contains("ERROR"))
        .unwrap_or_else(|| panic!("{text}"));
    assert!(line.contains("panic_hook.rs"), "{line}");
    assert!(!text.contains("PANIC-PAYLOAD"), "{text}");
}
