//! `knowledge_settle` (design §4.10.6): the job's body for one workspace, every ten minutes.
//!
//! 1. Seed when not seeded (§4.3), in a bundle of its own.
//! 2. **Repair**: no frame and the knowledge base not empty (only after a bootstrap that was
//!    skipped, by the invariant of §4.3.1): a bootstrap, approved by the person whose change it
//!    was; it wakes nobody.
//! 3. **Normalise**: a frame whose system fields differ from what the knowledge base makes of
//!    them (channels not `[any]`, a topic off `any` or not posting, a channel mix, the lanes or
//!    `paid_enabled` against the caps) gets a version with cause `normalize`, every topic kept.
//!    The prohibitions, goals and identity are copied too, but a difference in them alone is
//!    never a reason: they are read live.
//! 4. **Close**: closing topics nothing names any more are retired (cause `close`; with step 3
//!    in one version, cause `normalize`). Neither wakes anyone.
//! 5. Proposals past their time expire.
//!
//! Steps 2 to 5 run in one bundle, taking the locks of §4.10.13 in order.

use jt_knowledge::frame::{FrameCause, FrameParts, normalised_frame};
use jt_knowledge::is_empty;
use serde::Serialize;

use super::frame::{self, Applied, Request, Waking};
use super::seed;
use crate::ctx::Ctx;
use crate::error::AppError;
use crate::usecases::Deps;
use crate::usecases::studio::owner_request;

/// What one settle did in a workspace.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Settled {
    /// The knowledge base was seeded by this run.
    pub seeded: bool,
    /// The frame this run applied, if any (repair, normalize or close).
    pub applied: Option<Applied>,
    /// Proposals it expired.
    pub expired: u64,
}

impl Settled {
    /// Whether the run changed anything.
    pub fn changed(&self) -> bool {
        self.seeded || self.applied.as_ref().is_some_and(|a| a.applied) || self.expired > 0
    }
}

/// Settles the knowledge base of `ctx`'s workspace (see the module docs). `ctx` is the job's,
/// the system acting.
pub async fn settle(deps: &Deps, ctx: &Ctx) -> Result<Settled, AppError> {
    let seeded = seed::ensure(deps, ctx).await?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.strategy().lock_draft().await?;
    let in_force = r.strategy().lock_execution_frame().await?;
    let mut settings = r
        .knowledge()
        .lock_settings()
        .await?
        .ok_or_else(|| AppError::internal("the knowledge base is not seeded"))?;
    let none = FrameParts::default();
    let applied = match in_force {
        None if !is_empty(&r.knowledge().cards().await?) => {
            let approver = settings.changed_by;
            Some(
                frame::apply_locked(
                    deps,
                    ctx,
                    r.as_mut(),
                    &mut settings,
                    Request {
                        cause: FrameCause::Bootstrap,
                        next: &none,
                        approver,
                        waking: Waking::Nobody,
                    },
                )
                .await?,
            )
        }
        None => None,
        Some(v) => {
            let hypotheses = r.hypotheses().list(v.id).await?;
            let normal = normalised_frame(
                &v.sections,
                &hypotheses,
                &settings,
                owner_request::id(ctx.workspace_id),
            );
            let closing = !settings.closing_topic_ids.is_empty();
            if normal && !closing {
                None
            } else {
                let cause = if normal {
                    FrameCause::Close
                } else {
                    FrameCause::Normalize
                };
                Some(
                    frame::apply_locked(
                        deps,
                        ctx,
                        r.as_mut(),
                        &mut settings,
                        Request {
                            cause,
                            next: &none,
                            approver: None,
                            waking: Waking::Nobody,
                        },
                    )
                    .await?,
                )
            }
        }
    };
    let expired = r.knowledge().expire_proposals(ctx.now).await?;
    let out = Settled {
        seeded,
        applied,
        expired,
    };
    let wrote = out
        .applied
        .as_ref()
        .is_some_and(|a| a.applied || a.skipped.is_some());
    if wrote || expired > 0 {
        r.knowledge().save_settings(&settings).await?;
        r.commit().await?;
    }
    Ok(out)
}
