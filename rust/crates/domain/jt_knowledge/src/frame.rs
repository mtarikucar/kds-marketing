//! The internal frame (design §4.10): the strategy version every Studio, research and outreach row
//! points at, applied by the system from what the knowledge base says. The owner never sees it.
//!
//! [`merge`] builds the next frame from the one in force and what a call brings
//! ([`FrameParts`]), for one [`FrameCause`]:
//!
//! - the **system fields** come from the knowledge base every time ([`system_sections`]): the
//!   identity mirrored from the cards (D34), the goals' lines as KPIs, the prohibitions, the
//!   channels `[any]`, the budget lanes from the rules' caps, and the cadence without a mix;
//! - the **topics** (hypotheses) keep their ids: given, else matched by title, else new; a topic
//!   left out stays live as a *closing* topic while a post, a binding, a budget move or an ad
//!   still names it, keeping what those use (D9), and is retired once nothing does;
//! - the **audience** keeps every segment a live row still names (`kept_segments`, D36);
//! - only what the call brought is validated (D36): inherited, retained and carried content
//!   never is, and the owner's request is outside every topic check.
//!
//! [`structural`] is what decides whether a frame changed: texts (identity, objective, segment
//! names, topic titles and angles) never make a version on their own (D34).
//!
//! Pure, no I/O: the use case (`jt_app::usecases::knowledge::frame`) reads the facts and writes
//! the version.

use std::collections::{BTreeMap, BTreeSet};

use jt_strategy::{
    ANY_CHANNEL, Cadence, ChannelChoice, ContentTypeShare, Gap, Hypothesis, HypothesisCadence,
    HypothesisId, HypothesisState, IcpEntry, Identity, Kpi, Lane, LaneKind, Period, Rubric,
    Sections, Segment, validate_sections, validate_segment_key,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::card::Card;
use crate::settings::KnowledgeSettings;
use crate::text::{cut, one_line};

/// The content type of a topic that posts without naming its own types.
pub const DEFAULT_CONTENT_TYPE: &str = "general";
/// Posts a week of a frame written without a previous one.
pub const DEFAULT_PER_WEEK: u16 = 3;
/// The most topics one derivation sends.
pub const MAX_TOPICS: usize = 30;
/// The longest identity text, objective or segment description a frame keeps, in characters
/// (the strategy's own section limit).
pub const MAX_FRAME_TEXT_CHARS: usize = 2_000;
/// The longest topic angle the bootstrap writes, in characters.
pub const MAX_BOOTSTRAP_ANGLE_CHARS: usize = 500;
/// The key the bootstrap topic's id is derived from (`stable_id(ws, key)`).
pub const BOOTSTRAP_TOPIC_KEY: &str = "strategy.hypothesis:knowledge_base";
/// The bootstrap frame's one segment: `(key, name)`.
pub const BOOTSTRAP_SEGMENT: (&str, &str) = ("genel", "Genel");
/// The bootstrap topic's title.
pub const BOOTSTRAP_TITLE: &str = "Genel";
/// The bootstrap topic's angle when `post_ideas` has no text.
pub const BOOTSTRAP_ANGLE: &str = "İşletmeyi tanıtan paylaşımlar";
/// The bootstrap topic's metric.
pub const BOOTSTRAP_METRIC: &str = "Etkileşim";
/// The prior confidence of a topic sent without one.
pub const DEFAULT_PRIOR: f32 = 0.5;

/// The organic cadence a live topic gets when it has no usable one: it posts `per_week` times a
/// week, with one content type ([`DEFAULT_CONTENT_TYPE`]). The posting engine takes a post only
/// for a topic with an organic cadence (design 2026-11-10 B53).
pub fn default_organic_cadence(per_week: u16) -> HypothesisCadence {
    HypothesisCadence {
        slots_per_week: per_week,
        exploration_bps: 0,
        content_types: vec![ContentTypeShare {
            key: DEFAULT_CONTENT_TYPE.into(),
            min_bps: 0,
            max_bps: 10_000,
        }],
    }
}

/// Why a frame is applied (design §4.10.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FrameCause {
    /// An agent's derivation from the cards (`jeeta.strategy.frame_apply`).
    Derive,
    /// The first card text of a workspace without a frame.
    Bootstrap,
    /// The rules' caps, mirrored into the lanes.
    Rules,
    /// `knowledge_settle`: the system fields brought to what the knowledge base says.
    Normalize,
    /// `knowledge_settle`: closing topics nothing names any more, retired.
    Close,
}

impl FrameCause {
    /// The stable key, e.g. `"normalize"`.
    pub fn key(&self) -> &'static str {
        match self {
            FrameCause::Derive => "derive",
            FrameCause::Bootstrap => "bootstrap",
            FrameCause::Rules => "rules",
            FrameCause::Normalize => "normalize",
            FrameCause::Close => "close",
        }
    }

    /// Whether the system applies it (every cause but an agent's derivation).
    pub fn is_system(&self) -> bool {
        !matches!(self, FrameCause::Derive)
    }
}

/// A derivation an agent answers (design §4.10.4).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DerivePart {
    /// The audience, the objective and the topics, from the posting cards.
    Posting,
    /// The ICP and the rubric, from the prospecting cards.
    Prospecting,
}

impl DerivePart {
    /// The stable key, e.g. `"posting"`.
    pub fn key(&self) -> &'static str {
        match self {
            DerivePart::Posting => "posting",
            DerivePart::Prospecting => "prospecting",
        }
    }
}

/// A topic as a derivation sends it: no channel (always `any`) and no state.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TopicInput {
    /// A topic to keep (an id of `knowledge_get.frame.topics`); none: matched by title, else new.
    #[serde(default)]
    pub id: Option<HypothesisId>,
    pub title: String,
    pub segment_key: String,
    pub angle: String,
    pub metric: String,
    #[serde(default)]
    pub prior_confidence: Option<f32>,
    /// Organic only; the paid cadence is set with [`FrameParts::paid_cadence`].
    #[serde(default)]
    pub cadence: Option<BTreeMap<LaneKind, HypothesisCadence>>,
}

/// The prospecting part of a derivation.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProspectingInput {
    pub icp: Vec<IcpEntry>,
    pub rubric: Rubric,
    /// New audience segments its entries name.
    #[serde(default)]
    pub segments: Vec<Segment>,
}

/// One topic's paid cadence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PaidCadence {
    pub topic_id: HypothesisId,
    pub cadence: HypothesisCadence,
}

/// What a call brings to a frame: nothing for the system's causes, what an agent derived for a
/// derivation.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FrameParts {
    /// The knowledge revision the derivation read.
    pub kb_revision: u64,
    /// The derivations it answers; a part listed with none of its fields is "unchanged".
    pub parts: Vec<DerivePart>,
    pub audience: Option<Vec<Segment>>,
    pub objective: Option<String>,
    pub topics: Option<Vec<TopicInput>>,
    pub prospecting: Option<ProspectingInput>,
    pub paid_cadence: Option<Vec<PaidCadence>>,
}

/// The frame in force a merge starts from.
#[derive(Clone, Copy, Debug)]
pub struct Base<'a> {
    pub sections: &'a Sections,
    /// The version's hypotheses in order, retired ones and the owner's request included.
    pub hypotheses: &'a [Hypothesis],
}

/// What the knowledge base gives every frame.
#[derive(Clone, Copy, Debug)]
pub struct Knowledge<'a> {
    /// Every card, removed ones too (only live ones are read).
    pub cards: &'a [Card],
    pub settings: &'a KnowledgeSettings,
    /// The workspace's name: the product's last fallback.
    pub workspace_name: &'a str,
}

/// The topics a planned or ready post, a binding, a queued budget move or an ad of a campaign
/// not ended names, with the content types those use, per lane.
pub type Retained = BTreeMap<HypothesisId, BTreeMap<LaneKind, BTreeSet<String>>>;

/// Everything a merge reads.
#[derive(Clone, Copy, Debug)]
pub struct MergeInput<'a> {
    pub cause: FrameCause,
    /// None before a workspace's first frame (the bootstrap).
    pub base: Option<Base<'a>>,
    pub next: &'a FrameParts,
    pub knowledge: Knowledge<'a>,
    pub retained: &'a Retained,
    /// Every hypothesis id any version of the workspace holds: a given id must be one.
    pub known_ids: &'a BTreeSet<HypothesisId>,
    /// The owner's request's id (never a topic).
    pub owner_request: HypothesisId,
    /// The bootstrap topic's id.
    pub bootstrap_id: HypothesisId,
    /// Retire the closing topics nothing names any more (`normalize` and `close`).
    pub retire_closing: bool,
}

/// Why a merge refused what a derivation sent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// What was sent is incomplete or inconsistent: every gap, named by the input's path.
    Gaps(Vec<Gap>),
    /// A topic named the owner's request (`topics[i].id`).
    Reserved(String),
}

/// The next frame.
#[derive(Clone, Debug, PartialEq)]
pub struct Merged {
    pub sections: Sections,
    /// In order: the topics as sent (or as they were), those left out (closing or retired),
    /// then the owner's request; each with its state against the frame in force.
    pub hypotheses: Vec<Hypothesis>,
    /// Topics left out, kept for what still names them.
    pub closing: Vec<HypothesisId>,
    /// Segments carried for rows the call did not send.
    pub kept_segments: Vec<String>,
}

impl Merged {
    /// How many topics it keeps, adds and retires (the owner's request not counted).
    pub fn counts(&self, owner_request: HypothesisId) -> (u32, u32, u32) {
        let mut out = (0u32, 0u32, 0u32);
        for h in self.hypotheses.iter().filter(|h| h.id != owner_request) {
            match h.state {
                HypothesisState::Kept => out.0 += 1,
                HypothesisState::Added => out.1 += 1,
                HypothesisState::Retired => out.2 += 1,
            }
        }
        out
    }
}

/// The live card with `key`, if it has text.
fn body_of<'a>(cards: &'a [Card], key: &str) -> Option<&'a str> {
    cards
        .iter()
        .find(|c| c.is_live() && c.key.as_deref() == Some(key))
        .map(|c| c.body.trim())
        .filter(|b| !b.is_empty())
}

/// The identity the cards give (design §4.10.1, D34): the product is `products_prices`' text,
/// else `who_we_are`'s, else the first live card with text by position, else the workspace's
/// name; the voice is `voice`'s, the positioning `who_we_are`'s; what sets the business apart
/// (`usp`) is the frame's own. Each at most [`MAX_FRAME_TEXT_CHARS`] characters.
pub fn identity(cards: &[Card], usp: &str, workspace_name: &str) -> Identity {
    let mut by_position: Vec<&Card> = cards
        .iter()
        .filter(|c| c.is_live() && c.has_text())
        .collect();
    by_position.sort_by_key(|c| (c.position, c.created_at, c.id));
    let product = body_of(cards, "products_prices")
        .or_else(|| body_of(cards, "who_we_are"))
        .or_else(|| by_position.first().map(|c| c.body.trim()))
        .unwrap_or(workspace_name.trim());
    let text = |t: Option<&str>| cut(t.unwrap_or_default(), MAX_FRAME_TEXT_CHARS);
    Identity {
        product: cut(product, MAX_FRAME_TEXT_CHARS),
        voice: text(body_of(cards, "voice")),
        positioning: text(body_of(cards, "who_we_are")),
        usp: cut(usp, MAX_FRAME_TEXT_CHARS),
    }
}

/// The goals' lines as the frame's KPIs (`{name: line, target: ""}`).
pub fn kpis(goals: &[String]) -> Vec<Kpi> {
    goals
        .iter()
        .map(|g| Kpi {
            name: g.clone(),
            target: String::new(),
        })
        .collect()
}

/// The frame's channels: every connected account is used (K6).
pub fn any_channels() -> Vec<ChannelChoice> {
    vec![ChannelChoice {
        channel: ANY_CHANNEL.to_owned(),
        rationale: String::new(),
        group_id: None,
    }]
}

/// The budget lanes the rules' caps give (design §4.6.2, §4.6.4, D3): the paid lane from the ad
/// cap when its amount is above zero, the organic lane from the paid-message limit. Paid first.
pub fn lanes(settings: &KnowledgeSettings) -> Vec<Lane> {
    let mut out = Vec::new();
    if let Some(cap) = settings.ad_cap.as_ref().filter(|c| c.amount_minor > 0) {
        out.push(Lane {
            lane: LaneKind::Paid,
            period: cap.period,
            cap_minor: cap.amount_minor,
            currency: cap.currency.clone(),
        });
    }
    if let Some(cap) = &settings.message_cap {
        out.push(Lane {
            lane: LaneKind::Organic,
            period: cap.period,
            cap_minor: cap.amount_minor,
            currency: cap.currency.clone(),
        });
    }
    out
}

/// `base`'s sections with the system fields the knowledge base gives (design §4.10.1, step 5):
/// the identity, the KPIs, the prohibitions, the channels, the lanes, `paid_enabled`, and the
/// cadence (`base`'s posts a week, or [`DEFAULT_PER_WEEK`] without a frame, and no mix). The
/// audience, the objective and the prospecting stay `base`'s.
pub fn system_sections(base: Option<&Sections>, k: &Knowledge<'_>) -> Sections {
    let mut s = base.cloned().unwrap_or_default();
    s.identity = identity(k.cards, &s.identity.usp, k.workspace_name);
    s.goals.kpis = kpis(&k.settings.goals);
    s.prohibitions = k.settings.prohibitions.clone();
    s.channels = any_channels();
    s.budget_frame.lanes = lanes(k.settings);
    s.paid_enabled = s
        .budget_frame
        .lanes
        .iter()
        .any(|l| l.lane == LaneKind::Paid);
    s.cadence = Cadence {
        per_week: base.map_or(DEFAULT_PER_WEEK, |b| b.cadence.per_week),
        channel_mix: Vec::new(),
    };
    s
}

/// Whether `h`'s organic cadence lets it post (what the posting engine's `content_types` reads):
/// a valid cadence above zero posts a week naming a content type above zero.
pub fn posts_organically(h: &Hypothesis) -> bool {
    h.cadence.get(&LaneKind::Organic).is_some_and(|c| {
        c.validate().is_ok()
            && c.slots_per_week > 0
            && c.content_types.iter().any(|t| t.max_bps > 0)
    })
}

/// A live topic as the frame holds it (design §4.10.6): on `any` channel, posting organically
/// (the default cadence of `per_week`, at least one, when it has no usable one).
fn normalise_topic(h: &mut Hypothesis, per_week: u16) {
    h.channel = ANY_CHANNEL.to_owned();
    if !posts_organically(h) {
        h.cadence
            .insert(LaneKind::Organic, default_organic_cadence(per_week.max(1)));
    }
}

/// `title` compared as a person reads it: case and whitespace ignored.
fn title_key(title: &str) -> String {
    one_line(title).to_lowercase()
}

/// The bootstrap frame's segment and topic, from the cards (design §4.10.5).
fn bootstrap(cards: &[Card], id: HypothesisId) -> (Segment, Hypothesis) {
    let segment = Segment {
        key: BOOTSTRAP_SEGMENT.0.to_owned(),
        name: BOOTSTRAP_SEGMENT.1.to_owned(),
        description: cut(
            body_of(cards, "customers").unwrap_or_default(),
            MAX_FRAME_TEXT_CHARS,
        ),
    };
    let mut cadence = BTreeMap::new();
    cadence.insert(LaneKind::Organic, default_organic_cadence(DEFAULT_PER_WEEK));
    let topic = Hypothesis {
        id,
        title: BOOTSTRAP_TITLE.to_owned(),
        segment_key: BOOTSTRAP_SEGMENT.0.to_owned(),
        angle: cut(
            body_of(cards, "post_ideas").unwrap_or(BOOTSTRAP_ANGLE),
            MAX_BOOTSTRAP_ANGLE_CHARS,
        ),
        channel: ANY_CHANNEL.to_owned(),
        metric: BOOTSTRAP_METRIC.to_owned(),
        prior_confidence: DEFAULT_PRIOR,
        derived_confidence: None,
        cadence,
        state: HypothesisState::Added,
    };
    (segment, topic)
}

/// Every gap of a derivation's topic `t` (input index `i`) against the segment keys `segments`.
fn topic_gaps(i: usize, t: &TopicInput, segments: &BTreeSet<&str>, gaps: &mut Vec<Gap>) {
    let mut gap = |field: &str, message: &str| {
        gaps.push(Gap {
            field: format!("topics[{i}].{field}"),
            message: message.to_owned(),
        });
    };
    for (field, value) in [
        ("title", &t.title),
        ("angle", &t.angle),
        ("metric", &t.metric),
    ] {
        if value.trim().is_empty() {
            gap(field, &format!("a topic needs a {field}"));
        }
    }
    if !segments.contains(t.segment_key.as_str()) {
        gap(
            "segment_key",
            &format!("{:?} is not a segment of the audience", t.segment_key),
        );
    }
    if let Some(p) = t.prior_confidence
        && !(0.0..=1.0).contains(&p)
    {
        gap("prior_confidence", "the prior_confidence is 0 to 1");
    }
    if let Some(cadence) = &t.cadence {
        if cadence.contains_key(&LaneKind::Paid) {
            gap(
                "cadence.paid",
                "a paid cadence is set with paid_cadence, not with the topic",
            );
        }
        if let Some(c) = cadence.get(&LaneKind::Organic)
            && let Err(e) = c.validate()
        {
            gap("cadence.organic", e);
        }
    }
}

/// Keeps every content type `types` uses in `h`'s cadence of `lane`, posting (design §4.10.2
/// step 3): the lane's cadence is kept (`previous`'s when `h` has none), at least one post a
/// week, and each used type with a share above zero (`previous`'s share, else the whole week).
fn keep_used(
    h: &mut Hypothesis,
    lane: LaneKind,
    types: &BTreeSet<String>,
    previous: Option<&HypothesisCadence>,
) {
    let cadence = h.cadence.entry(lane).or_insert_with(|| {
        previous.cloned().unwrap_or(HypothesisCadence {
            slots_per_week: 1,
            exploration_bps: 0,
            content_types: Vec::new(),
        })
    });
    cadence.slots_per_week = cadence.slots_per_week.max(1);
    for key in types {
        let previous_max = previous
            .and_then(|c| c.content_types.iter().find(|t| &t.key == key))
            .map(|t| t.max_bps)
            .filter(|m| *m > 0)
            .unwrap_or(10_000);
        match cadence.content_types.iter_mut().find(|t| &t.key == key) {
            Some(t) if t.max_bps > 0 => {}
            Some(t) => t.max_bps = previous_max.max(t.min_bps),
            None => cadence.content_types.push(ContentTypeShare {
                key: key.clone(),
                min_bps: 0,
                max_bps: previous_max,
            }),
        }
    }
}

/// The next frame (see the module docs, and design §4.10.2 steps 3 to 6).
pub fn merge(
    input: &MergeInput<'_>,
    new_id: &mut dyn FnMut() -> HypothesisId,
) -> Result<Merged, Refusal> {
    let MergeInput {
        cause,
        base,
        next,
        knowledge,
        retained,
        known_ids,
        owner_request,
        bootstrap_id,
        retire_closing,
    } = *input;
    let base_sections = base.map(|b| b.sections);
    let mut sections = system_sections(base_sections, &knowledge);
    let per_week = sections.cadence.per_week;
    let previous: Vec<&Hypothesis> = base
        .map(|b| {
            b.hypotheses
                .iter()
                .filter(|h| h.state.is_live() && h.id != owner_request)
                .collect()
        })
        .unwrap_or_default();
    let previous_of = |id: HypothesisId| previous.iter().find(|h| h.id == id).copied();
    let mut closing: BTreeSet<HypothesisId> = knowledge
        .settings
        .closing_topic_ids
        .iter()
        .copied()
        .filter(|id| previous_of(*id).is_some())
        .collect();
    let mut gaps: Vec<Gap> = Vec::new();
    let mut out: Vec<Hypothesis> = Vec::new();
    let mut sent: BTreeSet<HypothesisId> = BTreeSet::new();
    let mut audience: Vec<Segment> = base_sections
        .map(|s| s.audience.clone())
        .unwrap_or_default();

    // Topics (step 3).
    match (&next.topics, base) {
        (_, None) if cause == FrameCause::Bootstrap => {
            let (segment, topic) = bootstrap(knowledge.cards, bootstrap_id);
            audience = vec![segment];
            out.push(topic);
        }
        (Some(topics), _) if cause == FrameCause::Derive => {
            if topics.len() > MAX_TOPICS {
                gaps.push(Gap {
                    field: "topics".into(),
                    message: format!("at most {MAX_TOPICS} topics, got {}", topics.len()),
                });
            }
            // A title matches a topic of the frame in force only when no entry of this call names
            // that topic by its id: the id given wins, and the title-matched entry is new.
            let given: BTreeSet<HypothesisId> = topics.iter().filter_map(|t| t.id).collect();
            let mut by_title: BTreeMap<String, HypothesisId> = BTreeMap::new();
            for h in previous.iter().filter(|h| !given.contains(&h.id)) {
                by_title.entry(title_key(&h.title)).or_insert(h.id);
            }
            for (i, t) in topics.iter().enumerate() {
                let id = match t.id {
                    Some(id) if id == owner_request => {
                        return Err(Refusal::Reserved(format!("topics[{i}].id")));
                    }
                    Some(id) if !known_ids.contains(&id) && previous_of(id).is_none() => {
                        gaps.push(Gap {
                            field: format!("topics[{i}].id"),
                            message: "no such topic in this workspace (topic_unknown)".into(),
                        });
                        continue;
                    }
                    Some(id) => id,
                    None => match by_title.get(&title_key(&t.title)) {
                        Some(id) if !sent.contains(id) => *id,
                        _ => new_id(),
                    },
                };
                if !sent.insert(id) {
                    gaps.push(Gap {
                        field: format!("topics[{i}].id"),
                        message: "the topic is sent more than once".into(),
                    });
                    continue;
                }
                closing.remove(&id);
                let before = previous_of(id);
                let mut cadence: BTreeMap<LaneKind, HypothesisCadence> = BTreeMap::new();
                let organic = t
                    .cadence
                    .as_ref()
                    .and_then(|c| c.get(&LaneKind::Organic))
                    .cloned()
                    .or_else(|| before.and_then(|b| b.cadence.get(&LaneKind::Organic).cloned()))
                    .unwrap_or_else(|| default_organic_cadence(per_week.max(1)));
                cadence.insert(LaneKind::Organic, organic);
                if let Some(paid) = before.and_then(|b| b.cadence.get(&LaneKind::Paid)) {
                    cadence.insert(LaneKind::Paid, paid.clone());
                }
                out.push(Hypothesis {
                    id,
                    title: t.title.trim().to_owned(),
                    segment_key: t.segment_key.trim().to_owned(),
                    angle: t.angle.trim().to_owned(),
                    channel: ANY_CHANNEL.to_owned(),
                    metric: t.metric.trim().to_owned(),
                    prior_confidence: t
                        .prior_confidence
                        .or(before.map(|b| b.prior_confidence))
                        .unwrap_or(DEFAULT_PRIOR),
                    derived_confidence: before.and_then(|b| b.derived_confidence),
                    cadence,
                    state: if before.is_some() {
                        HypothesisState::Kept
                    } else {
                        HypothesisState::Added
                    },
                });
            }
            // Left out: closing while something names it, else retired.
            for h in &previous {
                if sent.contains(&h.id) {
                    continue;
                }
                let state = if retained.contains_key(&h.id) {
                    closing.insert(h.id);
                    HypothesisState::Kept
                } else {
                    closing.remove(&h.id);
                    HypothesisState::Retired
                };
                out.push(Hypothesis {
                    state,
                    ..(*h).clone()
                });
            }
        }
        _ => {
            for h in &previous {
                let retire =
                    retire_closing && closing.contains(&h.id) && !retained.contains_key(&h.id);
                if retire {
                    closing.remove(&h.id);
                }
                out.push(Hypothesis {
                    state: if retire {
                        HypothesisState::Retired
                    } else {
                        HypothesisState::Kept
                    },
                    ..(*h).clone()
                });
            }
        }
    }

    // Every live topic on `any`, posting; and what a post, a binding or an ad uses stays.
    for h in out.iter_mut().filter(|h| h.state.is_live()) {
        normalise_topic(h, per_week);
        if let Some(lanes) = retained.get(&h.id) {
            let before = previous_of(h.id);
            for (lane, types) in lanes {
                keep_used(h, *lane, types, before.and_then(|b| b.cadence.get(lane)));
            }
        }
    }

    // The owner's request goes on when the frame in force holds it (design 2026-11-19 F2).
    if let Some(b) = base
        && let Some(h) = b
            .hypotheses
            .iter()
            .find(|h| h.id == owner_request && h.state.is_live())
    {
        out.push(Hypothesis {
            state: HypothesisState::Kept,
            ..h.clone()
        });
    }

    // Paid cadences (the ads part): replaced per topic, nothing retired.
    for (i, p) in next.paid_cadence.iter().flatten().enumerate() {
        let topic = out
            .iter_mut()
            .find(|h| h.id == p.topic_id && h.id != owner_request && h.state.is_live());
        match topic {
            None => gaps.push(Gap {
                field: format!("paid_cadence[{i}].topic_id"),
                message: "no such live topic (topic_unknown)".into(),
            }),
            Some(h) => {
                if let Err(e) = p.cadence.validate() {
                    gaps.push(Gap {
                        field: format!("paid_cadence[{i}].cadence"),
                        message: e.to_owned(),
                    });
                }
                h.cadence.insert(LaneKind::Paid, p.cadence.clone());
            }
        }
    }

    // Audience (step 4): what was sent, else the frame's; then every segment a live row the
    // call did not send still names; then the research agent's new ones.
    if cause == FrameCause::Derive
        && let Some(sent_audience) = &next.audience
    {
        audience = sent_audience.clone();
    }
    let mut needed: Vec<String> = out
        .iter()
        .filter(|h| h.state.is_live() && h.id != owner_request && !sent.contains(&h.id))
        .map(|h| h.segment_key.clone())
        .collect();
    if next.prospecting.is_none()
        && let Some(s) = base_sections
    {
        needed.extend(s.prospecting.icp.iter().map(|e| e.segment_key.clone()));
    }
    let mut kept_segments: Vec<String> = Vec::new();
    for key in needed {
        if audience.iter().any(|s| s.key == key) {
            continue;
        }
        if let Some(s) = base_sections.and_then(|s| s.audience.iter().find(|g| g.key == key)) {
            audience.push(s.clone());
            kept_segments.push(key);
        }
    }
    if let Some(p) = &next.prospecting {
        for s in &p.segments {
            if !audience.iter().any(|g| g.key == s.key) {
                audience.push(s.clone());
            }
        }
    }
    sections.audience = audience;
    if cause == FrameCause::Derive {
        if let Some(objective) = &next.objective {
            sections.goals.objective = cut(objective.trim(), MAX_FRAME_TEXT_CHARS);
        }
        if let Some(p) = &next.prospecting {
            sections.prospecting.icp = p.icp.clone();
            sections.prospecting.rubric = p.rubric.clone();
        }
    }

    // Validate only what the call brought (step 6).
    if cause == FrameCause::Derive {
        let keys: BTreeSet<&str> = sections.audience.iter().map(|s| s.key.as_str()).collect();
        for (i, t) in next.topics.iter().flatten().enumerate() {
            topic_gaps(i, t, &keys, &mut gaps);
        }
        if let Some(sent_audience) = &next.audience {
            if sent_audience.is_empty() {
                gaps.push(Gap {
                    field: "audience".into(),
                    message: "at least one segment is required".into(),
                });
            }
            let mut seen = BTreeSet::new();
            for (i, s) in sent_audience.iter().enumerate() {
                if let Err(e) = validate_segment_key(&s.key) {
                    gaps.push(Gap {
                        field: format!("audience[{i}].key"),
                        message: e.to_string(),
                    });
                } else if !seen.insert(s.key.as_str()) {
                    gaps.push(Gap {
                        field: format!("audience[{i}].key"),
                        message: format!("segment key {:?} is used more than once", s.key),
                    });
                }
            }
        }
        if next.prospecting.is_some() {
            gaps.extend(
                validate_sections(&sections)
                    .into_iter()
                    .filter(|g| g.field.starts_with("prospecting")),
            );
        }
    } else {
        gaps.extend(
            validate_sections(&sections)
                .into_iter()
                .filter(|g| g.field.starts_with("budget_frame") || g.field == "identity.product"),
        );
    }
    if !gaps.is_empty() {
        return Err(Refusal::Gaps(gaps));
    }
    let closing = out
        .iter()
        .filter(|h| h.state.is_live() && closing.contains(&h.id))
        .map(|h| h.id)
        .collect();
    Ok(Merged {
        sections,
        hypotheses: out,
        closing,
        kept_segments,
    })
}

/// `value` with every string's whitespace collapsed and trimmed, for comparing.
fn normalised(value: Value) -> Value {
    match value {
        Value::String(s) => Value::String(one_line(&s)),
        Value::Array(items) => Value::Array(items.into_iter().map(normalised).collect()),
        Value::Object(map) => {
            Value::Object(map.into_iter().map(|(k, v)| (k, normalised(v))).collect())
        }
        other => other,
    }
}

/// A frame's structural parts (design §4.10.1's last column), as canonical JSON: the channels,
/// the lanes, `paid_enabled`, the cadence, the prospecting, the set of segment keys, and per live
/// topic (the owner's request included) its segment, its channel and its cadence. Two frames that
/// differ only in texts have the same.
pub fn structural(sections: &Sections, hypotheses: &[Hypothesis]) -> Value {
    let keys: BTreeSet<&str> = sections.audience.iter().map(|s| s.key.as_str()).collect();
    let topics: BTreeMap<String, Value> = hypotheses
        .iter()
        .filter(|h| h.state.is_live())
        .map(|h| {
            (
                h.id.to_string(),
                json!({ "segment_key": h.segment_key, "channel": h.channel, "cadence": h.cadence }),
            )
        })
        .collect();
    normalised(json!({
        "channels": sections.channels,
        "budget_frame": sections.budget_frame,
        "paid_enabled": sections.paid_enabled,
        "cadence": sections.cadence,
        "prospecting": sections.prospecting,
        "audience": keys,
        "topics": topics,
    }))
}

/// A frame's texts beside its structure: the identity, the objective, the KPIs, the
/// prohibitions, the segments' names and descriptions, the live topics' titles, angles, metrics
/// and priors. What `text_only` compares.
pub fn texts(sections: &Sections, hypotheses: &[Hypothesis]) -> Value {
    let topics: BTreeMap<String, Value> = hypotheses
        .iter()
        .filter(|h| h.state.is_live())
        .map(|h| {
            (
                h.id.to_string(),
                json!({
                    "title": h.title, "angle": h.angle, "metric": h.metric,
                    "prior_confidence": h.prior_confidence,
                }),
            )
        })
        .collect();
    normalised(json!({
        "identity": sections.identity,
        "goals": sections.goals,
        "prohibitions": sections.prohibitions,
        "audience": sections.audience,
        "topics": topics,
    }))
}

/// Which structural parts differ between two frames, for whom to wake (design §4.10.8).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Changed {
    /// The topics (their set, segments, channels, organic cadences) or the audience's keys.
    pub topics: bool,
    /// The paid lane, `paid_enabled`, or the paid cadences (a live topic's, gained, changed or
    /// gone with its topic).
    pub paid: bool,
    /// The ICP or the rubric.
    pub prospecting: bool,
}

impl Changed {
    /// Whether anything structural differs.
    pub fn any(&self) -> bool {
        self.topics || self.paid || self.prospecting
    }
}

/// [`Changed`] between frame `a` and frame `b`.
pub fn changed(a: (&Sections, &[Hypothesis]), b: (&Sections, &[Hypothesis])) -> Changed {
    let organic = |(s, hs): (&Sections, &[Hypothesis])| {
        let keys: BTreeSet<&str> = s.audience.iter().map(|g| g.key.as_str()).collect();
        let topics: BTreeMap<String, Value> = hs
            .iter()
            .filter(|h| h.state.is_live())
            .map(|h| {
                (
                    h.id.to_string(),
                    json!({
                        "segment_key": h.segment_key,
                        "channel": h.channel,
                        "organic": h.cadence.get(&LaneKind::Organic),
                    }),
                )
            })
            .collect();
        normalised(json!({ "audience": keys, "topics": topics }))
    };
    let paid = |(s, hs): (&Sections, &[Hypothesis])| {
        let topics: BTreeMap<String, Value> = hs
            .iter()
            .filter(|h| h.state.is_live())
            .filter_map(|h| {
                h.cadence
                    .get(&LaneKind::Paid)
                    .map(|c| (h.id.to_string(), json!(c)))
            })
            .collect();
        json!({
            "lane": s.budget_frame.lanes.iter().find(|l| l.lane == LaneKind::Paid),
            "paid_enabled": s.paid_enabled,
            "topics": topics,
        })
    };
    let prospecting = |(s, _): (&Sections, &[Hypothesis])| normalised(json!(s.prospecting));
    Changed {
        topics: organic(a) != organic(b),
        paid: paid(a) != paid(b),
        prospecting: prospecting(a) != prospecting(b),
    }
}

/// Whether the frame `sections` with `hypotheses` is what the knowledge base makes of it
/// (design §4.10.6 step 3): its channels `[any]`, every live topic on `any` posting
/// organically, no channel mix, and the lanes and `paid_enabled` the rules' caps give. The
/// prohibitions, the goals and the identity are read live: a difference in them alone is never
/// a reason.
pub fn normalised_frame(
    sections: &Sections,
    hypotheses: &[Hypothesis],
    settings: &KnowledgeSettings,
    owner_request: HypothesisId,
) -> bool {
    let caps = lanes(settings);
    let same_lanes = |kind: LaneKind| {
        sections.budget_frame.lanes.iter().find(|l| l.lane == kind)
            == caps.iter().find(|l| l.lane == kind)
    };
    sections.channels == any_channels()
        && sections.cadence.channel_mix.is_empty()
        && sections.budget_frame.lanes.len() == caps.len()
        && same_lanes(LaneKind::Paid)
        && same_lanes(LaneKind::Organic)
        && sections.paid_enabled == caps.iter().any(|l| l.lane == LaneKind::Paid)
        && hypotheses
            .iter()
            .filter(|h| h.state.is_live() && h.id != owner_request)
            .all(|h| h.channel == ANY_CHANNEL && posts_organically(h))
}

/// How many days a lane's period counts as when caps are compared (as `check_general` does).
pub fn period_days(period: Period) -> i128 {
    match period {
        Period::Weekly => 7,
        Period::Monthly => 30,
    }
}

/// `amount_minor` a `from` period, brought to a `to` period (rounded down).
pub fn prorate(amount_minor: i64, from: Period, to: Period) -> i64 {
    let v = i128::from(amount_minor) * period_days(to) / period_days(from);
    i64::try_from(v).unwrap_or(i64::MAX)
}
