//! The vocabulary of a driven phone (spec `2026-10-28-device-bridge-design.md` §4): the commands an
//! agent can queue for a device, the lifecycle a queued command goes through, what an observation
//! of the screen looks like, and which commands a bridge can carry out. Pure rules: no platform,
//! database or clock I/O; the platform-specific work of carrying a command out belongs to the
//! bridge program.
//!
//! Validation is about bounds and well-formedness only. There is deliberately no access policy
//! here (no app allowlist, no URL-scheme filter, no shell filter): the owner wants full access,
//! and whatever restricts it later is a separate layer.
//!
//! # Growing the vocabulary
//!
//! Server and bridge are deployed separately, so a newer one talks to an older one:
//!
//! - A new command kind needs a feature name. A bridge reports what it runs, and the server
//!   queues a command only for a bridge that lists its kind (see [`supports`]).
//! - A new field on an existing kind needs a feature name too, and is declared
//!   `#[serde(default, skip_serializing_if = ...)]`: a command that leaves it out serializes as
//!   it always did, so an older bridge, which refuses unknown fields, never sees it.
//! - A new VALUE of an existing enum field (a new [`DeviceKey`] or [`ElementTarget`] variant, say)
//!   counts as a new field: it needs a feature name too (as [`DeviceKey::Wakeup`] needs
//!   [`KEY_WAKEUP`]), and [`supports`] must check it. An older bridge cannot read the value, so
//!   without the check it would be handed a command it can only refuse.
//! - A new [`FailReason`] needs nothing: an older reader takes it as [`FailReason::Unknown`].
//! - A new field on an [`Observation`] needs no feature name: an observation ignores the fields
//!   it does not know (`jt_device_protocol`), so an older server drops it. It is an `Option`
//!   declared `#[serde(default, skip_serializing_if = "Option::is_none")]`, as `awake` and
//!   `locked` are: an older bridge's observation reads as one that does not say.
//!
//! # Logging
//!
//! A command's payload is typed text, shell arguments and screen text. Log
//! [`DeviceCommand::kind`] and counts, never the `{:?}` of a command or an observation.

mod command;
mod features;
mod lifecycle;
mod observation;

pub use command::{
    CommandError, DeviceCommand, DeviceKey, ElementTarget, MAX_APP_ID_CHARS, MAX_ARG_CHARS,
    MAX_LONG_PRESS_MS, MAX_PATH_CHARS, MAX_SCREEN_PX, MAX_SHELL_ARGS, MAX_SHELL_TOTAL_CHARS,
    MAX_SWIPE_MS, MAX_TEXT_CHARS, MAX_URL_CHARS,
};
pub use features::{KEY_WAKEUP, Platform, TEXT_UNICODE, required_features, supports};
pub use lifecycle::{
    CommandStatus, DEFAULT_EXPIRES_IN, FailReason, LifecycleError, LifecycleEvent, REDELIVER_AFTER,
    next_status,
};
pub use observation::{Element, MAX_ELEMENTS, Observation, Screen};
