//! An area's production line as the content page shows it (design 2026-11-18 §4): the 14 steps
//! of the workflow and what follows them, as eight stages, each with its state and, once
//! finished, what it produced. [`project`] is pure; `version_facts` reads what the page needs
//! of the planned posts made of the current package.
use crate::{
    error::AppError,
    ports::{TenantRepos, production_projects::*, studio::ApprovalTarget},
};
use jt_capability::{Capability, CapabilityId};
use jt_studio::{
    MaterialId, MeasurementStatus, MeasurementWindow, PostFormat, Publication, PublicationId,
    PublishOutcome, SlotId, SlotState,
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
}

/// A planned post made of a version (stage Onay): whether its account asks for a person's
/// approval, and who gave it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ApprovalFact {
    pub version_id: Uuid,
    pub slot_id: SlotId,
    /// Its account asks for a person's approval (or TikTok's posting screen).
    pub required: bool,
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
    /// It will not go out: every attempt failed or was refused, or the post was retired unsent.
    pub failed: bool,
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Pipeline {
    /// The step the agent reported last in the current attempt, 1 to 14.
    pub current_step: Option<u8>,
    pub stages: Vec<Stage>,
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

    /// Some planned post of the current package went out.
    pub fn published(&self) -> bool {
        self.stage(StageKey::Yayin)
            .is_some_and(|s| s.publications.iter().any(|p| p.published_at.is_some()))
    }
}

/// What the page needs of one planned post made of a version of the current package.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VersionFact {
    pub version_id: Uuid,
    pub approval: ApprovalFact,
    pub publication: PublicationFact,
    pub result: Option<ResultFact>,
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

/// The pipeline of area `p` at `now`, from its step history, its current package and `facts`,
/// the planned posts made of that package.
///
/// The step stages: all done once the area holds its current package (no redo standing, no
/// capture awaited); otherwise done before the stage of the current step, todo after it, and
/// the stage of the current step current, waiting for a person while a capture is awaited, or
/// (Paket) a problem while the area is held. With no step reported, a working area is at
/// Hazırlık, an area waiting for a capture at Görsel. After them: Onay waits for a person while
/// a planned post waits for an approval, and is current while no version has a time yet; Yayın
/// is current until every planned post went out, a problem when one cannot; Sonuç is current
/// once something went out, done once every published post is measured.
pub fn project(p: &ProductionProject, now: OffsetDateTime, facts: &[VersionFact]) -> Pipeline {
    let state = p.state(now);
    let current = current_step(p);
    let package = p.packages.last().filter(|_| p.done_at().is_some());
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
            stage.state = if package.is_some() {
                StageState::Done
            } else if state == AreaState::Held {
                // Its deliveries were refused: the package is what is stuck.
                if key == StageKey::Paket {
                    StageState::Problem
                } else {
                    StageState::Done
                }
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
                        })
                        .collect(),
                });
            }
            stages.push(stage);
            continue;
        }
        if package.is_none() {
            stages.push(stage);
            continue;
        }
        let approval_done = !facts.is_empty() && !facts.iter().any(|f| f.approval.waiting);
        match key {
            StageKey::Onay => {
                stage.approvals = facts.iter().map(|f| f.approval.clone()).collect();
                stage.state = if facts.iter().any(|f| f.approval.waiting) {
                    StageState::WaitingPerson
                } else if facts.is_empty() {
                    StageState::Current
                } else {
                    StageState::Done
                };
            }
            StageKey::Yayin => {
                stage.publications = facts.iter().map(|f| f.publication.clone()).collect();
                let live: Vec<_> = facts.iter().filter(|f| !f.publication.failed).collect();
                let out = |f: &&VersionFact| f.publication.published_at.is_some();
                stage.state = if !approval_done {
                    StageState::Todo
                } else if facts.iter().any(|f| f.publication.failed && !out(&f)) {
                    StageState::Problem
                } else if !live.is_empty() && live.iter().all(out) {
                    StageState::Done
                } else {
                    StageState::Current
                };
            }
            StageKey::Sonuc => {
                stage.results = facts.iter().filter_map(|f| f.result.clone()).collect();
                let published: Vec<_> = facts
                    .iter()
                    .filter(|f| f.publication.published_at.is_some())
                    .collect();
                stage.state = if published.is_empty() {
                    StageState::Todo
                } else if published
                    .iter()
                    .all(|f| f.publication.state == SlotState::Measured)
                {
                    StageState::Done
                } else {
                    StageState::Current
                };
            }
            _ => {}
        }
        stages.push(stage);
    }
    Pipeline {
        current_step: current,
        stages,
    }
}

/// The capabilities read so far, by id (`None`: not found).
pub(crate) type Accounts = BTreeMap<CapabilityId, Option<Capability>>;

/// What the planned posts of `p`'s current package are now: each version's slot, whether its
/// account asks for an approval and who gave it, its publication among `publications`, and the
/// last complete measurement of that publication. Nothing while the area holds no current
/// package; a version with no planned post yet is not listed.
pub(crate) async fn version_facts(
    r: &mut dyn TenantRepos,
    p: &ProductionProject,
    publications: &[Publication],
    accounts: &mut Accounts,
) -> Result<Vec<VersionFact>, AppError> {
    let Some(package) = p.packages.last().filter(|_| p.done_at().is_some()) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for v in &package.versions {
        let Some(slot_id) = v.slot_id else { continue };
        let Some(slot) = r.studio().get_slot(slot_id).await? else {
            continue;
        };
        if let std::collections::btree_map::Entry::Vacant(e) = accounts.entry(slot.capability_id) {
            e.insert(r.capabilities().find(slot.capability_id).await?);
        }
        let account = accounts.get(&slot.capability_id).cloned().flatten();
        let screen = account
            .as_ref()
            .is_some_and(|c| jt_studio::requires_posting_screen(&c.kind_key));
        let required = screen
            || account
                .as_ref()
                .is_some_and(|c| c.policy.requires_human_approval);
        let receipt = r
            .studio()
            .get_approval(ApprovalTarget::Slot(slot_id), slot.revision)
            .await?;
        let (attempts, measurements) = r.studio().slot_evidence(slot_id).await?;
        // As `studio.pending` asks for it: a ready post, never attempted, whose account asks.
        let waiting = slot.state == SlotState::Ready
            && attempts.is_empty()
            && required
            && receipt
                .as_ref()
                .is_none_or(|a| screen && a.tiktok.is_none());
        let publication = publications
            .iter()
            .filter(|x| x.slot_id == slot_id)
            .max_by_key(|x| x.published_at);
        let unsent = !attempts.is_empty()
            && attempts.iter().all(|a| {
                matches!(
                    a.outcome(),
                    Some(PublishOutcome::Failed(_) | PublishOutcome::Refused(_))
                )
            });
        let failed = publication.is_none() && (unsent || slot.state == SlotState::Retired);
        let result = publication.and_then(|x| {
            measurements
                .iter()
                .filter(|m| {
                    m.publication_id == Some(x.id) && m.status == MeasurementStatus::Complete
                })
                .max_by_key(|m| (m.window, m.measured_at))
                .map(|m| ResultFact {
                    version_id: v.id,
                    publication_id: x.id,
                    window: m.window,
                    measured_at: m.measured_at,
                    metrics: m.raw_metrics.clone(),
                })
        });
        out.push(VersionFact {
            version_id: v.id,
            approval: ApprovalFact {
                version_id: v.id,
                slot_id,
                required,
                waiting,
                approved_by: receipt.as_ref().map(|a| a.by),
                approved_at: receipt.as_ref().map(|a| a.at),
            },
            publication: PublicationFact {
                version_id: v.id,
                slot_id,
                capability_id: slot.capability_id,
                account_name: account.as_ref().map(|c| c.name.clone()),
                state: slot.state,
                scheduled_at: slot.scheduled_at,
                published_at: publication.map(|x| x.published_at),
                url: publication.and_then(|x| x.url.as_ref().map(|u| u.to_string())),
                failed,
            },
            result,
        });
    }
    Ok(out)
}
