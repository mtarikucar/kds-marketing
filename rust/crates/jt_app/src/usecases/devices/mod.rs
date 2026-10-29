//! The workspace's phones (spec `2026-10-28-device-bridge-design.md`): a phone plugged into a PC is
//! a `phone` capability, kept alive by the device bridge on that PC ([`bridge`], the bridge's own
//! surface), which takes the commands queued for the phone and reports what each did. An agent,
//! or a person in the panel, queues those commands and reads what came of them ([`agent`]). The
//! commands and the files the bridges upload are stored per tenant (`ports::devices`); scheduled
//! jobs end the commands past their time limit and delete the files past their retention
//! ([`sweeps`]), and mark unreachable a phone no bridge listed for ten minutes (the bridge
//! kernel's health check).
//!
//! A command carries typed text and shell arguments, and its result screen text and output: they
//! go to the ledger (the owner's audit log), never to `tracing`, which logs ids, kinds, statuses
//! and counts only (spec §5.5).

pub mod agent;
pub mod bridge;
pub mod sweeps;
pub mod uploads;

use jt_tenancy::WorkspaceId;

use crate::ports::bridges::SignalKey;

/// The kind of a phone's capability.
pub const PHONE_KIND: &str = "phone";
/// The topic of the devices' signals ([`signal_key`]).
const SIGNAL_TOPIC: &str = "devices";

/// What the long-polls on workspace `ws`'s phones watch (the bridges' commands, and what waits on
/// a command's result), signalled once a command was queued or ended.
pub fn signal_key(ws: WorkspaceId) -> SignalKey {
    SignalKey {
        workspace_id: ws,
        topic: SIGNAL_TOPIC,
    }
}
