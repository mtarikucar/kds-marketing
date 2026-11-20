//! The effective post gate (design 2026-11-19 "Paylaşımlar and Bilgi bankası" §3.10.1, D1):
//! which person's step a **post** on an account waits for.
//!
//! Post approval is the knowledge base's: the Kurallar switch (`post_approval`, every post waits)
//! and the list of accounts whose posts wait while it is off (`post_approval_accounts`). TikTok
//! always needs its posting screen. Once a workspace's gate is seeded (`post_gate_seeded_at`, the
//! accounts' stored flags copied into the list) the capability's stored
//! `requires_human_approval` is never read for posts, so an agent's `capability.set_policy` can no
//! longer lower a post approval. Before that (a workspace not seeded yet) the stored flag is the
//! gate, so nothing is released early.
//!
//! Every **posting** path reads it: `schedule::human_gate`, the pipeline's approval facts,
//! `studio.pending`'s slot approvals, the execution permit of a slot and the accounts' reads.
//! Paid-lane paths (ad budget moves) and the inbox (comment replies) keep the stored flag: the
//! switch and the list are about posts only.

use jt_capability::Capability;
use jt_knowledge::KnowledgeSettings;

use super::schedule::HumanGate;
use crate::error::AppError;
use crate::ports::TenantRepos;

/// The person's step a post on `c` waits for under the knowledge base `k` (none before seeding):
/// TikTok's posting screen whatever the rules say; else an approval when the switch is on or
/// the account is in the list; else none. Before the gate is seeded, the stored flag.
pub(crate) fn post_gate(c: &Capability, k: Option<&KnowledgeSettings>) -> Option<HumanGate> {
    if jt_studio::requires_posting_screen(&c.kind_key) {
        return Some(HumanGate::PostingScreen);
    }
    let approval = match k.filter(|k| k.post_gate_seeded_at.is_some()) {
        Some(k) => k.post_approval || k.post_approval_accounts.contains(&c.id.as_uuid()),
        None => c.policy.requires_human_approval,
    };
    approval.then_some(HumanGate::Approval)
}

/// Whether a post on `c` waits for a person's approval (not TikTok's screen, which has its own
/// check) under `k`.
pub(crate) fn needs_approval(c: &Capability, k: Option<&KnowledgeSettings>) -> bool {
    post_gate(c, k) == Some(HumanGate::Approval)
}

/// The knowledge base's settings the gate reads, without a lock (none before seeding).
pub(crate) async fn rules(r: &mut dyn TenantRepos) -> Result<Option<KnowledgeSettings>, AppError> {
    r.knowledge().settings().await
}
