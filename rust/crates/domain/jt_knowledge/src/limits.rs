//! The knowledge base's limits (design §4.2), the same as `0046_knowledge_base`'s checks.

use time::Duration;

/// A card's title, in characters (at least one).
pub const MAX_CARD_TITLE_CHARS: usize = 80;
/// A card's body, in characters.
pub const MAX_CARD_BODY_CHARS: usize = 8_000;
/// A card's attachments.
pub const MAX_CARD_ATTACHMENTS: usize = 10;
/// The live (not archived) cards of a workspace.
pub const MAX_LIVE_CARDS: usize = 50;
/// The prohibitions of the rules.
pub const MAX_PROHIBITIONS: usize = 100;
/// One prohibition, in characters.
pub const MAX_PROHIBITION_CHARS: usize = 500;
/// The goals.
pub const MAX_GOALS: usize = 20;
/// One goal, in characters.
pub const MAX_GOAL_CHARS: usize = 300;
/// A note's text, in characters (at least one).
pub const MAX_NOTE_TEXT_CHARS: usize = 4_000;
/// A note's links.
pub const MAX_NOTE_LINKS: usize = 10;
/// A note's files.
pub const MAX_NOTE_FILES: usize = 10;
/// One link (`https://` only), in characters.
pub const MAX_LINK_CHARS: usize = 2_048;
/// A link's title or a file's name on a card, in characters.
pub const MAX_ATTACHMENT_LABEL_CHARS: usize = 200;
/// A proposal's reason, in characters (at least one).
pub const MAX_PROPOSAL_REASON_CHARS: usize = 300;
/// A filed note's summary, in characters (at least one).
pub const MAX_SUMMARY_CHARS: usize = 300;
/// A dismissal's reason, in characters (at least one).
pub const MAX_DISMISS_REASON_CHARS: usize = 300;
/// The pending proposals of a workspace, the system's not counted.
pub const MAX_PENDING_PROPOSALS: usize = 20;
/// The proposals one agent connection makes in a day.
pub const MAX_PROPOSALS_PER_DAY: usize = 10;
/// The accounts whose posts wait for the owner by name.
pub const MAX_POST_APPROVAL_ACCOUNTS: usize = 200;
/// A cap's amount, in minor units.
pub const MAX_CAP_MINOR: i64 = 1_000_000_000_000;
/// How long an agent's claim of a note lasts.
pub const NOTE_CLAIM_LEASE: Duration = Duration::minutes(30);
/// How long an agent's proposal waits for the owner.
pub const AGENT_PROPOSAL_TTL: Duration = Duration::days(14);
/// How long a proposal the system made (the seeding, a re-sync) waits for the owner.
pub const SYSTEM_PROPOSAL_TTL: Duration = Duration::days(60);
/// The revisions one page of a card's history holds.
pub const HISTORY_PAGE: u32 = 50;
