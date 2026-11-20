//! An area's production line as the content page shows it (design 2026-11-18 §4): the 14 steps
//! of the workflow and what follows them, as eight stages, each with its state and, once
//! finished, what it produced. [`project`] and [`marks`] are pure; [`PostReads`] reads what the
//! page needs of the planned posts of a set of areas, one read per kind.
use crate::{
    error::AppError,
    ports::{TenantRepos, production_projects::*},
};
use jt_capability::{Capability, CapabilityId};
use jt_studio::{
    ApprovalReceipt, MaterialId, Measurement, MeasurementStatus, MeasurementWindow, PostFormat,
    Publication, PublicationId, PublishAttempt, PublishOutcome, RetirementReason, Slot, SlotId,
    SlotState,
};
use jt_tenancy::UserId;
use serde::Serialize;
use std::collections::BTreeMap;
use time::OffsetDateTime;
use uuid::Uuid;

/// The eight stages: five over the workflow's steps, then approval, publishing and results.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StageKey {
    /// Steps 1 to 3: goal, audience, platform and format.
    Hazirlik,
    /// Steps 4 to 6: research, idea, main message.
    Fikir,
    /// Steps 7 and 8: headline and text.
    Metin,
    /// Steps 9 and 10: the materials, edited.
    Gorsel,
    /// Steps 11 to 14: the platform versions, delivered as a package.
    Paket,
    /// A person's approval of a planned post, where its account asks for one.
    Onay,
    /// The planned posts' times, and their publication.
    Yayin,
    /// What the published posts measured.
    Sonuc,
}

/// The stages in order, each with the workflow steps it spans.
pub const STAGES: [(StageKey, Option<(u8, u8)>); 8] = [
    (StageKey::Hazirlik, Some((1, 3))),
    (StageKey::Fikir, Some((4, 6))),
    (StageKey::Metin, Some((7, 8))),
    (StageKey::Gorsel, Some((9, 10))),
    (StageKey::Paket, Some((11, 14))),
    (StageKey::Onay, None),
    (StageKey::Yayin, None),
    (StageKey::Sonuc, None),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StageState {
    Done,
    /// Where the work is now.
    Current,
    /// Where the work waits for a person: a capture the agent asked for, an approval.
    WaitingPerson,
    /// Where the work is stuck: deliveries refused three times, a post that could not go out.
    Problem,
    Todo,
}

/// The current package's summary (stage Paket).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PackageSummary {
    pub revision: u32,
    #[serde(with = "jt_studio::time_compat")]
    pub delivered_at: OffsetDateTime,
    pub summary: String,
    /// A person released it from a hold (only its text check held it).
    pub released: bool,
    pub versions: Vec<VersionSummary>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct VersionSummary {
    pub id: Uuid,
    pub format: PostFormat,
    pub capability_id: Option<CapabilityId>,
    pub title: Option<String>,
    pub material_ids: Vec<MaterialId>,
    pub slot_id: Option<SlotId>,
    /// A person cancelled its planned post: who, when and why. It stops at Yayın, unsent, and is
    /// never planned again.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<VersionCancel>,
}

/// A planned post made of a version (stage Onay): whether its account asks for a person's
/// approval, and who gave it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ApprovalFact {
    pub version_id: Uuid,
    pub slot_id: SlotId,
    /// Its account asks for a person's approval (or TikTok's posting screen).
    pub required: bool,
    /// What the person does is TikTok's posting screen, never a plain approval: an approval
    /// without the screen's choice does not release it.
    pub posting_screen: bool,
    /// It waits for that approval now.
    pub waiting: bool,
    pub approved_by: Option<UserId>,
    #[serde(with = "jt_studio::time_compat::option")]
    pub approved_at: Option<OffsetDateTime>,
}

/// A planned post's time and publication (stage Yayın).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PublicationFact {
    pub version_id: Uuid,
    pub slot_id: SlotId,
    pub capability_id: CapabilityId,
    /// The account's name as the workspace calls it.
    pub account_name: Option<String>,
    pub state: SlotState,
    #[serde(with = "jt_studio::time_compat")]
    pub scheduled_at: OffsetDateTime,
    #[serde(with = "jt_studio::time_compat::option")]
    pub published_at: Option<OffsetDateTime>,
    pub url: Option<String>,
    /// It did not go out and will not: its one attempt failed or was refused (a planned post is
    /// attempted once, never retried), or it passed its grace unsent (`missed_grace`). A post
    /// that was taken back on purpose (a person's cancellation, a redo, a strategy change, a
    /// replanning) is not failed, whatever its attempt did.
    pub failed: bool,
    /// Why it was retired unsent, when it was and its post recorded why: `cancelled`,
    /// `missed_grace`, `replanned`, `hypothesis_retired`, `strategy_archived`, `week_ended`
    /// (`measurements_complete` after it went out). Absent otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retirement: Option<RetirementReason>,
}

/// What a published post measured last (stage Sonuç): the provider's own counters, as stored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ResultFact {
    pub version_id: Uuid,
    pub publication_id: PublicationId,
    pub window: MeasurementWindow,
    #[serde(with = "jt_studio::time_compat")]
    pub measured_at: OffsetDateTime,
    pub metrics: BTreeMap<String, Option<i64>>,
}

/// One stage with its state and what it holds: the reported steps of the step stages, the
/// package, and the planned posts' approvals, publications and results.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Stage {
    pub key: StageKey,
    pub state: StageState,
    /// The workflow steps it spans, first and last; none for Onay, Yayın and Sonuç.
    pub span: Option<[u8; 2]>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub steps: Vec<AreaStep>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package: Option<PackageSummary>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub approvals: Vec<ApprovalFact>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub publications: Vec<PublicationFact>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub results: Vec<ResultFact>,
}

/// A version of a finished current package that no planned post was made of yet: it waits for
/// an account and a time (`jeeta.social.version_schedule`), given by the agent on its next run or
/// by a person, unless nothing can take it now (`blocked`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TimeWait {
    pub version_id: Uuid,
    pub format: PostFormat,
    /// The account the version was made for, if its maker chose one.
    pub capability_id: Option<CapabilityId>,
    /// The accounts it could go out on now.
    pub accounts: Vec<CapabilityId>,
    /// Why no account can take it now, as `jeeta.social.versions_waiting` says it
    /// (`material_removed`, `braked`, `knowledge_empty`, `no_connected_account`, `account_paused`,
    /// `its_account_unavailable`, `format_not_supported`, `media_not_accepted`,
    /// `hypothesis_does_not_post`): a problem a person fixes, read
    /// from the facts on every read, so it goes the moment its cause does. Absent while some
    /// account can.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<&'static str>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Pipeline {
    /// The step the agent reported last in the current attempt, 1 to 14.
    pub current_step: Option<u8>,
    pub stages: Vec<Stage>,
    /// The versions of the finished current package that wait for an account and a time.
    pub unscheduled: Vec<TimeWait>,
}

impl Pipeline {
    pub fn stage(&self, key: StageKey) -> Option<&Stage> {
        self.stages.iter().find(|s| s.key == key)
    }

    /// Some stage waits for a person's approval.
    pub fn awaits_approval(&self) -> bool {
        self.stage(StageKey::Onay)
            .is_some_and(|s| s.state == StageState::WaitingPerson)
    }

    /// Some stage is stuck.
    pub fn has_problem(&self) -> bool {
        self.stages.iter().any(|s| s.state == StageState::Problem)
    }

    /// A version of its finished package waits for a time that some account can take: the
    /// agent gives it on its next run, or a person does.
    pub fn awaits_time(&self) -> bool {
        self.unscheduled.iter().any(|v| v.blocked.is_none())
    }

    /// Some planned post of the area went out (of its current package or an earlier one).
    pub fn published(&self) -> bool {
        self.stage(StageKey::Yayin)
            .is_some_and(|s| s.publications.iter().any(|p| p.published_at.is_some()))
    }
}

/// What the page needs of one planned post made of a version of an area's package.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VersionFact {
    pub version_id: Uuid,
    pub approval: ApprovalFact,
    pub publication: PublicationFact,
    pub result: Option<ResultFact>,
}

impl VersionFact {
    fn out(&self) -> bool {
        self.publication.published_at.is_some()
    }

    /// Still to go out: not out, not failed, not retired.
    fn pending(&self) -> bool {
        !self.out() && !self.publication.failed && self.publication.state != SlotState::Retired
    }
}

/// The step the attempt is at: the last reported step, or, for an area from before the step
/// history, its last progress report (unless a redo abandoned it).
fn current_step(p: &ProductionProject) -> Option<u8> {
    p.steps.last().map(|s| s.step).or_else(|| {
        p.progress
            .as_ref()
            .filter(|_| p.redo.is_none())
            .map(|g| g.step)
    })
}

/// Onay, Yayın and Sonuç of an area whose current package is finished or not (`done`), from
/// `facts`, its planned posts (see [`PostReads::facts`]), and `unscheduled`, the versions of its
/// finished package no planned post was made of.
///
/// Onay waits for a person while a planned post waits for an approval; it is current while a
/// version of the finished package waits for a time (or the package has no post yet), done once
/// planned posts exist and nothing waits, todo otherwise. Yayın is a problem while a planned post
/// failed or a version waits for a time no account can take (`blocked`); todo while nothing went
/// out and the posts are not approved, or nothing is planned; current while a post is still to go
/// out or a version still waits for its time; done once every post went out or was taken back.
/// Sonuç is current once something went out, done once every published post is measured.
fn post_states(done: bool, facts: &[VersionFact], unscheduled: &[TimeWait]) -> [StageState; 3] {
    let waiting = facts.iter().any(|f| f.approval.waiting);
    let out = facts.iter().any(VersionFact::out);
    let blocked = unscheduled.iter().any(|v| v.blocked.is_some());
    let onay = if waiting {
        StageState::WaitingPerson
    } else if !unscheduled.is_empty() {
        StageState::Current
    } else if !facts.is_empty() {
        StageState::Done
    } else if done {
        StageState::Current
    } else {
        StageState::Todo
    };
    let yayin = if blocked || facts.iter().any(|f| f.publication.failed) {
        StageState::Problem
    } else if facts.is_empty() || (waiting && !out) {
        StageState::Todo
    } else if !unscheduled.is_empty() || facts.iter().any(VersionFact::pending) {
        StageState::Current
    } else {
        StageState::Done
    };
    let sonuc = if !out {
        StageState::Todo
    } else if facts.iter().filter(|f| f.out()).all(|f| {
        // Retired after it went out: only once its measurements were complete.
        matches!(
            f.publication.state,
            SlotState::Measured | SlotState::Retired
        )
    }) {
        StageState::Done
    } else {
        StageState::Current
    };
    [onay, yayin, sonuc]
}

/// What the content tree counts of an area, from the same rules as its [`Pipeline`]: whether a
/// post of it went out ([`Pipeline::published`]), whether it waits for an approval
/// ([`Pipeline::awaits_approval`]) and how many of its posts do, whether a version waits for a
/// time some account can take ([`Pipeline::awaits_time`]), and whether it is stuck
/// ([`Pipeline::has_problem`]: held, a post failed, or a version no account can take).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Marks {
    pub published: bool,
    pub awaits_approval: bool,
    pub approvals_waiting: usize,
    pub awaits_time: bool,
    pub problem: bool,
}

/// [`Marks`] of an area that is `held` or not, whose current package is finished or not
/// (`done`), with `facts` and `unscheduled`, without building its pipeline.
pub fn marks(held: bool, done: bool, facts: &[VersionFact], unscheduled: &[TimeWait]) -> Marks {
    let [onay, yayin, _] = post_states(done, facts, unscheduled);
    Marks {
        published: facts.iter().any(VersionFact::out),
        awaits_approval: onay == StageState::WaitingPerson,
        approvals_waiting: facts.iter().filter(|f| f.approval.waiting).count(),
        awaits_time: unscheduled.iter().any(|v| v.blocked.is_none()),
        problem: held || yayin == StageState::Problem,
    }
}

/// The pipeline of area `p` at `now`, from its step history, its current package, `facts`, its
/// planned posts ([`PostReads::facts`]), and `unscheduled`, the versions of its finished package
/// that wait for a time.
///
/// The step stages: Paket is a problem and the others done while the area is held (its
/// deliveries were refused); all done once the area holds its finished current package (no redo
/// standing, no capture awaited); otherwise done before the stage of the current step, todo after
/// it, and the stage of the current step current, or waiting for a person while a capture is
/// awaited. With no step reported, a working area is at Hazırlık, an area waiting for a capture
/// at Görsel. Onay, Yayın and Sonuç follow the planned posts (see `post_states`): a post that went
/// out stays there, with its results, whatever the current attempt does (a redo, a capture
/// asked for).
pub fn project(
    p: &ProductionProject,
    now: OffsetDateTime,
    facts: &[VersionFact],
    unscheduled: Vec<TimeWait>,
) -> Pipeline {
    let state = p.state(now);
    let current = current_step(p);
    let done = p.done_at().is_some();
    let package = p.packages.last().filter(|_| done);
    let [onay, yayin, sonuc] = post_states(done, facts, &unscheduled);
    let at_stage = |range: (u8, u8), step: u8| (range.0..=range.1).contains(&step);
    let mut stages = Vec::with_capacity(STAGES.len());
    for (key, span) in STAGES {
        let mut stage = Stage {
            key,
            state: StageState::Todo,
            span: span.map(|(a, b)| [a, b]),
            steps: Vec::new(),
            package: None,
            approvals: Vec::new(),
            publications: Vec::new(),
            results: Vec::new(),
        };
        if let Some(range) = span {
            stage.steps = p
                .steps
                .iter()
                .filter(|s| at_stage(range, s.step))
                .cloned()
                .collect();
            stage.state = if state == AreaState::Held {
                // Its deliveries were refused: the package is what is stuck.
                if key == StageKey::Paket {
                    StageState::Problem
                } else {
                    StageState::Done
                }
            } else if package.is_some() {
                StageState::Done
            } else {
                let at = current.or(match state {
                    AreaState::Working => Some(1),
                    AreaState::WaitingMaterial => Some(9),
                    _ => None,
                });
                match at {
                    None => StageState::Todo,
                    Some(c) if c > range.1 => StageState::Done,
                    Some(c) if at_stage(range, c) => {
                        if state == AreaState::WaitingMaterial {
                            StageState::WaitingPerson
                        } else {
                            StageState::Current
                        }
                    }
                    Some(_) => StageState::Todo,
                }
            };
            if key == StageKey::Paket {
                stage.package = package.map(|k| PackageSummary {
                    revision: k.revision,
                    delivered_at: k.delivered_at,
                    summary: k.summary.clone(),
                    released: k.released.is_some(),
                    versions: k
                        .versions
                        .iter()
                        .map(|v| VersionSummary {
                            id: v.id,
                            format: v.format,
                            capability_id: v.capability_id,
                            title: v.title.clone(),
                            material_ids: v.material_ids.clone(),
                            slot_id: v.slot_id,
                            cancelled: v.cancelled.clone(),
                        })
                        .collect(),
                });
            }
            stages.push(stage);
            continue;
        }
        match key {
            StageKey::Onay => {
                stage.approvals = facts.iter().map(|f| f.approval.clone()).collect();
                stage.state = onay;
            }
            StageKey::Yayin => {
                stage.publications = facts.iter().map(|f| f.publication.clone()).collect();
                stage.state = yayin;
            }
            StageKey::Sonuc => {
                stage.results = facts.iter().filter_map(|f| f.result.clone()).collect();
                stage.state = sonuc;
            }
            _ => {}
        }
        stages.push(stage);
    }
    Pipeline {
        current_step: current,
        stages,
        unscheduled,
    }
}

/// What the page reads of a set of planned posts, one read per kind (slots, approvals, attempts
/// and measurements, publications, posts) and one per account: [`PostReads::facts`] answers
/// each area's planned posts from it.
#[derive(Default)]
pub struct PostReads {
    slots: BTreeMap<SlotId, Slot>,
    approvals: BTreeMap<SlotId, ApprovalReceipt>,
    attempts: BTreeMap<SlotId, Vec<PublishAttempt>>,
    measurements: Vec<Measurement>,
    publications: BTreeMap<SlotId, Publication>,
    retired: BTreeMap<SlotId, RetirementReason>,
    accounts: BTreeMap<CapabilityId, Option<Capability>>,
    /// The knowledge base's rules, for the effective post gate (none before seeding).
    knowledge: Option<jt_knowledge::KnowledgeSettings>,
}

impl PostReads {
    /// Reads what [`PostReads::facts`] needs of the planned posts `slots`.
    pub async fn load(r: &mut dyn TenantRepos, slots: &[SlotId]) -> Result<Self, AppError> {
        let mut ids = slots.to_vec();
        ids.sort();
        ids.dedup();
        if ids.is_empty() {
            return Ok(Self::default());
        }
        let slots: BTreeMap<SlotId, Slot> = r
            .studio()
            .get_slots(&ids)
            .await?
            .into_iter()
            .map(|s| (s.id, s))
            .collect();
        let revisions: Vec<(SlotId, u64)> = slots.values().map(|s| (s.id, s.revision)).collect();
        let approvals = r
            .studio()
            .slot_approvals(&revisions)
            .await?
            .into_iter()
            .collect();
        let (all_attempts, measurements) = r.studio().slots_evidence(&ids).await?;
        let mut attempts: BTreeMap<SlotId, Vec<PublishAttempt>> = BTreeMap::new();
        for a in all_attempts {
            attempts.entry(a.slot_id()).or_default().push(a);
        }
        let mut publications: BTreeMap<SlotId, Publication> = BTreeMap::new();
        for x in r.studio().publications_of(&ids).await? {
            let newer = publications
                .get(&x.slot_id)
                .is_none_or(|y| x.published_at >= y.published_at);
            if newer {
                publications.insert(x.slot_id, x);
            }
        }
        let retired = r
            .studio_posts()
            .get_posts(&ids)
            .await?
            .into_iter()
            .filter_map(|p| p.retired.map(|x| (p.slot_id, x.reason)))
            .collect();
        let mut accounts = BTreeMap::new();
        for s in slots.values() {
            if let std::collections::btree_map::Entry::Vacant(e) = accounts.entry(s.capability_id) {
                e.insert(r.capabilities().find(s.capability_id).await?);
            }
        }
        let knowledge = crate::usecases::social::approval::rules(r).await?;
        Ok(PostReads {
            slots,
            approvals,
            attempts,
            measurements,
            publications,
            retired,
            accounts,
            knowledge,
        })
    }

    /// What the planned posts `posts` of one area are now, in their order: each version's slot,
    /// whether its account asks for an approval and who gave it, its publication, and the last
    /// complete measurement of that publication. The posts of the current package are all
    /// listed; those of an earlier package only once they went out (what went out stays, with
    /// its results). A post whose slot is not stored is not listed.
    pub fn facts(&self, posts: &[AreaPost]) -> Vec<VersionFact> {
        let mut out = Vec::new();
        for post in posts {
            let Some(slot) = self.slots.get(&post.slot_id) else {
                continue;
            };
            let publication = self.publications.get(&slot.id);
            if !post.current && publication.is_none() {
                continue;
            }
            let account = self
                .accounts
                .get(&slot.capability_id)
                .and_then(Option::as_ref);
            let screen = account.is_some_and(|c| jt_studio::requires_posting_screen(&c.kind_key));
            // The effective post gate (design 2026-11-19 §3.10.1), not the stored flag alone.
            let required = screen
                || account.is_some_and(|c| {
                    crate::usecases::social::approval::needs_approval(c, self.knowledge.as_ref())
                });
            let receipt = self.approvals.get(&slot.id);
            let attempts: &[PublishAttempt] = self
                .attempts
                .get(&slot.id)
                .map(Vec::as_slice)
                .unwrap_or_default();
            // As `studio.pending` asks for it: a ready post, never attempted, whose account asks.
            let waiting = slot.state == SlotState::Ready
                && attempts.is_empty()
                && required
                && receipt.is_none_or(|a| screen && a.tiktok.is_none());
            let retirement = self
                .retired
                .get(&slot.id)
                .copied()
                .filter(|_| slot.state == SlotState::Retired);
            // A planned post has one attempt (`studio_publish_attempts` is unique by slot) and
            // is never sent again once it failed or was refused: such a post failed for good.
            let unsent = !attempts.is_empty()
                && attempts.iter().all(|a| {
                    matches!(
                        a.outcome(),
                        Some(PublishOutcome::Failed(_) | PublishOutcome::Refused(_))
                    )
                });
            let failed = publication.is_none()
                && match retirement {
                    Some(RetirementReason::MissedGrace) => true,
                    // Taken back on purpose: a person's cancellation, a redo, a strategy change.
                    Some(_) => false,
                    None => unsent,
                };
            let result = publication.and_then(|x| {
                self.measurements
                    .iter()
                    .filter(|m| {
                        m.publication_id == Some(x.id) && m.status == MeasurementStatus::Complete
                    })
                    .max_by_key(|m| (m.window, m.measured_at))
                    .map(|m| ResultFact {
                        version_id: post.version_id,
                        publication_id: x.id,
                        window: m.window,
                        measured_at: m.measured_at,
                        metrics: m.raw_metrics.clone(),
                    })
            });
            out.push(VersionFact {
                version_id: post.version_id,
                approval: ApprovalFact {
                    version_id: post.version_id,
                    slot_id: slot.id,
                    required,
                    posting_screen: screen,
                    waiting,
                    approved_by: receipt.map(|a| a.by),
                    approved_at: receipt.map(|a| a.at),
                },
                publication: PublicationFact {
                    version_id: post.version_id,
                    slot_id: slot.id,
                    capability_id: slot.capability_id,
                    account_name: account.map(|c| c.name.clone()),
                    state: slot.state,
                    scheduled_at: slot.scheduled_at,
                    published_at: publication.map(|x| x.published_at),
                    url: publication.and_then(|x| x.url.as_ref().map(|u| u.to_string())),
                    failed,
                    retirement,
                },
                result,
            });
        }
        out
    }
}
