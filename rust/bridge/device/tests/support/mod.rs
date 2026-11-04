//! What the integration tests share: capturing the log.

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

/// Everything logged on this thread, at every level, while it lives. `#[tokio::test]` runs every
/// task of a test on its thread, so a test sees what the bridge it runs logged.
pub struct Logs {
    buffer: Buffer,
    _guard: tracing::subscriber::DefaultGuard,
}

impl Logs {
    pub fn capture() -> Logs {
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

    pub fn text(&self) -> String {
        String::from_utf8(self.buffer.0.lock().unwrap().clone()).unwrap()
    }
}
