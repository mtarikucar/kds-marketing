//! `strategy.frame_apply` (design 2026-11-19 §4.10.3, MCP only): an agent applies what it derived
//! from the knowledge base's cards to the internal frame.
//!
//! The call names the knowledge revision it read (`kb_revision`) and the derivations it answers
//! (`parts`): `posting` (the audience, the objective and the topics; `content.work`) and
//! `prospecting` (the ICP, the rubric and the segments its entries add; `prospects.work`). A part
//! listed with none of its fields is "unchanged": acknowledged, nothing else. `paid_cadence`
//! (`ads.work`) sets the paid cadence of named topics, alone or with a part, and retires nothing.
//! Identity, channels, prohibitions, goals and budgets are never sent (D32): the system takes
//! them from the cards and the owner's rules.
//!
//! Refusals, before anything is read: `FORBIDDEN` `agent_only` (a person), `FORBIDDEN`
//! `part_permission {part, permission}`, `VALIDATION` `part_not_listed {field}` (a field of a
//! part not in `parts`), `VALIDATION` `parts_required`, `VALIDATION` with `details.gaps` (the
//! input's shape, each gap naming the caller's own path, `topics[2].angle`). Then, under the
//! frame's locks (`frame::apply_locked`): `CONFLICT` `kb_revision_ahead`, `CONFLICT`
//! `derivation_stale`, `CONFLICT` `knowledge_empty`, `FORBIDDEN` `hypothesis_reserved`, and the
//! merge's gaps. A replay by `request_key` answers the first call's answer.
//!
//! The version it writes is approved by the key's issuer; its wakes (design §4.10.8) are on behalf
//! of the knowledge base's last editor, never the deriving agent's own.

use jt_knowledge::frame::{
    DerivePart, FrameCause, FrameParts, PaidCadence, ProspectingInput, TopicInput,
};
use jt_ledger::Actor;
use jt_strategy::{Gap, HypothesisId, SectionValue, Segment, parse_section_strict};
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::frame::{self, Request, TopicOut, Waking};
use super::{agent, invalid, refused, seed};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::usecases::{Deps, hash_token};

/// The request receipts' action.
const FRAME_APPLY: &str = "strategy.frame_apply";

/// The longest objective a derivation sends, in characters.
pub const MAX_OBJECTIVE_CHARS: usize = 2_000;

/// `strategy.frame_apply`'s input. The parts' fields are taken as written and parsed strictly
/// here, so that a gap names the caller's own path.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrameApplyInput {
    /// 1 to 128 characters; a replay answers the same.
    pub request_key: String,
    /// The knowledge revision the derivation read (`knowledge_get.revision`).
    pub kb_revision: u64,
    /// The derivations this call answers. Empty only when `paid_cadence` is sent.
    #[serde(default)]
    pub parts: Vec<DerivePart>,
    /// posting: `[{key, name, description}]`.
    #[serde(default)]
    pub audience: Option<Value>,
    /// posting: at most 2000 characters.
    #[serde(default)]
    pub objective: Option<String>,
    /// posting: at most 30 `{id?, title, segment_key, angle, metric, prior_confidence?,
    /// cadence?: {organic}}`.
    #[serde(default)]
    pub topics: Option<Value>,
    /// prospecting: `{icp, rubric, segments?}`.
    #[serde(default)]
    pub prospecting: Option<Value>,
    /// ads.work: `[{topic_id, cadence}]`.
    #[serde(default)]
    pub paid_cadence: Option<Value>,
}

/// What `strategy.frame_apply` answers.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FrameApplyOut {
    /// Whether a version was written (only a structural change writes one).
    pub applied: bool,
    /// Not applied, though the texts differ: they are written with the next structural change.
    pub text_only: bool,
    /// The number of the frame in force after the call.
    pub number: i32,
    pub kept: u32,
    pub added: u32,
    pub retired: u32,
    /// Topics left out, kept for their posts; the system retires them after.
    pub closing: Vec<HypothesisId>,
    /// Segments the merge carried for rows the call did not send.
    pub kept_segments: Vec<String>,
    /// The frame in force's topics, without the owner's request and closing topics.
    pub topics: Vec<TopicView>,
}

/// A topic of the frame in force, as an agent names it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TopicView {
    pub id: HypothesisId,
    pub title: String,
    pub segment_key: String,
}

impl From<TopicOut> for TopicView {
    fn from(t: TopicOut) -> TopicView {
        TopicView {
            id: t.id,
            title: t.title,
            segment_key: t.segment_key,
        }
    }
}

/// Applies an agent's derivation (see the module docs).
pub async fn frame_apply(
    deps: &Deps,
    ctx: &Ctx,
    input: FrameApplyInput,
) -> Result<FrameApplyOut, AppError> {
    agent(ctx)?;
    let issuer = match &ctx.actor {
        Actor::Agent { user_id, .. } | Actor::Human { user_id } => Some(*user_id),
        Actor::System { .. } => None,
    };
    let key =
        jt_knowledge::validate_text("request_key", &input.request_key, 1, 128).map_err(invalid)?;
    let next = parse(ctx, &input)?;
    seed::ensure(deps, ctx).await?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    // The frame's locks, in the one order of design §4.10.13, before the receipt is read: two
    // calls under one key serialise here.
    r.strategy().lock_draft().await?;
    r.strategy().lock_execution_frame().await?;
    let mut settings = r
        .knowledge()
        .lock_settings()
        .await?
        .ok_or_else(|| AppError::internal("the knowledge base is not seeded"))?;
    let payload = json!(hash_token(&serde_json::to_string(&input).map_err(|e| {
        AppError::internal(format!("cannot encode the input: {e}"))
    })?));
    if let Some(answer) = r
        .studio()
        .request_replay(FRAME_APPLY, &key, &payload)
        .await?
    {
        return serde_json::from_value(answer)
            .map_err(|_| AppError::internal("a request receipt holds no frame answer"));
    }
    let waking = settings.changed_by.map_or(Waking::Nobody, Waking::For);
    let applied = frame::apply_locked(
        deps,
        ctx,
        r.as_mut(),
        &mut settings,
        Request {
            cause: FrameCause::Derive,
            next: &next,
            approver: issuer,
            waking,
        },
    )
    .await?;
    r.knowledge().save_settings(&settings).await?;
    let out = FrameApplyOut {
        applied: applied.applied,
        text_only: applied.text_only,
        number: applied.number,
        kept: applied.kept,
        added: applied.added,
        retired: applied.retired,
        closing: applied.closing,
        kept_segments: applied.kept_segments,
        topics: applied.topics.into_iter().map(TopicView::from).collect(),
    };
    let stored = serde_json::to_value(&out)
        .map_err(|e| AppError::internal(format!("cannot encode the answer: {e}")))?;
    r.studio()
        .request_receipt(FRAME_APPLY, &key, &payload, &stored)
        .await?;
    r.commit().await?;
    Ok(out)
}

/// The permission each part of a derivation needs.
fn part_permission(part: DerivePart) -> Permission {
    match part {
        DerivePart::Posting => Permission::ContentWork,
        DerivePart::Prospecting => Permission::ProspectsWork,
    }
}

/// `FORBIDDEN` `part_permission` naming what the caller lacks.
fn lacks(part: &str, permission: Permission) -> AppError {
    refused(
        ErrorCode::Forbidden,
        "part_permission",
        &format!("deriving {part} needs {}", permission.key()),
        json!({ "part": part, "permission": permission.key() }),
    )
}

/// The input checked and parsed into what the merge takes: the parts and their permissions, the
/// fields of each part listed, and the shapes, every gap at once.
fn parse(ctx: &Ctx, input: &FrameApplyInput) -> Result<FrameParts, AppError> {
    let mut parts: Vec<DerivePart> = Vec::new();
    for p in &input.parts {
        if !parts.contains(p) {
            parts.push(*p);
        }
    }
    parts.sort();
    if parts.is_empty() && input.paid_cadence.is_none() {
        return Err(AppError::validation(
            "name the derivations this call answers in parts (posting, prospecting), or send \
             paid_cadence",
            json!({ "field": "parts", "reason": "parts_required" }),
        ));
    }
    for part in &parts {
        let needed = part_permission(*part);
        if !ctx.permissions.contains(&needed) {
            return Err(lacks(part.key(), needed));
        }
    }
    if input.paid_cadence.is_some() && !ctx.permissions.contains(&Permission::AdsWork) {
        return Err(lacks("paid_cadence", Permission::AdsWork));
    }
    let listed = |part: DerivePart, field: &str, sent: bool| {
        if sent && !parts.contains(&part) {
            Err(AppError::validation(
                format!(
                    "{field} belongs to the {} part: list it in parts",
                    part.key()
                ),
                json!({ "field": field, "reason": "part_not_listed", "part": part.key() }),
            ))
        } else {
            Ok(())
        }
    };
    listed(DerivePart::Posting, "audience", input.audience.is_some())?;
    listed(DerivePart::Posting, "objective", input.objective.is_some())?;
    listed(DerivePart::Posting, "topics", input.topics.is_some())?;
    listed(
        DerivePart::Prospecting,
        "prospecting",
        input.prospecting.is_some(),
    )?;

    let mut gaps: Vec<Gap> = Vec::new();
    let audience =
        input
            .audience
            .as_ref()
            .and_then(|v| match parse_section_strict("audience", v) {
                Ok(SectionValue::Audience(s)) => Some(s),
                Ok(_) => None,
                Err(g) => {
                    gaps.extend(g);
                    None
                }
            });
    let objective = match &input.objective {
        Some(o) if o.chars().count() > MAX_OBJECTIVE_CHARS => {
            gaps.push(Gap {
                field: "objective".into(),
                message: format!("at most {MAX_OBJECTIVE_CHARS} characters"),
            });
            None
        }
        other => other.clone(),
    };
    let topics = input
        .topics
        .as_ref()
        .map(|v| list::<TopicInput>("topics", v, &mut gaps));
    let prospecting = input
        .prospecting
        .as_ref()
        .and_then(|v| prospecting(v, &mut gaps));
    let paid_cadence = input
        .paid_cadence
        .as_ref()
        .map(|v| list::<PaidCadence>("paid_cadence", v, &mut gaps));
    if !gaps.is_empty() {
        return Err(AppError::validation(
            "the derivation is not valid",
            json!({ "gaps": gaps }),
        ));
    }
    Ok(FrameParts {
        kb_revision: input.kb_revision,
        parts,
        audience,
        objective,
        topics,
        prospecting,
        paid_cadence,
    })
}

/// A list of `T` as written under `field`, each element parsed on its own so that a gap names
/// its index (`topics[2]`); the elements that parse.
fn list<T: serde::de::DeserializeOwned>(field: &str, value: &Value, gaps: &mut Vec<Gap>) -> Vec<T> {
    let Some(items) = value.as_array() else {
        gaps.push(Gap {
            field: field.to_owned(),
            message: "a list is expected".into(),
        });
        return Vec::new();
    };
    let mut out = Vec::new();
    for (i, item) in items.iter().enumerate() {
        match T::deserialize(item) {
            Ok(t) => out.push(t),
            Err(e) => gaps.push(Gap {
                field: format!("{field}[{i}]"),
                message: e.to_string(),
            }),
        }
    }
    out
}

/// The prospecting part as written: `{icp, rubric}` parsed as the strategy's prospecting section
/// is, and `segments` as its audience is (paths `prospecting.segments[i]…`).
fn prospecting(value: &Value, gaps: &mut Vec<Gap>) -> Option<ProspectingInput> {
    let Some(map) = value.as_object() else {
        gaps.push(Gap {
            field: "prospecting".into(),
            message: "an object {icp, rubric, segments?} is expected".into(),
        });
        return None;
    };
    let mut rest = map.clone();
    let segments = rest.remove("segments");
    let parsed = match parse_section_strict("prospecting", &Value::Object(rest)) {
        Ok(SectionValue::Prospecting(p)) => Some(p),
        Ok(_) => None,
        Err(g) => {
            gaps.extend(g);
            None
        }
    };
    let segments: Vec<Segment> = match segments {
        None => Vec::new(),
        Some(v) => match parse_section_strict("audience", &v) {
            Ok(SectionValue::Audience(s)) => s,
            Ok(_) => Vec::new(),
            Err(g) => {
                gaps.extend(g.into_iter().map(|g| Gap {
                    field: g.field.replacen("audience", "prospecting.segments", 1),
                    message: g.message,
                }));
                Vec::new()
            }
        },
    };
    let p = parsed?;
    Some(ProspectingInput {
        icp: p.icp,
        rubric: p.rubric,
        segments,
    })
}
