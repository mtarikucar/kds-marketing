//! The bridges: programs on a machine of the tenant's (the PC the phone line or a phone is
//! plugged into) that register with Jeeta, take the commands queued for them and report what
//! they did, because the server never reaches that machine (spec
//! `2026-10-28-device-bridge-design.md` §2–3). The voice bridge (`usecases::calls::bridge`) is
//! the first. What every bridge does alike is the [`kernel`]'s: who may call as the bridge, its
//! heartbeat, the health job's marking it unreachable once it went silent, and waiting on what
//! it was signalled. What a bridge reports of itself, its queue and its events stay its own.

pub mod kernel;
