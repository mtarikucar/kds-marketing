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
//! file, a failure's detail, a phone number or a signed address; an HTTP error is logged without
//! its URL.

pub mod client;
pub mod config;
pub mod driver;
pub mod run_loop;

pub use client::{ClientError, JeetaClient};
pub use config::{BridgeKey, Config, ConfigError};
pub use driver::{AttachedPhone, DriverError, FileTransfer, PhoneDriver, PhoneRegistry};
pub use run_loop::{Timing, run};
