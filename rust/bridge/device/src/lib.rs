//! `jeeta-device-bridge`: the program on the computer a phone is plugged into, which connects the
//! phone to Jeeta (spec `2026-10-28-device-bridge-design.md` §6). Jeeta never reaches the phone:
//! the bridge registers the phones it sees, long-polls the server for their commands, runs each
//! through the phone's driver and posts what it did.
//!
//! - [`config`]: the TOML file and the key.
//! - [`client`]: the HTTP calls to Jeeta, over the wire types of `jt_device_protocol`.
//! - [`driver`]: what the bridge needs of a phone ([`PhoneDriver`], [`PhoneRegistry`]) and the
//!   file seam it gives a driver ([`FileTransfer`]).
//! - [`run_loop`]: register, poll, run and post ([`run`]).
//!
//! The program names no server crate: only the device vocabulary and its wire protocol, so it
//! builds on Windows, the owner's PC, and cannot drift from the server's bodies.
//!
//! # Logging
//!
//! Command ids, kinds and statuses, failure reasons, phone serials and counts. Never the key, a
//! command's arguments (typed text, shell arguments, addresses), an observation, shell output, a
//! file, a failure's detail, a phone number, a panic's message or a signed address; an HTTP error
//! is logged without its URL.

pub mod client;
pub mod config;
pub mod driver;
pub mod run_loop;

pub use client::{ClientError, JeetaClient};
pub use config::{BridgeKey, Config, ConfigError};
pub use driver::{
    AttachedPhone, ContentType, DriverError, FileTransfer, PhoneDriver, PhoneRegistry,
};
pub use run_loop::{RunError, Timing, run};

/// Replaces the panic hook with one that logs where a panic happened (`tracing`, at `error`)
/// and never its message. A driver's panic message is the driver's own and may quote a command
/// (typed text, shell arguments), which the default hook would print to the console. The loop
/// fails the command the panic was in either way.
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| match info.location() {
        Some(at) => tracing::error!(
            file = at.file(),
            line = at.line(),
            "a panic; its message is not logged"
        ),
        None => tracing::error!("a panic; its message is not logged"),
    }));
}

/// Log capture for the unit tests.
#[cfg(test)]
pub(crate) mod test_logs {
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct Buffer(Arc<Mutex<Vec<u8>>>);

    impl Write for Buffer {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// Everything logged on this thread while it lives.
    pub(crate) struct Logs {
        buffer: Buffer,
        _guard: tracing::subscriber::DefaultGuard,
    }

    impl Logs {
        pub(crate) fn capture() -> Logs {
            let buffer = Buffer::default();
            let writer = buffer.clone();
            let subscriber = tracing_subscriber::fmt()
                .with_max_level(tracing::Level::TRACE)
                .with_ansi(false)
                .with_writer(move || writer.clone())
                .finish();
            Logs {
                buffer,
                _guard: tracing::subscriber::set_default(subscriber),
            }
        }

        pub(crate) fn text(&self) -> String {
            String::from_utf8(self.buffer.0.lock().unwrap().clone()).unwrap()
        }
    }
}
