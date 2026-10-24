//! Transactional fake of the Studio storage contract, including exclusive claims.
use super::{
    state::{MemBundle, MemState, same_workspace},
    tenant::MemTenant,
};
use async_trait::async_trait;
use jt_app::{
    error::AppError,
    ports::{BudgetRepo, CapabilityRepo, StrategyRepo, files::StoredFile, studio::*},
};
use jt_ledger::{Action, Actor, LedgerEntry};
use jt_strategy::LaneKind;
use jt_studio::{RetirementReason, SlotEvent, StudioError, StudioPolicy, transition_slot};
use jt_tenancy::WorkspaceId;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
#[derive(Clone, Debug, Default)]
pub struct MemStudio {
    pub arms: Vec<Arm>,
    pub slots: Vec<Slot>,
    pub pieces: Vec<(SlotId, Piece)>,
    pub files: Vec<StoredFile>,
    pub attempts: Vec<PublishAttempt>,
    pub publications: Vec<Publication>,
    pub measurements: Vec<Measurement>,
    pub learning: Vec<LearningUpdate>,
    pub trends: Vec<TrendSignal>,
    pub bindings: Vec<AdSetBinding>,
    pub moves: Vec<BudgetMove>,
    pub reservations: Vec<(SpendReservation, Option<SpendOutcome>)>,
    pub controls: Vec<StudioControl>,
    pub binding_controls: Vec<BindingControl>,
    pub approvals: Vec<(WorkspaceId, ApprovalTarget, ApprovalReceipt)>,
    receipts: Vec<(WorkspaceId, String, String, String, Value)>,
}
fn invalid(e: StudioError) -> AppError {
    AppError::conflict(e.to_string())
}
fn enc<T: Serialize>(v: &T) -> Result<Value, AppError> {
    serde_json::to_value(v).map_err(|_| AppError::internal("invalid Studio record"))
}
fn hash(v: &Value) -> String {
    hex::encode(Sha256::digest(v.to_string().as_bytes()))
}
impl MemTenant {
    fn studio_write(
        &mut self,
        f: impl FnOnce(&mut MemStudio, &MemState) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        self.call(|this| {
            let mut s = this.state().studio.clone();
            f(&mut s, this.state())?;
            this.tx.write(move |state| state.studio = s.clone());
            Ok(())
        })
    }
    fn replay<T: DeserializeOwned>(
        &self,
        action: &str,
        key: &str,
        payload: &Value,
    ) -> Result<Option<T>, AppError> {
        if key.trim().is_empty() {
            return Err(AppError::validation("request key is required", json!({})));
        }
        if let Some((_, _, _, digest, value)) = self
            .state()
            .studio
            .receipts
            .iter()
            .find(|(w, a, k, _, _)| *w == self.ws && a == action && k == key)
        {
            if *digest != hash(payload) {
                return Err(AppError::conflict("request key payload mismatch"));
            }
            return serde_json::from_value(value.clone())
                .map(Some)
                .map_err(|_| AppError::internal("invalid receipt"));
        }
        Ok(None)
    }
    fn receipt<T: Serialize>(
        &mut self,
        action: &str,
        key: &str,
        payload: &Value,
        response: &T,
    ) -> Result<(), AppError> {
        let row = (
            self.ws,
            action.to_owned(),
            key.to_owned(),
            hash(payload),
            enc(response)?,
        );
        self.studio_write(|s, _| {
            s.receipts.push(row);
            Ok(())
        })
    }
    fn check_chain(&self, c: &Chain) -> Result<(), AppError> {
        same_workspace(self.ws, c.workspace_id)?;
        c.validate().map_err(invalid)?;
        if !self.state().hypotheses.iter().any(|h| {
            h.workspace_id == self.ws
                && h.version_id == c.born_version_id
                && h.hypothesis.id == c.hypothesis_id
        }) || !self.state().studio.arms.iter().any(|a| {
            a.workspace_id == self.ws && a.id == c.arm_id && a.key.hypothesis_id == c.hypothesis_id
        }) {
            return Err(AppError::not_found("chain"));
        }
        Ok(())
    }
    fn write_slot(&mut self, slot: Slot) -> Result<(), AppError> {
        self.studio_write(|s, _| {
            let old = s
                .slots
                .iter_mut()
                .find(|r| r.id == slot.id && r.chain.workspace_id == slot.chain.workspace_id)
                .ok_or_else(|| AppError::not_found("slot"))?;
            *old = slot;
            Ok(())
        })
    }
}
#[async_trait]
impl StudioControlRepo for MemTenant {
    async fn set_policy(
        &mut self,
        expected: u64,
        lane: LaneKind,
        required: bool,
    ) -> Result<StudioControl, AppError> {
        let mut c = self.lock_control().await?;
        if c.revision != expected {
            return Err(AppError::conflict("control revision changed"));
        }
        c.lanes.entry(lane).or_default().requires_human_approval = required;
        c.revision = c
            .revision
            .checked_add(1)
            .ok_or_else(|| AppError::conflict("revision overflow"))?;
        self.studio_write(|s, _| {
            *s.controls
                .iter_mut()
                .find(|r| r.workspace_id == c.workspace_id)
                .expect("locked") = c.clone();
            Ok(())
        })?;
        Ok(c)
    }
    async fn binding_control(
        &mut self,
        id: AdSetBindingId,
    ) -> Result<Option<BindingControl>, AppError> {
        Ok(self
            .state()
            .studio
            .binding_controls
            .iter()
            .find(|c| c.chain.workspace_id == self.ws && c.binding_id == id)
            .cloned())
    }
    async fn save_binding_control(&mut self, c: BindingControl) -> Result<(), AppError> {
        self.tx.lock_studio().await;
        let b = self
            .get_binding(c.binding_id)
            .await?
            .ok_or_else(|| AppError::not_found("binding"))?;
        b.chain.require_same(&c.chain).map_err(invalid)?;
        self.studio_write(|s, _| {
            s.binding_controls.retain(|r| {
                !(r.chain.workspace_id == c.chain.workspace_id && r.binding_id == c.binding_id)
            });
            s.binding_controls.push(c);
            Ok(())
        })
    }
    async fn lock_control(&mut self) -> Result<StudioControl, AppError> {
        self.tx.lock_studio().await;
        if let Some(c) = self
            .state()
            .studio
            .controls
            .iter()
            .find(|c| c.workspace_id == self.ws)
        {
            return Ok(c.clone());
        }
        let c = StudioControl {
            workspace_id: self.ws,
            brake_engaged: false,
            revision: 0,
            lanes: Default::default(),
        };
        self.studio_write(|s, _| {
            s.controls.push(c.clone());
            Ok(())
        })?;
        Ok(c)
    }
    async fn set_brake(
        &mut self,
        expected: u64,
        lane: Option<LaneKind>,
        engaged: bool,
    ) -> Result<StudioControl, AppError> {
        let mut c = self.lock_control().await?;
        if c.revision != expected {
            return Err(AppError::conflict("control revision changed"));
        }
        if let Some(l) = lane {
            c.lanes.entry(l).or_default().brake_engaged = engaged;
        } else {
            c.brake_engaged = engaged;
        }
        c.revision = c
            .revision
            .checked_add(1)
            .ok_or_else(|| AppError::conflict("revision overflow"))?;
        self.studio_write(|s, _| {
            *s.controls
                .iter_mut()
                .find(|r| r.workspace_id == c.workspace_id)
                .expect("locked") = c.clone();
            Ok(())
        })?;
        Ok(c)
    }
}
#[async_trait]
impl StudioRepo for MemTenant {
    async fn list_arms(&mut self) -> Result<Vec<Arm>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .studio
            .arms
            .iter()
            .filter(|a| a.workspace_id == self.ws)
            .cloned()
            .collect();
        rows.sort_by_key(|a| a.id);
        Ok(rows)
    }
    async fn list_budget_moves(&mut self) -> Result<Vec<BudgetMove>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .studio
            .moves
            .iter()
            .filter(|m| {
                m.chain.workspace_id == self.ws && m.state == jt_studio::BudgetMoveState::Queued
            })
            .cloned()
            .collect();
        rows.sort_by_key(|m| m.id);
        Ok(rows)
    }
    async fn get_trend(&mut self, id: TrendSignalId) -> Result<Option<TrendSignal>, AppError> {
        Ok(self
            .state()
            .studio
            .trends
            .iter()
            .find(|t| t.workspace_id == self.ws && t.id == id)
            .cloned())
    }
    async fn slot_evidence(
        &mut self,
        slot: SlotId,
    ) -> Result<(Vec<PublishAttempt>, Vec<Measurement>), AppError> {
        let s = &self.state().studio;
        let mut attempts: Vec<_> = s
            .attempts
            .iter()
            .filter(|a| a.piece().chain.workspace_id == self.ws && a.slot_id() == slot)
            .cloned()
            .collect();
        attempts.sort_by_key(|a| a.id());
        let mut measurements: Vec<_> = s
            .measurements
            .iter()
            .filter(|m| {
                m.chain.workspace_id == self.ws
                    && s.publications.iter().any(|p| {
                        p.chain.workspace_id == self.ws
                            && p.slot_id == slot
                            && m.publication_id == Some(p.id)
                    })
            })
            .cloned()
            .collect();
        measurements.sort_by_key(|m| m.id);
        Ok((attempts, measurements))
    }

    async fn get_approval(
        &mut self,
        target: ApprovalTarget,
        revision: u64,
    ) -> Result<Option<ApprovalReceipt>, AppError> {
        Ok(self
            .state()
            .studio
            .approvals
            .iter()
            .find(|(w, t, a)| *w == self.ws && *t == target && a.revision == revision)
            .map(|(_, _, a)| a.clone()))
    }
    async fn get_arm(&mut self, id: ArmId) -> Result<Option<Arm>, AppError> {
        Ok(self
            .state()
            .studio
            .arms
            .iter()
            .find(|r| r.workspace_id == self.ws && r.id == id)
            .cloned())
    }
    async fn get_piece(&mut self, slot: SlotId, revision: u64) -> Result<Option<Piece>, AppError> {
        Ok(self
            .state()
            .studio
            .pieces
            .iter()
            .find(|(s, p)| *s == slot && p.chain.workspace_id == self.ws && p.revision == revision)
            .map(|(_, p)| p.clone()))
    }
    async fn get_budget_move(&mut self, id: BudgetMoveId) -> Result<Option<BudgetMove>, AppError> {
        Ok(self
            .state()
            .studio
            .moves
            .iter()
            .find(|r| r.chain.workspace_id == self.ws && r.id == id)
            .cloned())
    }
    async fn latest_budget_move(
        &mut self,
        binding: AdSetBindingId,
    ) -> Result<Option<BudgetMove>, AppError> {
        Ok(self
            .state()
            .studio
            .moves
            .iter()
            .filter(|m| m.chain.workspace_id == self.ws && m.binding_id == binding)
            .max_by_key(|m| m.id)
            .cloned())
    }
    async fn get_publication(
        &mut self,
        id: PublicationId,
    ) -> Result<Option<Publication>, AppError> {
        Ok(self
            .state()
            .studio
            .publications
            .iter()
            .find(|r| r.chain.workspace_id == self.ws && r.id == id)
            .cloned())
    }
    async fn get_binding(&mut self, id: AdSetBindingId) -> Result<Option<AdSetBinding>, AppError> {
        Ok(self
            .state()
            .studio
            .bindings
            .iter()
            .find(|r| r.chain.workspace_id == self.ws && r.id == id)
            .cloned())
    }
    async fn list_bindings(&mut self) -> Result<Vec<AdSetBinding>, AppError> {
        Ok(self
            .state()
            .studio
            .bindings
            .iter()
            .filter(|r| r.chain.workspace_id == self.ws)
            .cloned()
            .collect())
    }
    async fn approve_target(
        &mut self,
        target: ApprovalTarget,
        receipt: ApprovalReceipt,
    ) -> Result<(), AppError> {
        self.tx.lock_studio().await;
        let ws = self.ws;
        self.studio_write(|s, _| {
            match target {
                ApprovalTarget::Slot(id) => {
                    let slot = s
                        .slots
                        .iter()
                        .find(|s| s.chain.workspace_id == ws && s.id == id)
                        .ok_or_else(|| AppError::not_found("slot"))?;
                    if slot.state != SlotState::Ready || slot.revision != receipt.revision {
                        return Err(AppError::conflict("approval revision changed"));
                    }
                    let _p = s
                        .pieces
                        .iter_mut()
                        .find(|(s, p)| {
                            *s == id && p.chain.workspace_id == ws && p.revision == receipt.revision
                        })
                        .ok_or_else(|| AppError::not_found("piece"))?;
                }
                ApprovalTarget::BudgetMove(id) => {
                    let m = s
                        .moves
                        .iter_mut()
                        .find(|m| m.chain.workspace_id == ws && m.id == id)
                        .ok_or_else(|| AppError::not_found("budget move"))?;
                    if m.state != jt_studio::BudgetMoveState::Queued
                        || m.revision != receipt.revision
                    {
                        return Err(AppError::conflict("approval revision changed"));
                    }
                    m.approval = Some(receipt.clone());
                }
            }
            s.approvals
                .retain(|(w, t, a)| !(*w == ws && *t == target && a.revision == receipt.revision));
            s.approvals.push((ws, target, receipt));
            Ok(())
        })
    }
    async fn apply_transition(&mut self, change: &StrategyChange) -> Result<(), AppError> {
        self.tx.lock_studio().await;
        let ws = self.ws;
        self.studio_write(|s, _| {
            for slot in &mut s.slots {
                if slot.chain.workspace_id == ws
                    && (change.current.is_none()
                        || change.retired.contains(&slot.chain.hypothesis_id))
                    && matches!(slot.state, SlotState::Planned | SlotState::Ready)
                {
                    slot.state = SlotState::Retired;
                    slot.revision = slot
                        .revision
                        .checked_add(1)
                        .ok_or_else(|| AppError::conflict("revision overflow"))?;
                }
            }
            for m in &mut s.moves {
                if m.chain.workspace_id == ws
                    && (change.current.is_none() || change.retired.contains(&m.chain.hypothesis_id))
                    && m.state == jt_studio::BudgetMoveState::Queued
                {
                    m.state = jt_studio::BudgetMoveState::Cancelled;
                }
            }
            Ok(())
        })
    }
    async fn insert_arm(&mut self, a: Arm) -> Result<Arm, AppError> {
        same_workspace(self.ws, a.workspace_id)?;
        a.validate().map_err(invalid)?;
        self.tx.lock_studio().await;
        if !self
            .state()
            .hypotheses
            .iter()
            .any(|h| h.workspace_id == self.ws && h.hypothesis.id == a.key.hypothesis_id)
        {
            return Err(AppError::not_found("arm hypothesis"));
        }
        if let Some(old) = self
            .state()
            .studio
            .arms
            .iter()
            .find(|r| r.workspace_id == self.ws && r.key == a.key)
        {
            return Ok(old.clone());
        }
        self.studio_write(|s, _| {
            if s.arms
                .iter()
                .any(|r| r.id == a.id && r.workspace_id == a.workspace_id)
            {
                return Err(AppError::conflict("arm id"));
            }
            s.arms.push(a.clone());
            Ok(())
        })?;
        Ok(a)
    }
    async fn get_slot(&mut self, id: SlotId) -> Result<Option<Slot>, AppError> {
        Ok(self
            .state()
            .studio
            .slots
            .iter()
            .find(|s| s.chain.workspace_id == self.ws && s.id == id)
            .cloned())
    }
    async fn list_slots(&mut self, q: SlotQuery) -> Result<Vec<Slot>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .studio
            .slots
            .iter()
            .filter(|s| {
                s.chain.workspace_id == self.ws
                    && s.scheduled_at >= q.from
                    && s.scheduled_at < q.until
                    && q.hypothesis_id.is_none_or(|h| s.chain.hypothesis_id == h)
                    && q.lane.is_none_or(|l| {
                        self.state().studio.arms.iter().any(|a| {
                            a.workspace_id == self.ws && a.id == s.chain.arm_id && a.key.lane == l
                        })
                    })
            })
            .cloned()
            .collect();
        rows.sort_by_key(|s| (s.scheduled_at, s.id));
        Ok(rows)
    }
    async fn insert_slots(&mut self, key: &str, slots: Vec<Slot>) -> Result<Vec<Slot>, AppError> {
        self.tx.lock_studio().await;
        let payload = enc(&slots)?;
        if let Some(r) = self.replay("slots.insert", key, &payload)? {
            return Ok(r);
        }
        for s in &slots {
            self.check_chain(&s.chain)?;
            s.validate().map_err(invalid)?;
            if s.state != SlotState::Planned || s.revision != 0 {
                return Err(AppError::conflict(
                    "new slot must be planned at revision zero",
                ));
            }
            if !self
                .state()
                .capabilities
                .iter()
                .any(|c| c.capability.workspace_id == self.ws && c.capability.id == s.capability_id)
            {
                return Err(AppError::not_found("capability"));
            }
        }
        self.studio_write(|state, _| {
            for s in &slots {
                if state
                    .slots
                    .iter()
                    .any(|r| r.id == s.id && r.chain.workspace_id == s.chain.workspace_id)
                {
                    return Err(AppError::conflict("slot id"));
                }
                state.slots.push(s.clone());
            }
            Ok(())
        })?;
        self.receipt("slots.insert", key, &payload, &slots)?;
        Ok(slots)
    }
    async fn save_piece(
        &mut self,
        id: SlotId,
        expected: u64,
        p: Piece,
        key: &str,
    ) -> Result<Slot, AppError> {
        self.tx.lock_studio().await;
        let payload = json!([id, expected, p]);
        if let Some(r) = self.replay("piece.save", key, &payload)? {
            return Ok(r);
        }
        let slot = self
            .get_slot(id)
            .await?
            .ok_or_else(|| AppError::not_found("slot"))?;
        let next = transition_slot(
            &slot,
            &SlotEvent::PieceSubmitted { piece: p.clone() },
            &StudioPolicy {
                expected_revision: expected,
                ..Default::default()
            },
        )
        .map_err(invalid)?;
        for m in p
            .media
            .iter()
            .chain(p.adaptations.values().flat_map(|c| c.media.iter()))
        {
            if let MediaAsset::File { id } = m {
                let file = self
                    .get_file(*id)
                    .await?
                    .ok_or_else(|| AppError::not_found("file"))?;
                if file.deleted_at.is_some() {
                    return Err(AppError::conflict("file has been deleted"));
                }
            }
        }
        self.studio_write(|s, _| {
            if s.pieces
                .iter()
                .any(|(_, r)| r.chain.workspace_id == p.chain.workspace_id && r.id == p.id)
            {
                return Err(AppError::conflict("piece id"));
            }
            s.pieces.push((id, p));
            Ok(())
        })?;
        self.write_slot(next.clone())?;
        self.receipt("piece.save", key, &payload, &next)?;
        Ok(next)
    }
    async fn retire_slot(
        &mut self,
        id: SlotId,
        expected: u64,
        reason: &str,
    ) -> Result<Slot, AppError> {
        self.tx.lock_studio().await;
        let reason: RetirementReason = serde_json::from_value(json!(reason))
            .map_err(|_| AppError::validation("unknown retirement reason", json!({})))?;
        let s = self
            .get_slot(id)
            .await?
            .ok_or_else(|| AppError::not_found("slot"))?;
        let next = transition_slot(
            &s,
            &SlotEvent::Retire { reason },
            &StudioPolicy {
                expected_revision: expected,
                ..Default::default()
            },
        )
        .map_err(invalid)?;
        self.write_slot(next.clone())?;
        Ok(next)
    }
    async fn claim_publication(
        &mut self,
        now: OffsetDateTime,
    ) -> Result<Option<PublishAttempt>, AppError> {
        let Some(v) = StrategyRepo::lock_execution_frame(self).await? else {
            return Ok(None);
        };
        let control = self.lock_control().await?;
        if control.is_braked(LaneKind::Organic) {
            return Ok(None);
        }
        let slot = self
            .list_slots(SlotQuery {
                from: OffsetDateTime::UNIX_EPOCH,
                until: now + time::Duration::nanoseconds(1),
                hypothesis_id: None,
                lane: Some(LaneKind::Organic),
            })
            .await?
            .into_iter()
            .find(|s| {
                s.state == SlotState::Ready
                    && !self
                        .state()
                        .studio
                        .attempts
                        .iter()
                        .any(|a| a.piece().chain.workspace_id == self.ws && a.slot_id() == s.id)
            });
        let Some(slot) = slot else { return Ok(None) };
        let piece = self
            .state()
            .studio
            .pieces
            .iter()
            .find(|(id, p)| {
                *id == slot.id && p.chain.workspace_id == self.ws && p.revision == slot.revision
            })
            .map(|(_, p)| p)
            .ok_or_else(|| AppError::not_found("piece"))?;
        let account = self
            .state()
            .capabilities
            .iter()
            .find(|c| c.capability.workspace_id == self.ws && c.capability.id == slot.capability_id)
            .and_then(|c| c.capability.external_id.clone());
        let a = PublishAttempt::claim(
            PublishAttemptId::new_v7(),
            &slot,
            piece,
            v.id,
            control.revision,
            Actor::System {
                component: "studio.publisher".into(),
            },
            now,
        )
        .map_err(invalid)?
        .with_account(account);
        self.studio_write(|s, _| {
            s.attempts.push(a.clone());
            Ok(())
        })?;
        self.attempt_ledger(&a, "studio.publish.claimed")?;
        Ok(Some(a))
    }
    async fn finish_publication(
        &mut self,
        id: PublishAttemptId,
        o: PublishOutcome,
    ) -> Result<(), AppError> {
        self.tx.lock_studio().await;
        let old = self
            .state()
            .studio
            .attempts
            .iter()
            .find(|a| a.piece().chain.workspace_id == self.ws && a.id() == id)
            .cloned()
            .ok_or_else(|| AppError::not_found("attempt"))?;
        use jt_studio::{PublishOutcome as O, RedactedPublishError as E};
        let outcome = match o {
            PublishOutcome::Succeeded(r) => {
                let mut url = r.url;
                if let Some(u) = &mut url {
                    u.set_query(None);
                    u.set_fragment(None);
                }
                O::Succeeded(jt_studio::PublishReceipt {
                    external_id: r.external_id,
                    url,
                })
            }
            PublishOutcome::Failed(_) => O::Failed(E::Permanent),
            PublishOutcome::Unknown(_) => O::Unknown(E::Transient),
            PublishOutcome::Refused(_) => O::Refused(E::Policy),
        };
        let a = old.finish(&outcome).map_err(invalid)?;
        if a == old {
            return Ok(());
        }
        if a.state() == PublishState::Succeeded {
            let p = a
                .publication(PublicationId::new_v7(), a.claimed_at())
                .map_err(invalid)?;
            let mut s = self
                .get_slot(a.slot_id())
                .await?
                .ok_or_else(|| AppError::not_found("slot"))?;
            p.validate_for_slot(&s).map_err(invalid)?;
            self.studio_write(|state, _| {
                if state.publications.iter().any(|r| {
                    r.chain.workspace_id == p.chain.workspace_id
                        && (r.slot_id == p.slot_id
                            || (r.capability_id == p.capability_id
                                && r.external_id == p.external_id))
                }) {
                    return Err(AppError::conflict("publication identity"));
                }
                state.publications.push(p);
                Ok(())
            })?;
            if s.state != SlotState::Retired {
                s.state = SlotState::Published;
                s.revision = s
                    .revision
                    .checked_add(1)
                    .ok_or_else(|| AppError::conflict("revision overflow"))?;
                self.write_slot(s)?;
            }
        }
        self.studio_write(|s, _| {
            *s.attempts
                .iter_mut()
                .find(|r| r.id() == id)
                .expect("loaded") = a.clone();
            Ok(())
        })?;
        self.attempt_ledger(&a, "studio.publish.finished")?;
        Ok(())
    }
    async fn save_file(&mut self, f: StoredFile) -> Result<(), AppError> {
        same_workspace(self.ws, f.workspace_id)?;
        self.tx.lock_studio().await;
        if f.id.0.is_nil()
            || f.size_bytes == 0
            || f.mime.trim().is_empty()
            || f.sha256.len() != 64
            || !f.sha256.bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err(AppError::validation("invalid file metadata", json!({})));
        }
        self.studio_write(|s, _| {
            if let Some(old) = s
                .files
                .iter_mut()
                .find(|r| r.workspace_id == f.workspace_id && r.id == f.id)
            {
                if old.sha256 != f.sha256
                    || old.size_bytes != f.size_bytes
                    || old.created_at != f.created_at
                    || old.mime != f.mime
                    || old.filename != f.filename
                    || (old.deleted_at.is_some() && old.deleted_at != f.deleted_at)
                {
                    return Err(AppError::conflict("file identity is immutable"));
                }
                *old = f;
            } else {
                s.files.push(f);
            }
            Ok(())
        })
    }
    async fn get_file(&mut self, id: FileId) -> Result<Option<StoredFile>, AppError> {
        Ok(self
            .state()
            .studio
            .files
            .iter()
            .find(|f| f.workspace_id == self.ws && f.id == id)
            .cloned())
    }
    async fn save_trend(&mut self, t: TrendSignal, key: &str) -> Result<TrendSignal, AppError> {
        same_workspace(self.ws, t.workspace_id)?;
        t.validate().map_err(invalid)?;
        self.tx.lock_studio().await;
        let p = enc(&t)?;
        if let Some(r) = self.replay("trend.save", key, &p)? {
            return Ok(r);
        }
        if !self.state().hypotheses.iter().any(|h| {
            h.workspace_id == self.ws
                && h.version_id == t.born_version_id
                && h.hypothesis.id == t.hypothesis_id
        }) {
            return Err(AppError::not_found("hypothesis"));
        }
        self.studio_write(|s, _| {
            if s.trends
                .iter()
                .any(|r| r.workspace_id == t.workspace_id && r.id == t.id)
            {
                return Err(AppError::conflict("trend id"));
            }
            s.trends.push(t.clone());
            Ok(())
        })?;
        self.receipt("trend.save", key, &p, &t)?;
        Ok(t)
    }
    async fn bind_adset(&mut self, b: AdSetBinding, key: &str) -> Result<AdSetBinding, AppError> {
        self.tx.lock_studio().await;
        self.check_chain(&b.chain)?;
        b.validate().map_err(invalid)?;
        let p = enc(&b)?;
        if let Some(r) = self.replay("adset.bind", key, &p)? {
            return Ok(r);
        }
        if !self
            .state()
            .capabilities
            .iter()
            .any(|c| c.capability.workspace_id == self.ws && c.capability.id == b.capability_id)
        {
            return Err(AppError::not_found("capability"));
        }
        self.studio_write(|s, _| {
            if s.bindings.iter().any(|r| {
                r.chain.workspace_id == b.chain.workspace_id
                    && (r.id == b.id
                        || (r.capability_id == b.capability_id && r.adset_id == b.adset_id))
            }) {
                return Err(AppError::conflict("binding identity"));
            }
            s.bindings.push(b.clone());
            Ok(())
        })?;
        self.receipt("adset.bind", key, &p, &b)?;
        Ok(b)
    }
    async fn save_budget_move(&mut self, m: BudgetMove, key: &str) -> Result<BudgetMove, AppError> {
        self.tx.lock_studio().await;
        self.check_chain(&m.chain)?;
        let p = enc(&m)?;
        if let Some(r) = self.replay("budget.move", key, &p)? {
            return Ok(r);
        }
        let b = self
            .state()
            .studio
            .bindings
            .iter()
            .find(|b| b.chain.workspace_id == self.ws && b.id == m.binding_id)
            .ok_or_else(|| AppError::not_found("binding"))?;
        m.validate_for_binding(b).map_err(invalid)?;
        if m.reservation_id.is_some_and(|id| {
            !self
                .state()
                .studio
                .reservations
                .iter()
                .any(|(r, _)| r.request.workspace_id == self.ws && r.id == id)
        }) || m.executed_version_id.is_some_and(|id| {
            !self
                .state()
                .strategy_versions
                .iter()
                .any(|v| v.workspace_id == self.ws && v.id == id)
        }) {
            return Err(AppError::not_found("budget execution fence"));
        }
        self.studio_write(|s, _| {
            if s.moves
                .iter()
                .any(|r| r.chain.workspace_id == m.chain.workspace_id && r.id == m.id)
            {
                return Err(AppError::conflict("move id"));
            }
            s.moves.push(m.clone());
            Ok(())
        })?;
        self.receipt("budget.move", key, &p, &m)?;
        Ok(m)
    }
    async fn record_measurement(&mut self, m: Measurement) -> Result<bool, AppError> {
        self.tx.lock_studio().await;
        self.check_chain(&m.chain)?;
        m.validate().map_err(invalid)?;
        let c = if let Some(id) = m.publication_id {
            self.state()
                .studio
                .publications
                .iter()
                .find(|p| p.chain.workspace_id == self.ws && p.id == id)
                .map(|p| &p.chain)
        } else {
            self.state()
                .studio
                .bindings
                .iter()
                .find(|b| b.chain.workspace_id == self.ws && Some(b.id) == m.binding_id)
                .map(|b| &b.chain)
        }
        .ok_or_else(|| AppError::not_found("measurement target"))?;
        c.require_same(&m.chain).map_err(invalid)?;
        let old = self
            .state()
            .studio
            .measurements
            .iter()
            .find(|r| {
                r.chain.workspace_id == self.ws
                    && ((m.publication_id.is_some()
                        && m.publication_id == r.publication_id
                        && m.window == r.window)
                        || (m.binding_id.is_some()
                            && m.binding_id == r.binding_id
                            && m.date == r.date
                            && m.metric_scope == r.metric_scope))
            })
            .cloned();
        if let Some(old) = &old {
            if *old == m {
                return Ok(false);
            }
            if old.status == MeasurementStatus::Complete {
                return Err(AppError::conflict(
                    "complete measurement requires an explicit correction",
                ));
            }
        }
        self.studio_write(|s, _| {
            if let Some(old) = old {
                s.measurements.retain(|r| {
                    !(r.id == old.id && r.chain.workspace_id == old.chain.workspace_id)
                });
            }
            if s.measurements.iter().any(|r| {
                r.chain.workspace_id == m.chain.workspace_id
                    && (r.id == m.id || r.evidence_key == m.evidence_key)
            }) {
                return Err(AppError::conflict("measurement identity"));
            }
            s.measurements.push(m);
            Ok(())
        })?;
        Ok(true)
    }
    async fn apply_learning(&mut self, u: LearningUpdate) -> Result<bool, AppError> {
        self.tx.lock_studio().await;
        self.check_chain(&u.chain)?;
        u.validate().map_err(invalid)?;
        if let Some(old) = self.state().studio.learning.iter().find(|r| {
            r.chain.workspace_id == self.ws
                && r.chain.hypothesis_id == u.chain.hypothesis_id
                && r.evidence_key == u.evidence_key
        }) {
            return if *old == u {
                Ok(false)
            } else {
                Err(AppError::conflict("learning evidence payload changed"))
            };
        }
        let m = self
            .state()
            .studio
            .measurements
            .iter()
            .find(|m| {
                m.chain.workspace_id == self.ws
                    && m.evidence_key == u.evidence_key
                    && m.status == MeasurementStatus::Complete
            })
            .ok_or_else(|| AppError::conflict("complete measurement required"))?;
        m.chain.require_same(&u.chain).map_err(invalid)?;
        self.studio_write(|s, _| {
            let a = s
                .arms
                .iter_mut()
                .find(|a| a.workspace_id == u.chain.workspace_id && a.id == u.chain.arm_id)
                .expect("validated");
            a.alpha += u.alpha_delta;
            a.beta += u.beta_delta;
            a.weight += u.weight_delta;
            a.validate().map_err(invalid)?;
            s.learning.push(u.clone());
            Ok(())
        })?;
        self.tx.write(move |s| {
            s.studio_learning.push((
                u.chain.workspace_id,
                u.chain.hypothesis_id,
                u.evidence_key.clone(),
                u.derived_confidence,
            ))
        });
        Ok(true)
    }
}
impl MemTenant {
    fn attempt_ledger(&mut self, a: &PublishAttempt, action: &str) -> Result<(), AppError> {
        let mut e = LedgerEntry::new(
            self.ws,
            a.actor().clone(),
            Action::new(action).map_err(|_| AppError::internal("action"))?,
            json!({"attempt_id":a.id(),"slot_id":a.slot_id(),"born_version_id":a.piece().chain.born_version_id,"executed_version_id":a.executed_version_id(),"state":a.state()}),
            a.claimed_at(),
        );
        e.subject = Some(jt_ledger::Subject {
            kind: "studio_slot".into(),
            id: a.slot_id().to_string(),
        });
        e.strategy_version_id = Some(a.executed_version_id().0);
        self.tx.append_ledger(e)?;
        Ok(())
    }
}
#[async_trait]
impl StudioBudgetRepo for MemTenant {
    async fn find_reservation(&mut self, key: &str) -> Result<Option<SpendReservation>, AppError> {
        Ok(self
            .state()
            .studio
            .reservations
            .iter()
            .find(|(r, _)| r.request.workspace_id == self.ws && r.request.evidence_key == key)
            .map(|(r, _)| r.clone()))
    }
    async fn reserve(&mut self, mut r: ReserveSpend) -> Result<SpendReservation, AppError> {
        same_workspace(self.ws, r.workspace_id)?;
        if r.amount_minor < 0
            || r.budget_item_ids.is_empty()
            || jt_strategy::validate_currency(&r.currency).is_err()
        {
            return Err(AppError::validation(
                "known cost, currency and budget items required",
                json!({}),
            ));
        }
        r.budget_item_ids.sort();
        r.budget_item_ids.dedup();
        let frame = StrategyRepo::lock_execution_frame(self)
            .await?
            .ok_or_else(AppError::strategy_required)?;
        self.tx.lock_studio().await;
        let payload = enc(&r)?;
        if let Some(saved) = self.replay("spend.reserve", &r.evidence_key, &payload)? {
            return Ok(saved);
        }
        if frame.id != r.executed_version_id {
            return Err(AppError::conflict("strategy changed"));
        }
        if self.lock_control().await?.is_braked(r.lane) {
            return Err(AppError::conflict("lane is braked"));
        }
        let cap = CapabilityRepo::find(self, r.capability_id)
            .await?
            .ok_or_else(|| AppError::not_found("capability"))?;
        if cap
            .budget_item_ids
            .iter()
            .any(|id| !r.budget_item_ids.contains(id))
        {
            return Err(AppError::conflict(
                "reservation must include every linked budget cap",
            ));
        }
        let lane = frame
            .sections
            .budget_frame
            .lanes
            .iter()
            .find(|l| l.lane == r.lane && l.currency == r.currency)
            .ok_or_else(|| AppError::conflict("strategy lane has no matching currency cap"))?;
        let period = match lane.period {
            jt_strategy::Period::Weekly => jt_capability::Period::Weekly,
            jt_strategy::Period::Monthly => jt_capability::Period::Monthly,
        };
        let (from, until) = jt_capability::period_window(period, r.at);
        cap_check(
            self.reserved(from, until, None, Some(r.lane), &r.currency),
            r.amount_minor,
            lane.cap_minor,
        )?;
        for id in &r.budget_item_ids {
            let item = BudgetRepo::lock_item(self, *id)
                .await?
                .ok_or_else(|| AppError::not_found("budget item"))?;
            if item.retired_at.is_some()
                || item.unit != jt_capability::Unit::Currency(r.currency.clone())
            {
                return Err(AppError::conflict(
                    "budget item is retired or currency differs",
                ));
            }
            let (from, until) = jt_capability::period_window(item.period, r.at);
            let spent = BudgetRepo::spent_between(self, *id, from, until).await?;
            cap_check(
                i128::from(spent) + self.reserved(from, until, Some(*id), None, &r.currency),
                r.amount_minor,
                item.cap,
            )?;
        }
        let saved = SpendReservation {
            id: ReservationId::new_v7(),
            request: r.clone(),
        };
        self.studio_write(|s, _| {
            s.reservations.push((saved.clone(), None));
            Ok(())
        })?;
        self.receipt("spend.reserve", &r.evidence_key, &payload, &saved)?;
        Ok(saved)
    }
    async fn settle(&mut self, id: ReservationId, outcome: SpendOutcome) -> Result<(), AppError> {
        self.tx.lock_studio().await;
        if let SpendOutcome::Settled {
            actual_minor,
            evidence_key,
        } = &outcome
            && (*actual_minor < 0 || evidence_key.trim().is_empty())
        {
            return Err(AppError::validation("invalid settlement", json!({})));
        }
        let ws = self.ws;
        self.studio_write(|s, _| {
            let (_, old) = s
                .reservations
                .iter_mut()
                .find(|(r, _)| r.request.workspace_id == ws && r.id == id)
                .ok_or_else(|| AppError::not_found("reservation"))?;
            if let Some(previous) = old {
                if *previous == outcome {
                    return Ok(());
                }
                if *previous != SpendOutcome::Unknown {
                    return Err(AppError::conflict("reservation already settled"));
                }
            }
            *old = Some(outcome);
            Ok(())
        })
    }
}
impl MemTenant {
    fn reserved(
        &self,
        from: OffsetDateTime,
        until: OffsetDateTime,
        item: Option<jt_capability::BudgetItemId>,
        lane: Option<LaneKind>,
        currency: &str,
    ) -> i128 {
        self.state()
            .studio
            .reservations
            .iter()
            .filter(|(r, _)| {
                r.request.workspace_id == self.ws
                    && r.request.at >= from
                    && r.request.at < until
                    && r.request.currency == currency
                    && item.is_none_or(|id| r.request.budget_item_ids.contains(&id))
                    && lane.is_none_or(|l| r.request.lane == l)
            })
            .map(|(r, o)| {
                i128::from(match o {
                    Some(SpendOutcome::Refused) => 0,
                    Some(SpendOutcome::Settled { actual_minor, .. }) => *actual_minor,
                    _ => r.request.amount_minor,
                })
            })
            .sum()
    }
}
fn cap_check(used: i128, amount: i64, cap: i64) -> Result<(), AppError> {
    if used + i128::from(amount) > i128::from(cap) {
        Err(AppError::budget_cap(
            json!({"cap_minor":cap,"requested_minor":amount}),
        ))
    } else {
        Ok(())
    }
}
