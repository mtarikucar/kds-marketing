//! The vocabulary of a driven phone (spec `2026-10-28-device-bridge-design.md` §4): the commands an
//! agent can queue for a device, the lifecycle a queued command goes through, what an observation
//! of the screen looks like, and which commands a bridge can carry out. Pure rules: no platform,
//! database or clock I/O; the platform-specific work of carrying a command out belongs to the
//! bridge program.
//!
//! Validation is about bounds only. There is deliberately no access policy here (no app
//! allowlist, no URL-scheme filter, no shell filter): the owner wants full access, and whatever
//! restricts it later is a separate layer.

mod command;
mod features;
mod lifecycle;
mod observation;

pub use command::{
    CommandError, DeviceCommand, DeviceKey, ElementTarget, MAX_ARG_CHARS, MAX_LONG_PRESS_MS,
    MAX_SHELL_ARGS, MAX_SWIPE_MS, MAX_TEXT_CHARS,
};
pub use features::{Platform, TEXT_UNICODE, supports};
pub use lifecycle::{
    CommandStatus, DEFAULT_EXPIRES_IN, FailReason, LifecycleError, LifecycleEvent, REDELIVER_AFTER,
    next_status,
};
pub use observation::{Element, MAX_ELEMENTS, Observation, Screen};
