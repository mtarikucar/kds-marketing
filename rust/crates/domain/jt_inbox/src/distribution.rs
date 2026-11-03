//! Who owns a new journey (spec 2026-10-30-leads-pool-outreach-design.md §3.9): ordered rules,
//! the implicit default rule, round robin and least loaded. Pure: the application layer builds
//! the lead's facts and the candidates (memberships, rep profiles, working hours) and stores the
//! decision.

use jt_tenancy::UserId;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::{RuleId, Source};

/// A journey's acquisition source, as distribution rules name it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    /// Promoted from the prospect pool.
    Prospect,
    /// First contact through a messaging or telephone channel.
    Channel,
    /// A Meta lead ad.
    MetaAds,
    /// A submitted form.
    Form,
    /// An import, v1's included.
    Import,
    /// A returning customer's later journey.
    Repeat,
}

impl SourceKind {
    /// Every kind, in declaration order.
    pub const ALL: &'static [SourceKind] = &[
        SourceKind::Prospect,
        SourceKind::Channel,
        SourceKind::MetaAds,
        SourceKind::Form,
        SourceKind::Import,
        SourceKind::Repeat,
    ];

    /// The kind's stored name.
    pub fn key(self) -> &'static str {
        match self {
            SourceKind::Prospect => "prospect",
            SourceKind::Channel => "channel",
            SourceKind::MetaAds => "meta_ads",
            SourceKind::Form => "form",
            SourceKind::Import => "import",
            SourceKind::Repeat => "repeat",
        }
    }
}

/// The kind of an acquisition source; a v1 import is an import.
pub fn source_kind(s: &Source) -> SourceKind {
    match s {
        Source::Channel(_) => SourceKind::Channel,
        Source::MetaAds => SourceKind::MetaAds,
        Source::Import | Source::V1Import { .. } => SourceKind::Import,
        Source::Form => SourceKind::Form,
        Source::Repeat => SourceKind::Repeat,
        Source::Prospect { .. } => SourceKind::Prospect,
    }
}

/// When a rule applies. Every list empty means any; a fact the lead does not have never matches
/// a non-empty list (or a minimum score). Stored, so a missing field reads as empty.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Match {
    pub sources: Vec<SourceKind>,
    pub cities: Vec<String>,
    pub sectors: Vec<String>,
    pub languages: Vec<String>,
    pub segments: Vec<String>,
    pub min_score: Option<u8>,
}

/// The members a rule assigns to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MemberPool {
    /// Only these members (each still has to be eligible).
    Members { user_ids: Vec<UserId> },
    /// Every eligible member.
    AllEligible,
}

/// How a rule picks among its eligible members.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Method {
    /// The next member after the rule's cursor, in a stable order.
    RoundRobin,
    /// The member owning the fewest open journeys; ties by round robin.
    LeastLoaded,
}

impl Method {
    /// The method's stored name.
    pub fn key(self) -> &'static str {
        match self {
            Method::RoundRobin => "round_robin",
            Method::LeastLoaded => "least_loaded",
        }
    }

    /// The method a stored name names.
    pub fn parse(s: &str) -> Option<Method> {
        match s {
            "round_robin" => Some(Method::RoundRobin),
            "least_loaded" => Some(Method::LeastLoaded),
            _ => None,
        }
    }
}

/// One distribution rule; the workspace's rules apply in order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rule {
    pub id: RuleId,
    pub name: String,
    pub enabled: bool,
    pub when: Match,
    pub to: MemberPool,
    pub method: Method,
    /// Minutes, inside the owner's working hours, before an unacted assignment moves on.
    pub sla_minutes: Option<u32>,
    /// The member this rule assigned last; round robin continues after it.
    pub cursor: Option<UserId>,
}

/// Whether the implicit default rule (every eligible member, round robin) catches the journeys no
/// listed rule took. Off in the workspace's `manual` mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DefaultRule {
    /// No default rule: an unmatched journey waits for a manager.
    Off,
    /// The default rule, continuing after `cursor` (the member the latest `default` decision
    /// named).
    On { cursor: Option<UserId> },
}

/// What distribution knows about a journey's lead. An inbound journey usually knows only its
/// source.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LeadFacts {
    pub source: SourceKind,
    pub city: Option<String>,
    pub sector: Option<String>,
    pub segment: Option<String>,
    pub language: Option<String>,
    pub score: Option<u8>,
}

impl LeadFacts {
    /// Facts with only the source known.
    pub fn source_only(source: SourceKind) -> LeadFacts {
        LeadFacts {
            source,
            city: None,
            sector: None,
            segment: None,
            language: None,
            score: None,
        }
    }
}

/// A member distribution may assign to. `eligible` is the membership's verdict (active, holds
/// `inbox.work`, accepting, not away, under `max_open`); the lists are the rep's own filters
/// (empty = any).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub user_id: UserId,
    pub eligible: bool,
    pub on_shift: bool,
    pub open_owned: u32,
    pub languages: Vec<String>,
    pub cities: Vec<String>,
    pub sectors: Vec<String>,
}

/// Why a journey got (or did not get) its owner; each decision row names one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Cause {
    Rule,
    Default,
    Manual,
    SlaReassign,
    MemberLeft,
    Import,
    NoEligible,
}

impl Cause {
    /// Every cause, in declaration order.
    pub const ALL: &'static [Cause] = &[
        Cause::Rule,
        Cause::Default,
        Cause::Manual,
        Cause::SlaReassign,
        Cause::MemberLeft,
        Cause::Import,
        Cause::NoEligible,
    ];

    /// The cause's stored name.
    pub fn key(self) -> &'static str {
        match self {
            Cause::Rule => "rule",
            Cause::Default => "default",
            Cause::Manual => "manual",
            Cause::SlaReassign => "sla_reassign",
            Cause::MemberLeft => "member_left",
            Cause::Import => "import",
            Cause::NoEligible => "no_eligible",
        }
    }

    /// The cause a stored name names.
    pub fn parse(s: &str) -> Option<Cause> {
        Cause::ALL.iter().copied().find(|c| c.key() == s)
    }
}

/// The decision: the member (none when nobody is eligible), the rule that chose them (none for
/// the default rule), why, and the rule's SLA.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Choice {
    pub user_id: Option<UserId>,
    pub rule_id: Option<RuleId>,
    pub cause: Cause,
    pub sla_minutes: Option<u32>,
}

/// A member's distribution settings (`rep_profiles`); a member without a stored profile reads as
/// [`RepProfile::default_for`]. Stored, so a missing field reads as its default.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepProfile {
    pub user_id: UserId,
    #[serde(default = "yes")]
    pub accepting: bool,
    /// The most open journeys the member owns before new ones skip them, `1..=10000`.
    #[serde(default)]
    pub max_open: Option<u16>,
    #[serde(default)]
    pub languages: Vec<String>,
    #[serde(default)]
    pub cities: Vec<String>,
    #[serde(default)]
    pub sectors: Vec<String>,
    /// Working hours; none means always on shift and wall-clock SLA minutes.
    #[serde(default)]
    pub hours: Option<jt_capability::Hours>,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub away_until: Option<OffsetDateTime>,
    #[serde(default = "crate::epoch", with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

fn yes() -> bool {
    true
}

impl RepProfile {
    /// The profile of a member who never set one: accepting, no limit, no filters, no hours.
    pub fn default_for(user_id: UserId) -> RepProfile {
        RepProfile {
            user_id,
            accepting: true,
            max_open: None,
            languages: Vec::new(),
            cities: Vec::new(),
            sectors: Vec::new(),
            hours: None,
            away_until: None,
            updated_at: crate::epoch(),
        }
    }

    /// Whether the profile takes a new journey now: accepting, not away, under its limit. The
    /// membership's role is the caller's check.
    pub fn takes_new(&self, now: OffsetDateTime, open_owned: u32) -> bool {
        self.accepting
            && self.away_until.is_none_or(|until| until <= now)
            && self.max_open.is_none_or(|max| open_owned < u32::from(max))
    }
}

/// Whether a rule's `when` matches a lead. Text compares after a Turkish-aware fold (`İstanbul`
/// = `istanbul` = `ISTANBUL`).
pub fn rule_matches(m: &Match, facts: &LeadFacts) -> bool {
    (m.sources.is_empty() || m.sources.contains(&facts.source))
        && listed(&m.cities, facts.city.as_deref())
        && listed(&m.sectors, facts.sector.as_deref())
        && listed(&m.languages, facts.language.as_deref())
        && listed(&m.segments, facts.segment.as_deref())
        && m.min_score
            .is_none_or(|min| facts.score.is_some_and(|s| s >= min))
}

/// An empty list takes any value; a non-empty one only a known value it holds.
fn listed(list: &[String], fact: Option<&str>) -> bool {
    list.is_empty() || fact.is_some_and(|f| holds(list, f))
}

fn holds(list: &[String], value: &str) -> bool {
    let value = fold(value);
    list.iter().any(|v| fold(v) == value)
}

/// A rep's own filters take a lead whose fact is unknown: they narrow known facts only.
fn rep_takes(c: &Candidate, facts: &LeadFacts) -> bool {
    let known = |list: &[String], fact: &Option<String>| {
        list.is_empty() || fact.as_deref().is_none_or(|f| holds(list, f))
    };
    known(&c.languages, &facts.language)
        && known(&c.cities, &facts.city)
        && known(&c.sectors, &facts.sector)
}

/// Lower-case with `İ`/`I` handled the Turkish way, Turkish letters and circumflexes as their
/// plain Latin letters, combining marks dropped and spaces collapsed.
pub fn fold(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        let c = match c {
            'İ' => 'i',
            'I' => 'ı',
            c => c,
        };
        for l in c.to_lowercase() {
            if ('\u{0300}'..='\u{036f}').contains(&l) {
                continue;
            }
            out.push(match l {
                'ç' => 'c',
                'ğ' => 'g',
                'ı' => 'i',
                'ö' => 'o',
                'ş' => 's',
                'ü' => 'u',
                'â' => 'a',
                'î' => 'i',
                'û' => 'u',
                l => l,
            });
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Picks a journey's owner. For each enabled rule in order whose `when` matches: the eligible
/// candidates in its pool, not excluded, whose own filters take the lead; the members on shift
/// among them when any are; then the rule's method. A matching rule with nobody eligible falls
/// through to the next. After the rules, [`DefaultRule::On`] takes every eligible member by
/// round robin. Nobody → `NoEligible`.
pub fn choose(
    rules: &[Rule],
    default_rule: DefaultRule,
    facts: &LeadFacts,
    candidates: &[Candidate],
    exclude: &[UserId],
) -> Choice {
    let open = |c: &&Candidate| c.eligible && !exclude.contains(&c.user_id) && rep_takes(c, facts);
    for rule in rules.iter().filter(|r| r.enabled) {
        if !rule_matches(&rule.when, facts) {
            continue;
        }
        let pool: Vec<&Candidate> = candidates
            .iter()
            .filter(open)
            .filter(|c| match &rule.to {
                MemberPool::Members { user_ids } => user_ids.contains(&c.user_id),
                MemberPool::AllEligible => true,
            })
            .collect();
        if let Some(user) = pick(&pool, rule.method, rule.cursor) {
            return Choice {
                user_id: Some(user),
                rule_id: Some(rule.id),
                cause: Cause::Rule,
                sla_minutes: rule.sla_minutes,
            };
        }
    }
    if let DefaultRule::On { cursor } = default_rule {
        let pool: Vec<&Candidate> = candidates.iter().filter(open).collect();
        if let Some(user) = pick(&pool, Method::RoundRobin, cursor) {
            return Choice {
                user_id: Some(user),
                rule_id: None,
                cause: Cause::Default,
                sla_minutes: None,
            };
        }
    }
    Choice {
        user_id: None,
        rule_id: None,
        cause: Cause::NoEligible,
        sla_minutes: None,
    }
}

/// On-shift members first when any are; then the method over them.
fn pick(pool: &[&Candidate], method: Method, cursor: Option<UserId>) -> Option<UserId> {
    let on_shift: Vec<&Candidate> = pool.iter().copied().filter(|c| c.on_shift).collect();
    let pool = if on_shift.is_empty() {
        pool.to_vec()
    } else {
        on_shift
    };
    let order = round_robin(&pool, cursor);
    match method {
        Method::RoundRobin => order.first().map(|c| c.user_id),
        Method::LeastLoaded => {
            let least = order.iter().map(|c| c.open_owned).min()?;
            order
                .iter()
                .find(|c| c.open_owned == least)
                .map(|c| c.user_id)
        }
    }
}

/// The pool in round-robin order: the user ids after `cursor` in byte order, then the rest from
/// the smallest (wrapping).
fn round_robin<'a>(pool: &[&'a Candidate], cursor: Option<UserId>) -> Vec<&'a Candidate> {
    let mut sorted = pool.to_vec();
    sorted.sort_by_key(|c| c.user_id);
    sorted.dedup_by_key(|c| c.user_id);
    let split = cursor.map_or(0, |cur| sorted.partition_point(|c| c.user_id <= cur));
    sorted.rotate_left(split);
    sorted
}
