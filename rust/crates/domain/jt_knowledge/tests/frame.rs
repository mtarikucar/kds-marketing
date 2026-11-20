//! The frame merge, pure (design 2026-11-19 "Paylaşımlar and Bilgi bankası" §4.10, §8.1): the
//! system fields recomputed from the knowledge base, topic ids kept, the retained set (D9),
//! segments carried (D36), the owner's request outside every check, validation of only what a
//! call brought, and the structural diff (D34). Over the sample strategy of a fictional business,
//! a coffee roastery, in the shape of a live one (`fixtures/strategy-sample.json`).

use std::collections::{BTreeMap, BTreeSet};

use jt_knowledge::frame::{
    BOOTSTRAP_ANGLE, Base, DEFAULT_PER_WEEK, DerivePart, FrameCause, FrameParts, Knowledge,
    MergeInput, Merged, ProspectingInput, Refusal, Retained, TopicInput, changed,
    default_organic_cadence, identity, lanes, merge, normalised_frame, posts_organically, prorate,
    structural, texts,
};
use jt_knowledge::*;
use jt_ledger::Actor;
use jt_strategy::{
    ANY_CHANNEL, ContentTypeShare, Hypothesis, HypothesisCadence, HypothesisId, HypothesisState,
    LaneKind, Period, Sections, Segment,
};
use jt_tenancy::{UserId, WorkspaceId};
use serde_json::Value;
use time::macros::datetime;
use uuid::Uuid;

const AT: time::OffsetDateTime = datetime!(2026-11-19 12:00 UTC);

fn v5() -> (Sections, Vec<Hypothesis>) {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/strategy-sample.json")).expect("the fixture");
    (
        serde_json::from_value(fixture["sections"].clone()).expect("the sections read"),
        serde_json::from_value(fixture["hypotheses"].clone()).expect("the hypotheses read"),
    )
}

fn card(key: Option<&str>, body: &str, position: u32) -> Card {
    let actor = Actor::Human {
        user_id: UserId::new_v7(),
    };
    Card {
        id: KnowledgeCardId::new_v7(),
        key: key.map(str::to_owned),
        title: "Kart".into(),
        body: body.into(),
        attachments: vec![],
        position,
        revision: 1,
        created_at: AT,
        created_by: actor.clone(),
        updated_at: AT,
        updated_by: actor,
        archived_at: None,
    }
}

fn cap(amount_minor: i64) -> Cap {
    Cap {
        amount_minor,
        period: Period::Monthly,
        currency: "TRY".into(),
    }
}

/// The settings the sample's seed gives: its paid lane as the ad cap, its organic lane of 0 as
/// the paid-message limit, two prohibitions and two goals.
fn settings() -> KnowledgeSettings {
    let mut s = KnowledgeSettings::new(WorkspaceId::new_v7(), SeedSource::Approved, AT);
    s.ad_cap = Some(cap(500_000));
    s.message_cap = Some(cap(0));
    s.prohibitions = vec!["Rakip adı anılmaz".into(), "Fiyat sözü verilmez".into()];
    s.goals = vec!["Ayda 40 yeni abonelik".into(), "Toptan: 12 kafe".into()];
    s
}

fn cards() -> Vec<Card> {
    vec![
        card(
            Some("who_we_are"),
            "Ege'de küçük bir kavurma atölyesiyiz.",
            0,
        ),
        card(Some("products_prices"), "Filtre kahve 250 g 240 TL.", 1),
        card(Some("voice"), "Samimi, kısa.", 2),
        card(Some("customers"), "Ofisler ve kafeler.", 3),
        card(Some("post_ideas"), "Kavurma günleri.", 4),
    ]
}

fn id() -> HypothesisId {
    HypothesisId(Uuid::now_v7())
}

/// Everything a merge needs beside the frame and what the call brings.
struct Facts {
    cards: Vec<Card>,
    settings: KnowledgeSettings,
    retained: Retained,
    known: BTreeSet<HypothesisId>,
    owner: HypothesisId,
    bootstrap: HypothesisId,
}

impl Facts {
    fn new() -> Facts {
        Facts {
            cards: cards(),
            settings: settings(),
            retained: Retained::new(),
            known: BTreeSet::new(),
            owner: id(),
            bootstrap: id(),
        }
    }

    fn merge(
        &self,
        cause: FrameCause,
        base: Option<(&Sections, &[Hypothesis])>,
        next: &FrameParts,
    ) -> Result<Merged, Refusal> {
        let input = MergeInput {
            cause,
            base: base.map(|(sections, hypotheses)| Base {
                sections,
                hypotheses,
            }),
            next,
            knowledge: Knowledge {
                cards: &self.cards,
                settings: &self.settings,
                workspace_name: "Kahve Atölyesi",
            },
            retained: &self.retained,
            known_ids: &self.known,
            owner_request: self.owner,
            bootstrap_id: self.bootstrap,
            retire_closing: matches!(cause, FrameCause::Normalize | FrameCause::Close),
        };
        merge(&input, &mut id)
    }
}

/// The topic `h` as a derivation sends it, unchanged.
fn sent(h: &Hypothesis) -> TopicInput {
    TopicInput {
        id: Some(h.id),
        title: h.title.clone(),
        segment_key: h.segment_key.clone(),
        angle: h.angle.clone(),
        metric: h.metric.clone(),
        prior_confidence: None,
        cadence: None,
    }
}

fn posting(topics: Vec<TopicInput>) -> FrameParts {
    FrameParts {
        kb_revision: 1,
        parts: vec![DerivePart::Posting],
        topics: Some(topics),
        ..FrameParts::default()
    }
}

fn state_of(m: &Merged, id: HypothesisId) -> Option<HypothesisState> {
    m.hypotheses.iter().find(|h| h.id == id).map(|h| h.state)
}

fn gap_fields(r: Result<Merged, Refusal>) -> Vec<String> {
    match r {
        Err(Refusal::Gaps(gaps)) => gaps.into_iter().map(|g| g.field).collect(),
        other => panic!("expected gaps, got {other:?}"),
    }
}

/// The owner's request as `owner_request::hypothesis` writes it: a segment of no audience.
fn owner_request(id: HypothesisId) -> Hypothesis {
    let mut cadence = BTreeMap::new();
    cadence.insert(LaneKind::Organic, default_organic_cadence(1));
    Hypothesis {
        id,
        title: "Sahibin isteği".into(),
        segment_key: "owner_request".into(),
        angle: "A post the owner asked for in person.".into(),
        channel: ANY_CHANNEL.into(),
        metric: "engagement".into(),
        prior_confidence: 0.5,
        derived_confidence: None,
        cadence,
        state: HypothesisState::Kept,
    }
}

// ---------------------------------------------------------------------------------------------
// System fields
// ---------------------------------------------------------------------------------------------

#[test]
fn the_system_fields_come_from_the_knowledge_base() {
    let f = Facts::new();
    let (s, h) = v5();
    let m = f
        .merge(FrameCause::Rules, Some((&s, &h)), &FrameParts::default())
        .unwrap();
    let out = &m.sections;
    assert_eq!(out.identity.product, "Filtre kahve 250 g 240 TL.");
    assert_eq!(out.identity.voice, "Samimi, kısa.");
    assert_eq!(
        out.identity.positioning,
        "Ege'de küçük bir kavurma atölyesiyiz."
    );
    assert_eq!(
        out.identity.usp, s.identity.usp,
        "the usp is the frame's own"
    );
    assert_eq!(
        out.goals
            .kpis
            .iter()
            .map(|k| (k.name.as_str(), k.target.as_str()))
            .collect::<Vec<_>>(),
        [("Ayda 40 yeni abonelik", ""), ("Toptan: 12 kafe", "")]
    );
    assert_eq!(
        out.goals.objective, s.goals.objective,
        "derived, not the system's"
    );
    assert_eq!(out.prohibitions, f.settings.prohibitions);
    assert_eq!(out.channels.len(), 1);
    assert_eq!(out.channels[0].channel, ANY_CHANNEL);
    assert!(out.channels[0].rationale.is_empty() && out.channels[0].group_id.is_none());
    assert_eq!(out.budget_frame.lanes, lanes(&f.settings));
    assert_eq!(
        out.budget_frame
            .lanes
            .iter()
            .map(|l| (l.lane, l.cap_minor))
            .collect::<Vec<_>>(),
        [(LaneKind::Paid, 500_000), (LaneKind::Organic, 0)],
        "the paid lane is the ad cap, the organic lane the paid-message limit (D3)"
    );
    assert!(out.paid_enabled);
    assert_eq!(out.cadence.per_week, s.cadence.per_week);
    assert!(out.cadence.channel_mix.is_empty());
    // The audience and the prospecting are derived: the system leaves them.
    assert_eq!(out.audience, s.audience);
    assert_eq!(out.prospecting, s.prospecting);
    // Every topic kept, on `any`, with its cadence.
    assert_eq!(m.hypotheses.len(), h.len());
    for (before, after) in h.iter().zip(&m.hypotheses) {
        assert_eq!(after.id, before.id);
        assert_eq!(after.state, HypothesisState::Kept);
        assert_eq!(after.channel, ANY_CHANNEL);
        assert_eq!(after.cadence, before.cadence);
        assert_eq!(
            (after.title.as_str(), after.angle.as_str()),
            (before.title.as_str(), before.angle.as_str())
        );
    }
    assert!(m.closing.is_empty() && m.kept_segments.is_empty());
}

#[test]
fn the_identity_falls_back_card_by_card() {
    let mut cs = cards();
    assert_eq!(
        identity(&cs, "", "Atölye").product,
        "Filtre kahve 250 g 240 TL."
    );
    // No products card: who we are.
    cs.retain(|c| c.key.as_deref() != Some("products_prices"));
    assert_eq!(
        identity(&cs, "", "Atölye").product,
        "Ege'de küçük bir kavurma atölyesiyiz."
    );
    // Neither: the first live card with text, by position.
    let mut own = vec![
        card(None, "", 0),
        card(None, "Üçüncü kart", 5),
        card(None, "  ", 1),
        card(None, "İkinci kart", 2),
    ];
    let mut removed = card(None, "Kaldırılan kart", 0);
    removed.archived_at = Some(AT);
    own.push(removed);
    let i = identity(&own, "", "Atölye");
    assert_eq!(i.product, "İkinci kart");
    assert_eq!((i.voice.as_str(), i.positioning.as_str()), ("", ""));
    // No text at all: the workspace's name.
    assert_eq!(identity(&[], "", " Atölye ").product, "Atölye");
    // Long texts are cut to the strategy's section limit.
    let long = vec![card(Some("voice"), &"ç".repeat(2_500), 0)];
    assert_eq!(identity(&long, "", "A").voice.chars().count(), 2_000);
}

#[test]
fn the_lanes_follow_the_caps() {
    let mut s = settings();
    assert_eq!(lanes(&s).len(), 2);
    // "Reklam yok" (no cap) and a cap of 0 both mean no paid lane.
    s.ad_cap = Some(cap(0));
    assert_eq!(
        lanes(&s).iter().map(|l| l.lane).collect::<Vec<_>>(),
        [LaneKind::Organic]
    );
    s.ad_cap = None;
    s.message_cap = None;
    assert!(lanes(&s).is_empty(), "no limit of its own: no organic lane");
    // A weekly cap keeps its period and currency.
    s.ad_cap = Some(Cap {
        amount_minor: 70_000,
        period: Period::Weekly,
        currency: "EUR".into(),
    });
    let l = &lanes(&s)[0];
    assert_eq!(
        (l.lane, l.period, l.cap_minor, l.currency.as_str()),
        (LaneKind::Paid, Period::Weekly, 70_000, "EUR")
    );
    assert_eq!(prorate(50_000, Period::Weekly, Period::Monthly), 214_285);
    assert_eq!(prorate(214_285, Period::Monthly, Period::Weekly), 49_999);
}

#[test]
fn a_rules_mirror_without_ads_drops_the_paid_lane_and_paid_enabled() {
    let mut f = Facts::new();
    f.settings.ad_cap = None;
    let (s, h) = v5();
    let m = f
        .merge(FrameCause::Rules, Some((&s, &h)), &FrameParts::default())
        .unwrap();
    assert!(!m.sections.paid_enabled);
    assert_eq!(
        m.sections
            .budget_frame
            .lanes
            .iter()
            .map(|l| l.lane)
            .collect::<Vec<_>>(),
        [LaneKind::Organic]
    );
    assert!(changed((&s, &h), (&m.sections, &m.hypotheses)).paid);
}

// ---------------------------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------------------------

#[test]
fn a_v5_like_frame_is_normalised_with_every_topic_kept() {
    let f = Facts::new();
    let (s, h) = v5();
    assert!(
        !normalised_frame(&s, &h, &f.settings, f.owner),
        "channels instagram/tiktok, topics on instagram, a channel mix"
    );
    let m = f
        .merge(
            FrameCause::Normalize,
            Some((&s, &h)),
            &FrameParts::default(),
        )
        .unwrap();
    assert!(normalised_frame(
        &m.sections,
        &m.hypotheses,
        &f.settings,
        f.owner
    ));
    assert_eq!(
        m.hypotheses.iter().map(|h| h.id).collect::<Vec<_>>(),
        h.iter().map(|h| h.id).collect::<Vec<_>>()
    );
    assert!(
        m.hypotheses
            .iter()
            .all(|h| h.state == HypothesisState::Kept)
    );
    assert_ne!(structural(&s, &h), structural(&m.sections, &m.hypotheses));
    // A second normalisation of the normalised frame changes nothing.
    let again = f
        .merge(
            FrameCause::Normalize,
            Some((&m.sections, &m.hypotheses)),
            &FrameParts::default(),
        )
        .unwrap();
    assert_eq!(
        structural(&m.sections, &m.hypotheses),
        structural(&again.sections, &again.hypotheses)
    );
}

#[test]
fn a_topic_that_cannot_post_gets_the_default_cadence() {
    let f = Facts::new();
    let (s, mut h) = v5();
    h[0].cadence.clear();
    h[1].cadence.insert(
        LaneKind::Organic,
        HypothesisCadence {
            slots_per_week: 2,
            exploration_bps: 0,
            content_types: vec![ContentTypeShare {
                key: "general".into(),
                min_bps: 0,
                max_bps: 0,
            }],
        },
    );
    assert!(!posts_organically(&h[0]) && !posts_organically(&h[1]));
    let m = f
        .merge(
            FrameCause::Normalize,
            Some((&s, &h)),
            &FrameParts::default(),
        )
        .unwrap();
    for t in &m.hypotheses[..2] {
        assert_eq!(
            t.cadence.get(&LaneKind::Organic),
            Some(&default_organic_cadence(s.cadence.per_week))
        );
    }
    assert_eq!(
        m.hypotheses[2].cadence, h[2].cadence,
        "a posting one keeps its own"
    );
}

#[test]
fn inherited_content_is_never_revalidated() {
    // 31 inherited topics (one more than a derivation may send), a topic without an angle, and
    // the owner's request on a segment of no audience: a rules mirror and a normalisation still
    // pass (D36).
    let mut f = Facts::new();
    let (s, h) = v5();
    let mut many: Vec<Hypothesis> = (0..31)
        .map(|i| Hypothesis {
            id: id(),
            title: format!("Konu {i}"),
            angle: if i == 3 {
                String::new()
            } else {
                "Açı".into()
            },
            ..h[0].clone()
        })
        .collect();
    many.push(owner_request(f.owner));
    for cause in [FrameCause::Rules, FrameCause::Normalize] {
        let m = f
            .merge(cause, Some((&s, &many)), &FrameParts::default())
            .unwrap();
        assert_eq!(m.hypotheses.len(), 32);
        assert_eq!(m.counts(f.owner), (31, 0, 0));
    }
    // Only the system fields are checked, and those are built to pass; a bug in them is a gap.
    f.settings.ad_cap = Some(Cap {
        amount_minor: 1,
        period: Period::Monthly,
        currency: "lira".into(),
    });
    assert_eq!(
        gap_fields(f.merge(FrameCause::Rules, Some((&s, &many)), &FrameParts::default())),
        ["budget_frame.lanes[0].currency"]
    );
}

// ---------------------------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------------------------

#[test]
fn topic_ids_are_given_matched_by_title_or_new() {
    let f = Facts::new();
    let (s, h) = v5();
    let new_title = TopicInput {
        id: None,
        title: "Kavurma günü canlı".into(),
        cadence: None,
        ..sent(&h[2])
    };
    // Case and whitespace aside, the same title (ASCII case: Turkish dotted and dotless i do
    // not round-trip through upper case).
    let by_title = TopicInput {
        id: None,
        title: format!(
            "  {}  ",
            h[1].title.replacen('H', "h", 1).replace(' ', "   ")
        ),
        ..sent(&h[1])
    };
    let m = f
        .merge(
            FrameCause::Derive,
            Some((&s, &h)),
            &posting(vec![sent(&h[0]), by_title, new_title]),
        )
        .unwrap();
    assert_eq!(m.hypotheses[0].id, h[0].id);
    assert_eq!(m.hypotheses[0].state, HypothesisState::Kept);
    assert_eq!(m.hypotheses[1].id, h[1].id, "matched by its title");
    assert_eq!(m.hypotheses[1].state, HypothesisState::Kept);
    let fresh = &m.hypotheses[2];
    assert!(h.iter().all(|x| x.id != fresh.id));
    assert_eq!(fresh.state, HypothesisState::Added);
    assert_eq!(fresh.channel, ANY_CHANNEL);
    // A kept topic sent without a cadence keeps its own; a new one gets the default.
    assert_eq!(m.hypotheses[0].cadence, h[0].cadence);
    assert_eq!(
        fresh.cadence.get(&LaneKind::Organic),
        Some(&default_organic_cadence(s.cadence.per_week))
    );
    assert_eq!(fresh.prior_confidence, 0.5);
    // The rest were left out and nothing names them: retired.
    for left in &h[2..] {
        assert_eq!(state_of(&m, left.id), Some(HypothesisState::Retired));
    }
    assert_eq!(m.counts(f.owner), (2, 1, 5));
    assert!(m.closing.is_empty());
}

#[test]
fn a_title_never_takes_an_id_the_same_call_gives() {
    let f = Facts::new();
    let (s, h) = v5();
    // The first entry has `h[0]`'s title but no id, the second names `h[0]` by its id: the id
    // wins, and the first is a new topic rather than a refusal for a topic sent twice.
    let same_title = TopicInput {
        id: None,
        angle: "Başka bir açı".into(),
        ..sent(&h[0])
    };
    let m = f
        .merge(
            FrameCause::Derive,
            Some((&s, &h)),
            &posting(vec![same_title, sent(&h[0])]),
        )
        .unwrap();
    let fresh = &m.hypotheses[0];
    assert_ne!(fresh.id, h[0].id);
    assert!(h.iter().all(|x| x.id != fresh.id));
    assert_eq!(fresh.state, HypothesisState::Added);
    assert_eq!(m.hypotheses[1].id, h[0].id);
    assert_eq!(m.hypotheses[1].state, HypothesisState::Kept);
}

#[test]
fn a_topic_id_must_be_of_the_workspace_and_never_the_owners_request() {
    let mut f = Facts::new();
    let (s, h) = v5();
    let mut stranger = sent(&h[0]);
    stranger.id = Some(id());
    assert_eq!(
        gap_fields(f.merge(
            FrameCause::Derive,
            Some((&s, &h)),
            &posting(vec![stranger.clone()])
        )),
        ["topics[0].id"]
    );
    // An id of an older version of the workspace is taken back.
    f.known.insert(stranger.id.unwrap());
    let m = f
        .merge(
            FrameCause::Derive,
            Some((&s, &h)),
            &posting(vec![stranger.clone()]),
        )
        .unwrap();
    assert_eq!(m.hypotheses[0].id, stranger.id.unwrap());
    assert_eq!(m.hypotheses[0].state, HypothesisState::Added);
    // Sending one twice.
    assert_eq!(
        gap_fields(f.merge(
            FrameCause::Derive,
            Some((&s, &h)),
            &posting(vec![sent(&h[0]), sent(&h[0])])
        )),
        ["topics[1].id"]
    );
    let mut reserved = sent(&h[0]);
    reserved.id = Some(f.owner);
    assert_eq!(
        f.merge(FrameCause::Derive, Some((&s, &h)), &posting(vec![reserved])),
        Err(Refusal::Reserved("topics[0].id".into()))
    );
}

#[test]
fn gaps_name_the_callers_input() {
    let f = Facts::new();
    let (s, h) = v5();
    let mut no_angle = sent(&h[0]);
    no_angle.angle = " ".into();
    let mut stray = sent(&h[1]);
    stray.segment_key = "yok".into();
    let mut paid = sent(&h[2]);
    paid.cadence = Some(BTreeMap::from([(
        LaneKind::Paid,
        default_organic_cadence(1),
    )]));
    let mut bad_prior = sent(&h[3]);
    bad_prior.prior_confidence = Some(1.5);
    let fields = gap_fields(f.merge(
        FrameCause::Derive,
        Some((&s, &h)),
        &posting(vec![no_angle, stray, paid, bad_prior]),
    ));
    assert_eq!(
        fields,
        [
            "topics[0].angle",
            "topics[1].segment_key",
            "topics[2].cadence.paid",
            "topics[3].prior_confidence"
        ]
    );
    // At most 30 topics.
    let many: Vec<TopicInput> = (0..31)
        .map(|i| TopicInput {
            id: None,
            title: format!("Konu {i}"),
            ..sent(&h[0])
        })
        .collect();
    assert_eq!(
        gap_fields(f.merge(FrameCause::Derive, Some((&s, &h)), &posting(many))),
        ["topics"]
    );
    // An audience sent is checked by its own index.
    let next = FrameParts {
        kb_revision: 1,
        parts: vec![DerivePart::Posting],
        audience: Some(vec![
            s.audience[0].clone(),
            Segment {
                key: "Kötü Anahtar".into(),
                ..s.audience[1].clone()
            },
            s.audience[0].clone(),
        ]),
        ..FrameParts::default()
    };
    assert_eq!(
        gap_fields(f.merge(FrameCause::Derive, Some((&s, &h)), &next)),
        ["audience[1].key", "audience[2].key"]
    );
}

#[test]
fn a_left_out_topic_a_post_still_names_is_closing_and_keeps_what_its_posts_use() {
    let mut f = Facts::new();
    let (s, mut h) = v5();
    // h[2] has a ready post of the content type "reel" on the organic lane and an ad set bound on
    // the paid lane; h[0] has a ready post whose content type the derivation drops.
    h[2].cadence.insert(
        LaneKind::Organic,
        HypothesisCadence {
            slots_per_week: 3,
            exploration_bps: 0,
            content_types: vec![ContentTypeShare {
                key: "reel".into(),
                min_bps: 0,
                max_bps: 10_000,
            }],
        },
    );
    h[2].cadence
        .insert(LaneKind::Paid, default_organic_cadence(2));
    f.retained.insert(
        h[2].id,
        BTreeMap::from([
            (LaneKind::Organic, BTreeSet::from(["reel".to_owned()])),
            (LaneKind::Paid, BTreeSet::from(["general".to_owned()])),
        ]),
    );
    f.retained.insert(
        h[0].id,
        BTreeMap::from([(LaneKind::Organic, BTreeSet::from(["general".to_owned()]))]),
    );
    let mut first = sent(&h[0]);
    first.cadence = Some(BTreeMap::from([(
        LaneKind::Organic,
        HypothesisCadence {
            slots_per_week: 2,
            exploration_bps: 0,
            content_types: vec![ContentTypeShare {
                key: "carousel".into(),
                min_bps: 0,
                max_bps: 10_000,
            }],
        },
    )]));
    let m = f
        .merge(FrameCause::Derive, Some((&s, &h)), &posting(vec![first]))
        .unwrap();
    // Left out but named: kept, closing, its fields as they were.
    let closing = m.hypotheses.iter().find(|x| x.id == h[2].id).unwrap();
    assert_eq!(closing.state, HypothesisState::Kept);
    assert_eq!(closing.cadence, h[2].cadence, "its cadences, paid included");
    assert_eq!(m.closing, [h[2].id]);
    assert_eq!(m.counts(f.owner).2, 5, "the other five are retired");
    // Sent with a cadence that drops what its ready post uses: the type stays, posting.
    let kept = &m.hypotheses[0];
    let organic = &kept.cadence[&LaneKind::Organic];
    assert!(organic.slots_per_week >= 1);
    let general = organic
        .content_types
        .iter()
        .find(|t| t.key == "general")
        .expect("the used content type stays");
    assert!(general.max_bps > 0);
    assert_eq!(general.max_bps, 10_000, "its previous share");
    assert!(organic.content_types.iter().any(|t| t.key == "carousel"));
    // A later derivation that sends the closing topic again takes it out of closing.
    let mut f2 = Facts::new();
    f2.settings.closing_topic_ids = m.closing.clone();
    let again = f2
        .merge(
            FrameCause::Derive,
            Some((&m.sections, &m.hypotheses)),
            &posting(vec![sent(closing)]),
        )
        .unwrap();
    assert!(again.closing.is_empty());
    assert_eq!(state_of(&again, h[2].id), Some(HypothesisState::Kept));
}

#[test]
fn closing_topics_are_retired_once_nothing_names_them() {
    let mut f = Facts::new();
    let (s, h) = v5();
    f.settings.closing_topic_ids = vec![h[5].id, h[6].id];
    f.retained.insert(h[6].id, BTreeMap::new());
    // A rules mirror never retires (only the housekeeping does).
    let m = f
        .merge(FrameCause::Rules, Some((&s, &h)), &FrameParts::default())
        .unwrap();
    assert_eq!(m.closing, [h[5].id, h[6].id]);
    assert_eq!(m.counts(f.owner), (7, 0, 0));
    let m = f
        .merge(FrameCause::Close, Some((&s, &h)), &FrameParts::default())
        .unwrap();
    assert_eq!(state_of(&m, h[5].id), Some(HypothesisState::Retired));
    assert_eq!(state_of(&m, h[6].id), Some(HypothesisState::Kept));
    assert_eq!(m.closing, [h[6].id], "still named: still closing");
    // A closing id the frame no longer holds is dropped.
    f.settings.closing_topic_ids = vec![id()];
    let m = f
        .merge(FrameCause::Rules, Some((&s, &h)), &FrameParts::default())
        .unwrap();
    assert!(m.closing.is_empty());
}

#[test]
fn segments_a_live_row_still_names_are_carried() {
    let mut f = Facts::new();
    let (s, h) = v5();
    // A retained topic on `toptan` left out, and every ICP entry naming its own segment: a
    // posting derivation sends an audience with only `bireysel`.
    f.retained.insert(h[2].id, BTreeMap::new());
    assert_eq!(h[2].segment_key, "toptan");
    let only = s
        .audience
        .iter()
        .find(|g| g.key == "bireysel")
        .unwrap()
        .clone();
    let next = FrameParts {
        audience: Some(vec![only]),
        ..posting(vec![sent(&h[0])])
    };
    let m = f.merge(FrameCause::Derive, Some((&s, &h)), &next).unwrap();
    let keys: Vec<&str> = m.sections.audience.iter().map(|g| g.key.as_str()).collect();
    assert_eq!(keys[0], "bireysel");
    assert!(keys.contains(&"toptan"), "the closing topic's segment");
    for e in &s.prospecting.icp {
        assert!(
            keys.contains(&e.segment_key.as_str()),
            "{} of the prospecting part not sent",
            e.segment_key
        );
    }
    assert!(m.kept_segments.contains(&"toptan".to_owned()));
    assert!(m.kept_segments.contains(&"tadim".to_owned()));
    assert!(!m.kept_segments.contains(&"bireysel".to_owned()));
    // A carried segment keeps its name and description.
    let toptan = m
        .sections
        .audience
        .iter()
        .find(|g| g.key == "toptan")
        .unwrap();
    assert_eq!(
        toptan,
        s.audience.iter().find(|g| g.key == "toptan").unwrap()
    );
    // A prospecting part sent brings its new segments; the entries it drops no longer carry.
    let mut icp = s.prospecting.icp[..1].to_vec();
    icp[0].segment_key = "kavurucu".into();
    let next = FrameParts {
        kb_revision: 1,
        parts: vec![DerivePart::Prospecting],
        prospecting: Some(ProspectingInput {
            icp,
            rubric: s.prospecting.rubric.clone(),
            segments: vec![Segment {
                key: "kavurucu".into(),
                name: "Kavurucular".into(),
                description: "Kendi çekirdeğini kavuranlar".into(),
            }],
        }),
        ..FrameParts::default()
    };
    let m = f.merge(FrameCause::Derive, Some((&s, &h)), &next).unwrap();
    assert_eq!(m.sections.prospecting.icp.len(), 1);
    assert!(m.sections.audience.iter().any(|g| g.key == "kavurucu"));
    assert_eq!(
        m.hypotheses.iter().filter(|x| x.state.is_live()).count(),
        h.len(),
        "a prospecting derivation leaves the topics"
    );
    // An ICP entry naming a segment the merged audience lacks is a gap of the input.
    let mut stray = s.prospecting.icp[..1].to_vec();
    stray[0].segment_key = "yok_boyle".into();
    let next = FrameParts {
        prospecting: Some(ProspectingInput {
            icp: stray,
            rubric: s.prospecting.rubric.clone(),
            segments: vec![],
        }),
        ..next
    };
    assert_eq!(
        gap_fields(f.merge(FrameCause::Derive, Some((&s, &h)), &next)),
        ["prospecting.icp[0].segment_key"]
    );
}

#[test]
fn the_owners_request_is_carried_and_outside_every_check() {
    let mut f = Facts::new();
    let (s, mut h) = v5();
    h.push(owner_request(f.owner));
    f.retained.insert(f.owner, BTreeMap::new());
    let m = f
        .merge(
            FrameCause::Derive,
            Some((&s, &h)),
            &posting(vec![sent(&h[0])]),
        )
        .unwrap();
    let owner = m.hypotheses.last().unwrap();
    assert_eq!(owner.id, f.owner);
    assert_eq!(owner.state, HypothesisState::Kept);
    assert_eq!(
        owner.segment_key, "owner_request",
        "never carried as a segment"
    );
    assert!(!m.sections.audience.iter().any(|g| g.key == "owner_request"));
    assert!(!m.closing.contains(&f.owner));
    assert_eq!(m.counts(f.owner), (1, 0, 6), "not counted");
    // A frame without it gets none.
    let (s, h) = v5();
    let m = f
        .merge(FrameCause::Rules, Some((&s, &h)), &FrameParts::default())
        .unwrap();
    assert!(m.hypotheses.iter().all(|x| x.id != f.owner));
}

#[test]
fn a_paid_cadence_replaces_one_topics_and_retires_nothing() {
    let f = Facts::new();
    let (s, h) = v5();
    let paid = HypothesisCadence {
        slots_per_week: 1,
        exploration_bps: 0,
        content_types: vec![ContentTypeShare {
            key: "general".into(),
            min_bps: 0,
            max_bps: 10_000,
        }],
    };
    let next = FrameParts {
        kb_revision: 1,
        paid_cadence: Some(vec![jt_knowledge::frame::PaidCadence {
            topic_id: h[3].id,
            cadence: paid.clone(),
        }]),
        ..FrameParts::default()
    };
    let m = f.merge(FrameCause::Derive, Some((&s, &h)), &next).unwrap();
    assert_eq!(m.hypotheses[3].cadence.get(&LaneKind::Paid), Some(&paid));
    assert_eq!(m.counts(f.owner), (7, 0, 0));
    let c = changed((&s, &h), (&m.sections, &m.hypotheses));
    assert!(c.paid);
    let next = FrameParts {
        paid_cadence: Some(vec![jt_knowledge::frame::PaidCadence {
            topic_id: id(),
            cadence: paid,
        }]),
        ..next
    };
    assert_eq!(
        gap_fields(f.merge(FrameCause::Derive, Some((&s, &h)), &next)),
        ["paid_cadence[0].topic_id"]
    );
}

/// A paid cadence the ads agent sends cannot drop what a live ad-set binding uses (design
/// §4.10.2 step 3): the bound content type stays with a share, and the lane keeps a slot.
#[test]
fn a_paid_cadence_keeps_what_a_binding_uses() {
    let mut f = Facts::new();
    let (s, mut h) = v5();
    h[3].cadence.insert(
        LaneKind::Paid,
        HypothesisCadence {
            slots_per_week: 2,
            exploration_bps: 0,
            content_types: vec![ContentTypeShare {
                key: "reel".into(),
                min_bps: 0,
                max_bps: 6_000,
            }],
        },
    );
    f.retained.insert(
        h[3].id,
        BTreeMap::from([(LaneKind::Paid, BTreeSet::from(["reel".to_owned()]))]),
    );
    for slots in [1, 0] {
        let next = FrameParts {
            kb_revision: 1,
            paid_cadence: Some(vec![jt_knowledge::frame::PaidCadence {
                topic_id: h[3].id,
                cadence: HypothesisCadence {
                    slots_per_week: slots,
                    exploration_bps: 0,
                    content_types: vec![ContentTypeShare {
                        key: "carousel".into(),
                        min_bps: 0,
                        max_bps: 10_000,
                    }],
                },
            }]),
            ..FrameParts::default()
        };
        let m = f.merge(FrameCause::Derive, Some((&s, &h)), &next).unwrap();
        let paid = &m.hypotheses[3].cadence[&LaneKind::Paid];
        assert!(paid.slots_per_week >= 1, "{slots}");
        let reel = paid
            .content_types
            .iter()
            .find(|t| t.key == "reel")
            .expect("the bound content type stays");
        assert_eq!(reel.max_bps, 6_000, "its previous share");
        assert!(paid.content_types.iter().any(|t| t.key == "carousel"));
        assert!(paid.validate().is_ok());
    }
}

// ---------------------------------------------------------------------------------------------
// The structural diff
// ---------------------------------------------------------------------------------------------

#[test]
fn reworded_texts_make_no_version() {
    let mut f = Facts::new();
    let (s, h) = v5();
    let normal = f
        .merge(
            FrameCause::Normalize,
            Some((&s, &h)),
            &FrameParts::default(),
        )
        .unwrap();
    let (s, h) = (&normal.sections, &normal.hypotheses);
    // Two derivations from the same cards: the agent rewords the objective, every title and
    // angle; the identity moves because a card was reworded.
    let reworded: Vec<TopicInput> = h
        .iter()
        .map(|x| TopicInput {
            title: format!("{} (yeni)", x.title),
            angle: format!("{}  bambaşka   sözlerle", x.angle),
            metric: format!("{} ölçüsü", x.metric),
            prior_confidence: Some(0.9),
            ..sent(x)
        })
        .collect();
    let next = FrameParts {
        objective: Some("Yepyeni bir amaç".into()),
        ..posting(reworded)
    };
    f.cards[0].body = "Ege'nin en küçük kavurma atölyesi.".into();
    let m = f.merge(FrameCause::Derive, Some((s, h)), &next).unwrap();
    assert_eq!(structural(s, h), structural(&m.sections, &m.hypotheses));
    assert_ne!(texts(s, h), texts(&m.sections, &m.hypotheses), "text_only");
    assert!(!changed((s, h), (&m.sections, &m.hypotheses)).any());
    // Whitespace alone is no difference either.
    let mut spaced = m.clone();
    spaced.sections.prospecting.rubric.criteria[0].description = format!(
        "  {}  ",
        spaced.sections.prospecting.rubric.criteria[0].description
    );
    assert_eq!(
        structural(&m.sections, &m.hypotheses),
        structural(&spaced.sections, &spaced.hypotheses)
    );
    // A new segment for a topic, a cadence, a lane or the prospecting is structural.
    let mut moved = m.clone();
    moved.hypotheses[0].segment_key = "toptan".into();
    assert!(changed((s, h), (&moved.sections, &moved.hypotheses)).topics);
    let mut moved = m.clone();
    moved.hypotheses[0]
        .cadence
        .insert(LaneKind::Organic, default_organic_cadence(1));
    assert_ne!(
        structural(s, h),
        structural(&moved.sections, &moved.hypotheses)
    );
    let mut moved = m.clone();
    moved.sections.prospecting.rubric.qualify_at += 1;
    let c = changed((s, h), (&moved.sections, &moved.hypotheses));
    assert!(c.prospecting && !c.topics && !c.paid);
}

// ---------------------------------------------------------------------------------------------
// The bootstrap
// ---------------------------------------------------------------------------------------------

#[test]
fn the_bootstrap_frame_is_built_from_fallbacks_that_validate() {
    let mut f = Facts::new();
    let m = f
        .merge(FrameCause::Bootstrap, None, &FrameParts::default())
        .unwrap();
    assert_eq!(m.sections.audience.len(), 1);
    let genel = &m.sections.audience[0];
    assert_eq!(
        (genel.key.as_str(), genel.name.as_str()),
        ("genel", "Genel")
    );
    assert_eq!(
        genel.description, "Ofisler ve kafeler.",
        "the customers card"
    );
    assert_eq!(m.hypotheses.len(), 1);
    let topic = &m.hypotheses[0];
    assert_eq!(topic.id, f.bootstrap);
    assert_eq!(
        (
            topic.title.as_str(),
            topic.segment_key.as_str(),
            topic.metric.as_str()
        ),
        ("Genel", "genel", "Etkileşim")
    );
    assert_eq!(topic.angle, "Kavurma günleri.", "the post ideas card");
    assert_eq!(topic.channel, ANY_CHANNEL);
    assert_eq!(topic.state, HypothesisState::Added);
    assert_eq!(
        topic.cadence.get(&LaneKind::Organic),
        Some(&default_organic_cadence(DEFAULT_PER_WEEK))
    );
    assert_eq!(m.sections.cadence.per_week, DEFAULT_PER_WEEK);
    assert!(m.sections.prospecting.icp.is_empty(), "research waits");
    assert_eq!(m.sections.identity.product, "Filtre kahve 250 g 240 TL.");
    assert!(normalised_frame(
        &m.sections,
        &m.hypotheses,
        &f.settings,
        f.owner
    ));
    // Only one card with text, and not a seed one: its text is the product; the defaults fill
    // the rest.
    f.cards = vec![card(None, "Doğum günü pastaları yapıyoruz.", 0)];
    let m = f
        .merge(FrameCause::Bootstrap, None, &FrameParts::default())
        .unwrap();
    assert_eq!(
        m.sections.identity.product,
        "Doğum günü pastaları yapıyoruz."
    );
    assert_eq!(m.hypotheses[0].angle, BOOTSTRAP_ANGLE);
    assert_eq!(m.sections.audience[0].description, "");
}
