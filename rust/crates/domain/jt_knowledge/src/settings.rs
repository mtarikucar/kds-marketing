//! The knowledge base's one row per workspace: its revisions, its rules and goals, the caps and
//! the post approval the system enforces, and what the frame was last derived from.

use jt_strategy::{HypothesisId, Period};
use jt_tenancy::{UserId, WorkspaceId};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::Invalid;
use crate::limits::{
    MAX_CAP_MINOR, MAX_GOAL_CHARS, MAX_GOALS, MAX_PROHIBITION_CHARS, MAX_PROHIBITIONS,
};
use crate::text::validate_lines;

/// Where a workspace's knowledge base came from when it was seeded (design §4.3.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SeedSource {
    /// The strategy version in force: the cards carry its texts, the rules its caps.
    Approved,
    /// A draft that was never approved: blank cards, and its texts wait as proposals.
    Draft,
    /// Nothing (or only an archived version, whose texts wait as proposals): blank cards.
    Empty,
}

impl SeedSource {
    /// The stable key, e.g. `"approved"`.
    pub fn key(&self) -> &'static str {
        match self {
            SeedSource::Approved => "approved",
            SeedSource::Draft => "draft",
            SeedSource::Empty => "empty",
        }
    }

    /// The source with this key, if any.
    pub fn parse(key: &str) -> Option<SeedSource> {
        match key {
            "approved" => Some(SeedSource::Approved),
            "draft" => Some(SeedSource::Draft),
            "empty" => Some(SeedSource::Empty),
            _ => None,
        }
    }
}

/// A spending ceiling of the rules: at most `amount_minor` (in minor units of `currency`, kuruş
/// for `TRY`) per `period`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cap {
    pub amount_minor: i64,
    #[serde(default)]
    pub period: Period,
    #[serde(default = "default_currency")]
    pub currency: String,
}

/// The currency a cap without one reads as.
fn default_currency() -> String {
    "TRY".to_owned()
}

/// A ceiling as a person writes it: the amount, and the period (none: the one in force, else
/// monthly). The currency is not written: it is the budget's own.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapInput {
    pub amount_minor: i64,
    #[serde(default)]
    pub period: Option<Period>,
}

/// `Ok` when `input`'s amount is `0..=`[`MAX_CAP_MINOR`]; else `out_of_range` naming
/// `{field}.amount_minor`.
pub fn validate_cap(field: &str, input: &CapInput) -> Result<(), Invalid> {
    if !(0..=MAX_CAP_MINOR).contains(&input.amount_minor) {
        return Err(Invalid::new(
            format!("{field}.amount_minor"),
            "out_of_range",
            format!("an amount is 0 to {MAX_CAP_MINOR} minor units"),
        ));
    }
    Ok(())
}

/// The prohibitions as written ([`validate_lines`] over `prohibitions`): at most
/// [`MAX_PROHIBITIONS`] of at most [`MAX_PROHIBITION_CHARS`] characters.
pub fn validate_prohibitions(field: &str, raw: &[String]) -> Result<Vec<String>, Invalid> {
    validate_lines(field, raw, MAX_PROHIBITIONS, MAX_PROHIBITION_CHARS)
}

/// The goals as written ([`validate_lines`]): at most [`MAX_GOALS`] of at most
/// [`MAX_GOAL_CHARS`] characters.
pub fn validate_goals(field: &str, raw: &[String]) -> Result<Vec<String>, Invalid> {
    validate_lines(field, raw, MAX_GOALS, MAX_GOAL_CHARS)
}

/// Appends to `lines` each of `new` it does not hold yet (compared as written, trimmed), in
/// order, and answers those appended; `too_many` naming `field` when the result would hold more
/// than `max`, and then `lines` is left as it was.
pub fn append_lines(
    field: &str,
    lines: &mut Vec<String>,
    new: &[String],
    max: usize,
) -> Result<Vec<String>, Invalid> {
    let mut added: Vec<String> = Vec::new();
    for line in new {
        let line = line.trim();
        if line.is_empty() || lines.iter().any(|l| l == line) || added.iter().any(|l| l == line) {
            continue;
        }
        added.push(line.to_owned());
    }
    if lines.len() + added.len() > max {
        return Err(Invalid::new(
            field,
            "too_many",
            format!("at most {max} lines, got {}", lines.len() + added.len()),
        ));
    }
    lines.extend(added.iter().cloned());
    Ok(added)
}

/// One workspace's knowledge base settings (`knowledge_settings`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnowledgeSettings {
    pub workspace_id: WorkspaceId,
    /// +1 on every knowledge change (one per transaction).
    pub revision: u64,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub changed_at: Option<OffsetDateTime>,
    /// The person whose change it was (for an agent's filing, the note's person).
    #[serde(default)]
    pub changed_by: Option<UserId>,
    /// The revision of the last change of a card the posting part is derived from.
    #[serde(default)]
    pub posting_revision: u64,
    /// The revision of the last change of a card the prospecting part is derived from.
    #[serde(default)]
    pub prospecting_revision: u64,
    /// The revision the posting part of the frame was last derived from.
    #[serde(default)]
    pub posting_derived: u64,
    /// The revision the prospecting part of the frame was last derived from.
    #[serde(default)]
    pub prospecting_derived: u64,
    /// "Yasaklar": instructions every agent reads, never checked by the server.
    #[serde(default)]
    pub prohibitions: Vec<String>,
    /// "Hedefler", one line each.
    #[serde(default)]
    pub goals: Vec<String>,
    /// The ad budget's ceiling; none: no ads.
    #[serde(default)]
    pub ad_cap: Option<Cap>,
    /// The paid messages' limit (SMS, metered sends); none: no limit of its own.
    #[serde(default)]
    pub message_cap: Option<Cap>,
    /// "Her paylaşım onayıma gelsin": every post waits for the owner.
    #[serde(default)]
    pub post_approval: bool,
    /// The social accounts (capability ids) whose posts wait for the owner while the switch is
    /// off.
    #[serde(default)]
    pub post_approval_accounts: Vec<Uuid>,
    /// When the accounts' stored approval flags were copied into the list.
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub post_gate_seeded_at: Option<OffsetDateTime>,
    /// Topics a derivation left out, kept for the posts that still name them.
    #[serde(default)]
    pub closing_topic_ids: Vec<HypothesisId>,
    /// 1 when seeded, +1 at every change of the rules.
    pub rules_revision: u64,
    /// 1 when seeded, +1 at every change of the goals.
    pub goals_revision: u64,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub frame_applied_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339")]
    pub seeded_at: OffsetDateTime,
    pub seed_source: SeedSource,
    /// The inbox's automatic replies (`0047_inbox_auto_reply`); none: never set up, off.
    #[serde(default)]
    pub auto_reply: Option<AutoReply>,
}

impl KnowledgeSettings {
    /// The settings a workspace is seeded with from `source` at `now`: nothing changed yet,
    /// nothing derived, no rules, no goals, no caps, no approval.
    pub fn new(ws: WorkspaceId, source: SeedSource, now: OffsetDateTime) -> KnowledgeSettings {
        KnowledgeSettings {
            workspace_id: ws,
            revision: 0,
            changed_at: None,
            changed_by: None,
            posting_revision: 0,
            prospecting_revision: 0,
            posting_derived: 0,
            prospecting_derived: 0,
            prohibitions: Vec::new(),
            goals: Vec::new(),
            ad_cap: None,
            message_cap: None,
            post_approval: false,
            post_approval_accounts: Vec::new(),
            post_gate_seeded_at: None,
            closing_topic_ids: Vec::new(),
            rules_revision: 1,
            goals_revision: 1,
            frame_applied_at: None,
            seeded_at: now,
            seed_source: source,
            auto_reply: None,
        }
    }

    /// What a `rules` revision row keeps: the whole rules box.
    pub fn rules_content(&self) -> Value {
        let mut out = json!({
            "prohibitions": self.prohibitions,
            "ad_cap": self.ad_cap,
            "message_cap": self.message_cap,
            "post_approval": self.post_approval,
            "post_approval_accounts": self.post_approval_accounts,
        });
        // The automatic replies, once set up (a box that never had them reads as before).
        if let Some(auto) = &self.auto_reply {
            out["auto_reply"] = json!(auto);
        }
        out
    }

    /// What a `goals` revision row keeps: the goals.
    pub fn goals_content(&self) -> Value {
        json!({ "items": self.goals })
    }

    /// Whether a card change made after the posting part was last derived waits for a
    /// derivation.
    pub fn posting_due(&self) -> bool {
        self.posting_revision > self.posting_derived
    }

    /// Whether a card change made after the prospecting part was last derived waits for one.
    pub fn prospecting_due(&self) -> bool {
        self.prospecting_revision > self.prospecting_derived
    }
}

/// The capability kinds whose conversations the automatic replies may answer.
pub const AUTO_REPLY_KINDS: &[&str] = &["whatsapp_cloud"];
/// The most capabilities the automatic replies may be on for.
pub const MAX_AUTO_REPLY_CAPABILITIES: usize = 10;
/// How many days an automatic quote stays valid.
pub const AUTO_QUOTE_VALID_DAYS: u32 = 7;
/// The key and the title of the card the owner writes the standard work and its pricing in; the
/// rules create it the first time the automatic replies are turned on.
pub const REPLY_STANDARD: (&str, &str) = ("reply_standard", "Standart iş ve fiyat");

/// The owner's price range for automatic quotes, in minor units of `currency` (both ends
/// included). The currency is the workspace's, never the model's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PriceRange {
    pub min_minor: i64,
    pub max_minor: i64,
    #[serde(default = "default_currency")]
    pub currency: String,
}

/// The inbox's automatic replies as stored (`knowledge_settings.auto_reply`): the capabilities
/// they answer on (empty: off), the price range of their quotes and how long a quote is valid.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutoReply {
    #[serde(default)]
    pub capability_ids: Vec<Uuid>,
    #[serde(default)]
    pub price: Option<PriceRange>,
    #[serde(default = "default_valid_days")]
    pub quote_valid_days: u32,
    /// When each listed capability was last turned on: the job's sweep never answers a message
    /// from before.
    #[serde(default)]
    pub enabled_at: std::collections::BTreeMap<Uuid, OffsetDateTime>,
    /// Whether the owner is told by email of a hand-over or an order (`usecases::inbox::notices`):
    /// `Some(false)` only when turned off; none is on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notify_email: Option<bool>,
    /// The discount the automatic replies may give when a customer bargains, in percent of the
    /// journey's first automatic quote: the preferred step, then the largest (both 0: none).
    /// Read leniently: a stored value that is not a whole percent within range reads as 0.
    #[serde(
        default,
        skip_serializing_if = "is_zero",
        deserialize_with = "lenient_pct"
    )]
    pub discount_preferred_pct: u8,
    #[serde(
        default,
        skip_serializing_if = "is_zero",
        deserialize_with = "lenient_pct"
    )]
    pub discount_max_pct: u8,
}

fn is_zero(n: &u8) -> bool {
    *n == 0
}

/// A stored discount percent: a whole number from 0 to [`MAX_DISCOUNT_PCT`], else `u8::MAX`
/// (never an error: a bad row must not break reading the settings; [`AutoReply::discount`] then
/// gives no discount).
fn lenient_pct<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u8, D::Error> {
    let value = serde_json::Value::deserialize(d)?;
    Ok(value
        .as_u64()
        .filter(|n| *n <= u64::from(MAX_DISCOUNT_PCT))
        .map_or(u8::MAX, |n| n as u8))
}

/// The largest discount the automatic replies may be allowed, in percent.
pub const MAX_DISCOUNT_PCT: u8 = 50;

fn default_valid_days() -> u32 {
    AUTO_QUOTE_VALID_DAYS
}

impl AutoReply {
    /// Whether the replies are on for capability `id`.
    pub fn serves(&self, id: Uuid) -> bool {
        self.capability_ids.contains(&id)
    }

    /// The bargaining discount in force: (preferred, largest) percent, or (0, 0), off, for a
    /// stored pair that breaks the rules (a value out of range or not a whole number, the
    /// preferred above the largest).
    pub fn discount(&self) -> (u8, u8) {
        if self.discount_preferred_pct > self.discount_max_pct
            || self.discount_max_pct > MAX_DISCOUNT_PCT
        {
            (0, 0)
        } else {
            (self.discount_preferred_pct, self.discount_max_pct)
        }
    }

    /// Whether the owner's email notices are on (they are unless turned off).
    pub fn notifies(&self) -> bool {
        self.notify_email != Some(false)
    }
}

/// The automatic replies as a person writes them: the capabilities, and the range (required while
/// any capability is listed and none is stored; none keeps the one stored).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AutoReplyInput {
    pub capability_ids: Vec<Uuid>,
    #[serde(default)]
    pub min_minor: Option<i64>,
    #[serde(default)]
    pub max_minor: Option<i64>,
    /// The owner's email notices on or off; none keeps the stored setting.
    #[serde(default)]
    pub notify_email: Option<bool>,
    /// The preferred and the largest bargaining discount, in percent (`0..=`
    /// [`MAX_DISCOUNT_PCT`], preferred at most the largest); none keeps the stored ones.
    #[serde(default)]
    pub discount_preferred_pct: Option<u8>,
    #[serde(default)]
    pub discount_max_pct: Option<u8>,
}

/// The bargaining discount `input` sets, over `stored` (preferred, largest): each at most
/// [`MAX_DISCOUNT_PCT`], the preferred at most the largest.
pub fn validate_discount(input: &AutoReplyInput, stored: (u8, u8)) -> Result<(u8, u8), Invalid> {
    let preferred = input.discount_preferred_pct.unwrap_or(stored.0);
    let max = input.discount_max_pct.unwrap_or(stored.1);
    for (field, pct) in [
        ("auto_reply.discount_preferred_pct", preferred),
        ("auto_reply.discount_max_pct", max),
    ] {
        if pct > MAX_DISCOUNT_PCT {
            return Err(Invalid::new(
                field,
                "out_of_range",
                format!("a discount is 0 to {MAX_DISCOUNT_PCT} percent"),
            ));
        }
    }
    if preferred > max {
        return Err(Invalid::new(
            "auto_reply.discount_preferred_pct",
            "out_of_range",
            "the preferred discount is at most the largest",
        ));
    }
    Ok((preferred, max))
}

/// `Ok` with the range `input` gives (none when it gives none): `0 < min <= max <=`
/// [`MAX_CAP_MINOR`], both ends or neither, and one whenever a capability is listed and `stored`
/// has none; at most [`MAX_AUTO_REPLY_CAPABILITIES`] capabilities, none twice. The capabilities'
/// kinds are the caller's to check.
pub fn validate_auto_reply(
    input: &AutoReplyInput,
    stored: Option<&PriceRange>,
) -> Result<Option<(i64, i64)>, Invalid> {
    if input.capability_ids.len() > MAX_AUTO_REPLY_CAPABILITIES {
        return Err(Invalid::new(
            "auto_reply.capability_ids",
            "too_many",
            format!("at most {MAX_AUTO_REPLY_CAPABILITIES} capabilities"),
        ));
    }
    for (i, id) in input.capability_ids.iter().enumerate() {
        if input.capability_ids[..i].contains(id) {
            return Err(Invalid::new(
                format!("auto_reply.capability_ids[{i}]"),
                "duplicate",
                "a capability is listed once",
            ));
        }
    }
    let range = match (input.min_minor, input.max_minor) {
        (None, None) => None,
        (Some(min), Some(max)) => {
            if !(min > 0 && min <= max && max <= MAX_CAP_MINOR) {
                return Err(Invalid::new(
                    "auto_reply.min_minor",
                    "out_of_range",
                    format!("0 < min <= max <= {MAX_CAP_MINOR} minor units"),
                ));
            }
            Some((min, max))
        }
        _ => {
            return Err(Invalid::new(
                "auto_reply.max_minor",
                "required",
                "the range has both ends",
            ));
        }
    };
    if !input.capability_ids.is_empty() && range.is_none() && stored.is_none() {
        return Err(Invalid::new(
            "auto_reply.min_minor",
            "required",
            "the automatic replies need a price range",
        ));
    }
    Ok(range)
}

#[cfg(test)]
mod auto_reply_tests {
    use super::*;

    fn input(ids: usize, min: Option<i64>, max: Option<i64>) -> AutoReplyInput {
        AutoReplyInput {
            capability_ids: (0..ids).map(|_| Uuid::now_v7()).collect(),
            min_minor: min,
            max_minor: max,
            notify_email: None,
            discount_preferred_pct: None,
            discount_max_pct: None,
        }
    }

    #[test]
    fn a_bad_stored_discount_reads_as_none_and_never_breaks_the_read() {
        let read = |extra: serde_json::Value| -> AutoReply {
            let mut v = json!({"capability_ids": [], "quote_valid_days": 7});
            for (k, x) in extra.as_object().unwrap() {
                v[k] = x.clone();
            }
            serde_json::from_value(v).unwrap()
        };
        for bad in [
            json!({"discount_preferred_pct": 60, "discount_max_pct": 10}),
            json!({"discount_preferred_pct": 5, "discount_max_pct": 51}),
            json!({"discount_preferred_pct": -1, "discount_max_pct": 10}),
            json!({"discount_preferred_pct": 5.5, "discount_max_pct": 10}),
            json!({"discount_preferred_pct": "5", "discount_max_pct": 10}),
            json!({"discount_preferred_pct": 15, "discount_max_pct": 10}),
        ] {
            assert_eq!(read(bad.clone()).discount(), (0, 0), "{bad}");
        }
        assert_eq!(
            read(json!({"discount_preferred_pct": 5, "discount_max_pct": 10})).discount(),
            (5, 10)
        );
        assert_eq!(read(json!({})).discount(), (0, 0));
    }

    fn reason(input: &AutoReplyInput) -> &'static str {
        validate_auto_reply(input, None).unwrap_err().reason
    }

    #[test]
    fn the_range_is_positive_ordered_and_needed_while_on() {
        assert_eq!(
            validate_auto_reply(&input(1, Some(100), Some(200)), None),
            Ok(Some((100, 200)))
        );
        assert_eq!(validate_auto_reply(&input(0, None, None), None), Ok(None));
        for (min, max) in [(0, 10), (20, 10), (1, MAX_CAP_MINOR + 1)] {
            assert_eq!(reason(&input(1, Some(min), Some(max))), "out_of_range");
        }
        assert_eq!(reason(&input(1, None, None)), "required");
        assert_eq!(reason(&input(1, Some(5), None)), "required");
        let stored = PriceRange {
            min_minor: 1,
            max_minor: 2,
            currency: "TRY".into(),
        };
        assert_eq!(
            validate_auto_reply(&input(1, None, None), Some(&stored)),
            Ok(None)
        );
    }

    #[test]
    fn a_capability_is_listed_once_and_the_list_is_bounded() {
        let id = Uuid::now_v7();
        let twice = AutoReplyInput {
            capability_ids: vec![id, id],
            min_minor: Some(1),
            max_minor: Some(2),
            notify_email: None,
            discount_preferred_pct: None,
            discount_max_pct: None,
        };
        assert_eq!(reason(&twice), "duplicate");
        assert_eq!(
            reason(&input(MAX_AUTO_REPLY_CAPABILITIES + 1, Some(1), Some(2))),
            "too_many"
        );
    }

    #[test]
    fn settings_stored_before_the_column_read_as_off() {
        let s = KnowledgeSettings::new(
            WorkspaceId::new_v7(),
            SeedSource::Empty,
            OffsetDateTime::UNIX_EPOCH,
        );
        let mut v = serde_json::to_value(&s).unwrap();
        v.as_object_mut().unwrap().remove("auto_reply");
        let back: KnowledgeSettings = serde_json::from_value(v).unwrap();
        assert_eq!(back.auto_reply, None);
        let stored: AutoReply =
            serde_json::from_value(json!({"capability_ids": [], "price": null})).unwrap();
        assert_eq!(stored.quote_valid_days, AUTO_QUOTE_VALID_DAYS);
    }
}
