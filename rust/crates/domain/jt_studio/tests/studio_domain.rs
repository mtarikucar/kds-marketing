use jt_capability::{Capability, CapabilityId, NewCapability};
use jt_ledger::Actor;
use jt_strategy::{
    ChannelChoice, ContentTypeShare, Hypothesis, HypothesisCadence, HypothesisId, HypothesisState,
    LaneKind, Sections, StrategyVersion, StrategyVersionId, VersionStatus,
};
use jt_studio::*;
use jt_tenancy::{UserId, WorkspaceId};
use serde::{Serialize, de::DeserializeOwned};
use std::{collections::BTreeMap, fmt::Debug};
use time::{OffsetDateTime, macros::datetime};
use uuid::Uuid;

const NOW: OffsetDateTime = datetime!(2026-10-26 0:00 UTC);

struct Fixture {
    birth: StrategyVersion,
    current: StrategyVersion,
    hypotheses: Vec<Hypothesis>,
    arm: Arm,
    target: Capability,
    chain: Chain,
}
impl Fixture {
    fn new() -> Self {
        let ws = WorkspaceId::new_v7();
        let version = StrategyVersion {
            id: StrategyVersionId::new_v7(),
            workspace_id: ws,
            number: 1,
            status: VersionStatus::Approved,
            sections: Sections {
                channels: vec![ChannelChoice {
                    channel: "instagram".into(),
                    rationale: "audience".into(),
                    group_id: None,
                }],
                ..Default::default()
            },
            created_at: NOW,
            created_by: actor(),
            submitted_at: Some(NOW),
            approved_at: Some(NOW),
            approved_by: Some(UserId::new_v7()),
            archived_at: None,
        };
        let hypothesis = Hypothesis {
            id: HypothesisId::new_v7(),
            title: "Angle".into(),
            segment_key: "buyers".into(),
            angle: "Proof".into(),
            channel: "any".into(),
            metric: "engagement".into(),
            prior_confidence: 0.9,
            derived_confidence: None,
            state: HypothesisState::Added,
            cadence: BTreeMap::from([(
                LaneKind::Organic,
                HypothesisCadence {
                    slots_per_week: 7,
                    exploration_bps: 0,
                    content_types: vec![ContentTypeShare {
                        key: "image".into(),
                        min_bps: 0,
                        max_bps: 10000,
                    }],
                },
            )]),
        };
        let arm = Arm::new(
            ArmId::new_v7(),
            ws,
            ArmKey {
                hypothesis_id: hypothesis.id,
                content_type: "image".into(),
                channel: "instagram".into(),
                lane: LaneKind::Organic,
            },
        )
        .unwrap();
        let target = Capability::new(
            CapabilityId::new_v7(),
            ws,
            NewCapability {
                kind_key: "instagram".into(),
                name: "Brand account".into(),
                ..Default::default()
            },
            NOW,
        )
        .unwrap();
        let chain = Chain {
            workspace_id: ws,
            born_version_id: version.id,
            hypothesis_id: hypothesis.id,
            arm_id: arm.id,
        };
        Self {
            birth: version.clone(),
            current: version,
            hypotheses: vec![hypothesis],
            arm,
            target,
            chain,
        }
    }
    fn context(&self) -> ChainContext<'_> {
        ChainContext {
            workspace_id: self.chain.workspace_id,
            birth_version: &self.birth,
            birth_hypotheses: &self.hypotheses,
            current_version: &self.current,
            hypotheses: &self.hypotheses,
            arm: &self.arm,
            target: &self.target,
            target_group_ids: &[],
            supported_kinds: &["instagram", "facebook_page", "x"],
            lane: LaneKind::Organic,
        }
    }
    fn slot(&self) -> Slot {
        Slot {
            id: SlotId::new_v7(),
            chain: self.chain.clone(),
            capability_id: self.target.id,
            scheduled_at: NOW,
            state: SlotState::Planned,
            revision: 0,
        }
    }
    fn piece(&self, revision: u64) -> Piece {
        Piece {
            id: PieceId::new_v7(),
            chain: self.chain.clone(),
            revision,
            text: "Agent supplied".into(),
            media: vec![],
            adaptations: BTreeMap::new(),
        }
    }
    fn publication(&self, slot: &Slot, piece: &Piece) -> Publication {
        Publication {
            account_id: Some("test_account".into()),
            id: PublicationId::new_v7(),
            chain: self.chain.clone(),
            slot_id: slot.id,
            piece_id: piece.id,
            capability_id: slot.capability_id,
            executed_version_id: self.current.id,
            external_id: "post-1".into(),
            url: Some("https://example.com/post/1".parse().unwrap()),
            published_at: NOW,
            actor: actor(),
            attempt_id: PublishAttemptId::new_v7(),
        }
    }
    fn measurement(&self, publication: PublicationId) -> Measurement {
        Measurement {
            id: MeasurementId::new_v7(),
            chain: self.chain.clone(),
            evidence_key: "post-1:24h:1".into(),
            publication_id: Some(publication),
            binding_id: None,
            window: MeasurementWindow::Hours24,
            evidence_revision: 0,
            scheduled_at: None,
            account_timezone: None,
            minor_unit_exponent: None,
            measured_at: NOW,
            source: "meta".into(),
            raw_metrics: BTreeMap::from([("impressions".into(), None)]),
            metric_scope: "post".into(),
            date: None,
            currency: None,
            status: MeasurementStatus::Missing,
            rule_version: "studio-learning-v1".into(),
        }
    }
}
fn actor() -> Actor {
    Actor::Human {
        user_id: UserId::new_v7(),
    }
}
fn policy(revision: u64) -> StudioPolicy {
    StudioPolicy {
        expected_revision: revision,
        ..Default::default()
    }
}
fn round_trip<T: Serialize + DeserializeOwned + PartialEq + Debug>(value: &T) {
    let json = serde_json::to_string(value).unwrap();
    assert_eq!(&serde_json::from_str::<T>(&json).unwrap(), value);
}

#[test]
fn work_requires_complete_chain() {
    let f = Fixture::new();
    assert_eq!(validate_chain(&f.chain, &f.context()), Ok(()));
    for field in 0..4 {
        let mut chain = f.chain.clone();
        match field {
            0 => chain.workspace_id = Uuid::nil().into(),
            1 => chain.born_version_id = Uuid::nil().into(),
            2 => chain.hypothesis_id = Uuid::nil().into(),
            _ => chain.arm_id = Uuid::nil().into(),
        }
        assert!(validate_chain(&chain, &f.context()).is_err());
    }
    let mut chain = f.chain.clone();
    chain.born_version_id = StrategyVersionId::new_v7();
    assert!(validate_chain(&chain, &f.context()).is_err());
    chain = f.chain.clone();
    chain.arm_id = ArmId::new_v7();
    assert!(validate_chain(&chain, &f.context()).is_err());
    let mut ctx = f.context();
    ctx.lane = LaneKind::Paid;
    assert!(validate_chain(&f.chain, &ctx).is_err());
}

#[test]
fn foreign_hypothesis_rejected() {
    let mut f = Fixture::new();
    f.chain.hypothesis_id = HypothesisId::new_v7();
    assert!(validate_chain(&f.chain, &f.context()).is_err());
    f.chain.hypothesis_id = f.hypotheses[0].id;
    f.current.workspace_id = WorkspaceId::new_v7();
    assert!(validate_chain(&f.chain, &f.context()).is_err());
    f.current.workspace_id = f.chain.workspace_id;
    f.hypotheses[0].state = HypothesisState::Retired;
    assert!(validate_chain(&f.chain, &f.context()).is_err());
}

#[test]
fn channel_any_resolves_only_selected_supported_kind() {
    let mut f = Fixture::new();
    assert!(validate_chain(&f.chain, &f.context()).is_ok());
    f.current.sections.channels[0].channel = "x".into();
    assert!(validate_chain(&f.chain, &f.context()).is_err());
    f.current.sections.channels[0].channel = "any".into();
    assert!(validate_chain(&f.chain, &f.context()).is_ok());
    let mut ctx = f.context();
    ctx.supported_kinds = &["x"];
    assert!(validate_chain(&f.chain, &ctx).is_err());
    f.hypotheses[0].channel = "x".into();
    assert!(validate_chain(&f.chain, &f.context()).is_err());
    f.hypotheses[0].channel = "any".into();
    f.arm.key.channel = "any".into();
    assert!(validate_chain(&f.chain, &f.context()).is_err());
}

#[test]
fn group_restriction_checked_on_target() {
    let mut f = Fixture::new();
    let group = Uuid::now_v7();
    f.current.sections.channels[0].group_id = Some(group);
    assert!(validate_chain(&f.chain, &f.context()).is_err());
    let groups = [group];
    let mut ctx = f.context();
    ctx.target_group_ids = &groups;
    assert!(validate_chain(&f.chain, &ctx).is_ok());
    f.target.workspace_id = WorkspaceId::new_v7();
    let mut ctx = f.context();
    ctx.target_group_ids = &groups;
    assert!(validate_chain(&f.chain, &ctx).is_err());
}

#[test]
fn kept_hypothesis_does_not_reset_arm() {
    let mut f = Fixture::new();
    assert_eq!((f.arm.alpha, f.arm.beta, f.arm.weight), (1.0, 1.0, 0.5));
    f.arm.alpha = 1.2;
    f.arm.beta = 1.8;
    f.arm.weight = 0.4;
    let learned = f.arm.clone();
    let original = f.chain.clone();
    f.birth.status = VersionStatus::Archived;
    f.current.id = StrategyVersionId::new_v7();
    f.current.number = 2;
    f.hypotheses[0].state = HypothesisState::Kept;
    validate_chain(&f.chain, &f.context()).unwrap();
    assert_eq!(f.arm, learned);
    assert_eq!(f.chain, original);
    f.current.status = VersionStatus::Archived;
    assert!(validate_chain(&f.chain, &f.context()).is_err());
}

#[test]
fn slot_transition_table_matches_ruling() {
    let f = Fixture::new();
    let states = [
        SlotState::Planned,
        SlotState::Ready,
        SlotState::Published,
        SlotState::Measured,
        SlotState::Retired,
    ];
    for (index, state) in states.into_iter().enumerate() {
        let mut slot = f.slot();
        slot.state = state;
        slot.revision = 1;
        let piece = f.piece(2);
        let publication = f.publication(&slot, &piece);
        let mut measurement = f.measurement(publication.id);
        measurement.status = MeasurementStatus::Complete;
        let events = [
            SlotEvent::PieceSubmitted { piece },
            SlotEvent::Published {
                publication: publication.clone(),
            },
            SlotEvent::Measured {
                publication: Box::new(publication),
                measurement,
            },
            SlotEvent::Retire {
                reason: RetirementReason::Cancelled,
            },
            SlotEvent::Retire {
                reason: RetirementReason::WeekEnded,
            },
            SlotEvent::Retire {
                reason: RetirementReason::MeasurementsComplete,
            },
        ];
        // Editing Ready increments its revision. Late outcomes preserve Retired unchanged.
        let expected = [
            [
                Some(SlotState::Ready),
                None,
                None,
                Some(SlotState::Retired),
                Some(SlotState::Retired),
                None,
            ],
            [
                Some(SlotState::Ready),
                Some(SlotState::Published),
                None,
                Some(SlotState::Retired),
                None,
                None,
            ],
            [None, None, Some(SlotState::Measured), None, None, None],
            [
                None,
                None,
                Some(SlotState::Measured),
                None,
                None,
                Some(SlotState::Retired),
            ],
            [
                None,
                Some(SlotState::Retired),
                Some(SlotState::Retired),
                Some(SlotState::Retired),
                Some(SlotState::Retired),
                Some(SlotState::Retired),
            ],
        ];
        for (i, event) in events.iter().enumerate() {
            let result = transition_slot(&slot, event, &policy(1));
            match expected[index][i] {
                Some(want) => {
                    let next = result.unwrap_or_else(|e| panic!("{state:?} {event:?}: {e}"));
                    assert_eq!(next.state, want);
                    assert_eq!(next.chain, slot.chain);
                    assert_eq!(
                        next.revision,
                        if state == SlotState::Retired { 1 } else { 2 }
                    );
                }
                None => assert!(result.is_err(), "{state:?} {event:?}"),
            }
        }
    }
}

#[test]
fn approval_bound_to_piece_or_move_revision() {
    let f = Fixture::new();
    let mut slot = f.slot();
    slot.state = SlotState::Ready;
    slot.revision = 3;
    let publication = f.publication(&slot, &f.piece(3));
    let event = SlotEvent::Published { publication };
    assert!(transition_slot(&slot, &event, &policy(3)).is_ok());
    let receipt = ApprovalReceipt {
        revision: 3,
        by: UserId::new_v7(),
        at: NOW,
    };
    for (lane, capability) in [(true, false), (false, true), (true, true)] {
        let mut rules = StudioPolicy {
            requires_human_approval: lane,
            capability_requires_human_approval: capability,
            ..policy(3)
        };
        assert!(transition_slot(&slot, &event, &rules).is_err());
        rules.approval = Some(receipt.clone());
        assert!(transition_slot(&slot, &event, &rules).is_ok());
        let next = transition_slot(
            &slot,
            &SlotEvent::PieceSubmitted { piece: f.piece(4) },
            &rules,
        )
        .unwrap();
        rules.expected_revision = 4;
        assert!(transition_slot(&next, &event, &rules).is_err());
        assert!(rules.check_approval(4).is_err()); // same check used by budget moves
    }
    assert!(transition_slot(&slot, &event, &policy(2)).is_err());
}

#[test]
fn ids_and_revisions_checked_against_chain() {
    let f = Fixture::new();
    let slot = f.slot();
    let mut piece = f.piece(1);
    piece.chain.arm_id = ArmId::new_v7();
    assert!(transition_slot(&slot, &SlotEvent::PieceSubmitted { piece }, &policy(0)).is_err());
    assert!(
        transition_slot(
            &slot,
            &SlotEvent::PieceSubmitted { piece: f.piece(2) },
            &policy(0)
        )
        .is_err()
    );
    let mut ready = slot.clone();
    ready.state = SlotState::Ready;
    ready.revision = 1;
    let mut publication = f.publication(&ready, &f.piece(1));
    publication.slot_id = SlotId::new_v7();
    assert!(transition_slot(&ready, &SlotEvent::Published { publication }, &policy(1)).is_err());
    ready.revision = u64::MAX;
    assert!(
        transition_slot(
            &ready,
            &SlotEvent::Retire {
                reason: RetirementReason::Cancelled
            },
            &policy(u64::MAX)
        )
        .is_err()
    );
}

#[test]
fn learning_parameters_reject_nan_nonfinite_and_invalid_ranges() {
    let f = Fixture::new();
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.0, -1.0] {
        let mut arm = f.arm.clone();
        arm.alpha = bad;
        assert!(arm.validate().is_err());
        arm = f.arm.clone();
        arm.beta = bad;
        assert!(arm.validate().is_err());
    }
    for bad in [f64::NAN, f64::INFINITY, -0.1, 1.1] {
        let mut arm = f.arm.clone();
        arm.weight = bad;
        assert!(arm.validate().is_err());
    }
    let mut json = serde_json::to_value(&f.arm).unwrap();
    json["alpha"] = serde_json::json!(-1);
    assert!(serde_json::from_value::<Arm>(json).is_err());
}

#[test]
fn measurement_requires_one_target_and_keeps_missing_counters() {
    let f = Fixture::new();
    let mut m = f.measurement(PublicationId::new_v7());
    m.validate().unwrap();
    round_trip(&m);
    assert_eq!(m.raw_metrics["impressions"], None);
    m.binding_id = Some(AdSetBindingId::new_v7());
    assert!(m.validate().is_err());
    m.publication_id = None;
    m.metric_scope = "adset".into();
    m.date = Some(NOW.date());
    m.currency = Some("TRY".into());
    m.validate().unwrap();
    round_trip(&m);
    m.binding_id = None;
    assert!(m.validate().is_err());
}

#[test]
fn publication_claim_freezes_piece_and_late_evidence_does_not_reopen_slot() {
    let f = Fixture::new();
    let mut slot = f.slot();
    slot.state = SlotState::Ready;
    slot.revision = 1;
    let mut piece = f.piece(1);
    let attempt = PublishAttempt::claim(
        PublishAttemptId::new_v7(),
        &slot,
        &piece,
        f.current.id,
        7,
        actor(),
        NOW,
    )
    .unwrap();
    piece.text = "Edited later".into();
    piece.revision = 2;
    assert_eq!(attempt.piece().text, "Agent supplied");
    assert_eq!(attempt.piece().revision, 1);
    assert_eq!(attempt.slot_revision(), 1);
    assert_eq!(attempt.control_revision(), 7);
    round_trip(&attempt);
    let outcome = PublishOutcome::Succeeded(PublishReceipt {
        external_id: "post-1".into(),
        url: None,
    });
    let finished = attempt.finish(&outcome).unwrap();
    assert_eq!(finished.state(), PublishState::Succeeded);
    assert!(
        finished
            .finish(&PublishOutcome::Unknown(RedactedPublishError::Transient))
            .is_err()
    );
    assert!(finished.finish(&outcome).is_ok());
    let publication = finished.publication(PublicationId::new_v7(), NOW).unwrap();
    assert_eq!(publication.piece_id, attempt.piece().id);
    assert_eq!(publication.chain, f.chain);
    slot.state = SlotState::Retired;
    assert_eq!(
        transition_slot(&slot, &SlotEvent::Published { publication }, &policy(1)).unwrap(),
        slot
    );
    let unknown = attempt
        .finish(&PublishOutcome::Unknown(RedactedPublishError::Transient))
        .unwrap();
    assert!(unknown.publication(PublicationId::new_v7(), NOW).is_err());
}

#[test]
fn serde_round_trips_and_bytes_are_not_persistable() {
    let f = Fixture::new();
    round_trip(&f.arm);
    round_trip(&f.chain);
    round_trip(&f.slot());
    let mut piece = f.piece(1);
    piece.media = vec![
        MediaAsset::HostedUrl {
            url: "https://example.com/image.png".parse().unwrap(),
            mime: "image/png".into(),
            size_bytes: 42,
        },
        MediaAsset::File {
            id: FileId::new_v7(),
        },
    ];
    piece.adaptations.insert(
        f.target.id.to_string(),
        ChannelContent {
            text: "Per account".into(),
            media: vec![],
            link: None,
        },
    );
    round_trip(&piece);
    piece.validate_persisted().unwrap();
    round_trip(&f.publication(&f.slot(), &piece));
    let upload = MediaUpload {
        bytes: b"secret bytes".to_vec(),
        mime: "image/png".into(),
        filename: "image.png".into(),
    };
    assert!(!format!("{upload:?}").contains("secret bytes"));
    piece.media.push(MediaAsset::Bytes { upload });
    assert!(piece.validate_persisted().is_err());
    assert!(serde_json::to_string(&piece).is_err());
}

#[test]
fn paid_move_checks_binding_revision_currency_and_execution_fence() {
    let f = Fixture::new();
    let binding = AdSetBinding {
        verified_at: None,
        verification_evidence: None,
        id: AdSetBindingId::new_v7(),
        chain: f.chain.clone(),
        capability_id: f.target.id,
        account_id: "act_1".into(),
        adset_id: "set_1".into(),
        campaign_id: Some("campaign_1".into()),
    };
    let mut movement = BudgetMove {
        binding_verified_at: None,
        binding_verification_evidence: None,
        id: BudgetMoveId::new_v7(),
        chain: f.chain.clone(),
        binding_id: binding.id,
        revision: 1,
        daily_budget_minor: 1000,
        currency: "TRY".into(),
        state: BudgetMoveState::Queued,
        approval: None,
        reservation_id: None,
        executed_version_id: None,
    };
    movement.validate_for_binding(&binding).unwrap();
    round_trip(&binding);
    round_trip(&movement);
    let mut rules = StudioPolicy {
        requires_human_approval: true,
        ..policy(1)
    };
    assert!(movement.check_approval(&rules).is_err());
    movement.approval = Some(ApprovalReceipt {
        revision: 1,
        by: UserId::new_v7(),
        at: NOW,
    });
    movement.check_approval(&rules).unwrap();
    movement.revision = 2;
    movement.daily_budget_minor = 2000;
    rules.expected_revision = 2;
    assert!(movement.check_approval(&rules).is_err());
    movement.state = BudgetMoveState::Sending;
    assert!(movement.validate_for_binding(&binding).is_err());
    movement.reservation_id = Some(ReservationId::new_v7());
    movement.executed_version_id = Some(f.current.id);
    movement.validate_for_binding(&binding).unwrap();
    movement.currency = "try".into();
    assert!(movement.validate_for_binding(&binding).is_err());
    movement.currency = "TRY".into();
    movement.daily_budget_minor = -1;
    assert!(movement.validate_for_binding(&binding).is_err());
    movement.daily_budget_minor = 1000;
    movement.binding_id = AdSetBindingId::new_v7();
    assert!(movement.validate_for_binding(&binding).is_err());
}

#[test]
fn unknown_pause_is_not_confirmed_stopped_and_brakes_are_lane_scoped() {
    let f = Fixture::new();
    let mut control = StudioControl {
        workspace_id: f.chain.workspace_id,
        brake_engaged: false,
        revision: 1,
        lanes: BTreeMap::from([(
            LaneKind::Paid,
            LaneControl {
                brake_engaged: true,
                requires_human_approval: false,
            },
        )]),
    };
    control.validate().unwrap();
    round_trip(&control);
    assert!(control.is_braked(LaneKind::Paid));
    assert!(!control.is_braked(LaneKind::Organic));
    control.brake_engaged = true;
    assert!(control.is_braked(LaneKind::Organic));
    let binding = BindingControl {
        resume_operation_id: None,
        binding_id: AdSetBindingId::new_v7(),
        chain: f.chain,
        desired: AdStatus::Paused,
        observed: Some(AdStatus::Active),
        paused_by_brake: true,
        outcome: None,
        at: NOW,
    };
    assert!(!binding.confirmed_paused());
    let paused = binding.record(
        BindingStatusOutcome::Applied {
            observed: AdStatus::Paused,
        },
        NOW,
    );
    assert!(paused.confirmed_paused());
    round_trip(&paused);
    let unknown = paused.record(BindingStatusOutcome::Unknown, NOW);
    assert!(!unknown.confirmed_paused());
    assert_eq!(unknown.observed, None);
    round_trip(&unknown);
    assert!(
        !paused
            .record(BindingStatusOutcome::Failed, NOW)
            .confirmed_paused()
    );
}

#[test]
fn learning_deltas_reject_nonfinite_values_but_allow_evidence_replacement() {
    let f = Fixture::new();
    let update = LearningUpdate {
        chain: f.chain,
        evidence_key: "post-1:72h:1".into(),
        alpha_delta: -0.2,
        beta_delta: -0.8,
        weight_delta: -0.1,
        derived_confidence: 0.4,
    };
    update.validate().unwrap();
    round_trip(&update);
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let mut changed = update.clone();
        changed.alpha_delta = bad;
        assert!(changed.validate().is_err());
        changed = update.clone();
        changed.beta_delta = bad;
        assert!(changed.validate().is_err());
        changed = update.clone();
        changed.weight_delta = bad;
        assert!(changed.validate().is_err());
    }
    for bad in [f32::NAN, f32::INFINITY, -0.1, 1.1] {
        let mut changed = update.clone();
        changed.derived_confidence = bad;
        assert!(changed.validate().is_err());
    }
    let mut changed = update;
    changed.evidence_key.clear();
    assert!(changed.validate().is_err());
}

#[test]
fn trends_reservations_and_measurement_windows_round_trip() {
    let f = Fixture::new();
    let mut trend = TrendSignal {
        id: TrendSignalId::new_v7(),
        workspace_id: f.chain.workspace_id,
        born_version_id: f.chain.born_version_id,
        hypothesis_id: f.chain.hypothesis_id,
        channel: "instagram".into(),
        summary: "Agent observation".into(),
        source_url: None,
        observed_at: NOW,
        actor: actor(),
    };
    trend.validate().unwrap();
    round_trip(&trend);
    trend.summary.clear();
    assert!(trend.validate().is_err());
    let reservation = SpendReservation {
        lane_window: None,
        item_windows: Default::default(),
        item_amounts: Default::default(),
        id: ReservationId::new_v7(),
        request: ReserveSpend {
            binding_id: None,
            chain: None,
            replaces: None,
            daily_budget_minor: None,
            workspace_id: f.chain.workspace_id,
            capability_id: f.target.id,
            budget_item_ids: vec![jt_capability::BudgetItemId::new_v7()],
            lane: LaneKind::Paid,
            executed_version_id: f.current.id,
            amount_minor: 7000,
            currency: "TRY".into(),
            evidence_key: "move-1".into(),
            at: NOW,
        },
    };
    round_trip(&reservation);
    round_trip(&SpendOutcome::Settled {
        actual_minor: 120,
        evidence_key: "day-1".into(),
    });
    for (window, hours) in [
        (MeasurementWindow::Hours24, 24),
        (MeasurementWindow::Hours72, 72),
        (MeasurementWindow::Days7, 168),
    ] {
        assert_eq!(window.delay().whole_hours(), hours);
        round_trip(&window);
    }
}

#[test]
fn paid_chain_requires_enabled_paid_lane_and_supported_account() {
    let mut f = Fixture::new();
    f.arm.key.lane = LaneKind::Paid;
    let cadence = f.hypotheses[0].cadence[&LaneKind::Organic].clone();
    f.hypotheses[0].cadence.insert(LaneKind::Paid, cadence);
    let mut ctx = f.context();
    ctx.lane = LaneKind::Paid;
    assert!(validate_chain(&f.chain, &ctx).is_err());
    f.current.sections.paid_enabled = true;
    let mut ctx = f.context();
    ctx.lane = LaneKind::Paid;
    ctx.supported_kinds = &["meta_ads"];
    assert!(validate_chain(&f.chain, &ctx).is_err());
    f.arm.key.channel = "meta_ads".into();
    f.target.kind_key = "meta_ads".into();
    f.current.sections.channels[0].channel = "meta_ads".into();
    let mut ctx = f.context();
    ctx.lane = LaneKind::Paid;
    ctx.supported_kinds = &["meta_ads"];
    validate_chain(&f.chain, &ctx).unwrap();
}

#[test]
fn outcomes_never_requeue_and_snapshot_refuses_stale_piece() {
    let f = Fixture::new();
    let mut slot = f.slot();
    slot.state = SlotState::Ready;
    slot.revision = 2;
    assert!(
        PublishAttempt::claim(
            PublishAttemptId::new_v7(),
            &slot,
            &f.piece(1),
            f.current.id,
            0,
            actor(),
            NOW
        )
        .is_err()
    );
    let attempt = PublishAttempt::claim(
        PublishAttemptId::new_v7(),
        &slot,
        &f.piece(2),
        f.current.id,
        0,
        actor(),
        NOW,
    )
    .unwrap();
    for code in [
        RedactedPublishError::Auth,
        RedactedPublishError::Permission,
        RedactedPublishError::Permanent,
        RedactedPublishError::Throttle,
        RedactedPublishError::Transient,
    ] {
        let result = attempt.finish(&PublishOutcome::Failed(code)).unwrap();
        assert_eq!(result.state(), PublishState::Failed);
        round_trip(&result);
        assert!(
            result
                .finish(&PublishOutcome::Succeeded(PublishReceipt {
                    external_id: "guess".into(),
                    url: None
                }))
                .is_err()
        );
    }
    let refused = attempt
        .finish(&PublishOutcome::Refused(RedactedPublishError::Policy))
        .unwrap();
    assert_eq!(refused.state(), PublishState::Refused);
    round_trip(&refused);
    let bad = PublishOutcome::Succeeded(PublishReceipt {
        external_id: "".into(),
        url: None,
    });
    assert!(attempt.finish(&bad).is_err());
}

#[test]
fn historical_measurement_checks_publication_identity_and_completeness() {
    let f = Fixture::new();
    let mut slot = f.slot();
    slot.state = SlotState::Published;
    slot.revision = 2;
    let publication = f.publication(&slot, &f.piece(1));
    let mut measurement = f.measurement(publication.id);
    let transition = |measurement| {
        transition_slot(
            &slot,
            &SlotEvent::Measured {
                publication: Box::new(publication.clone()),
                measurement,
            },
            &policy(2),
        )
    };
    assert!(transition(measurement.clone()).is_err());
    measurement.status = MeasurementStatus::Complete;
    assert_eq!(
        transition(measurement.clone()).unwrap().state,
        SlotState::Measured
    );
    measurement.publication_id = Some(PublicationId::new_v7());
    assert!(transition(measurement.clone()).is_err());
    measurement.publication_id = Some(publication.id);
    measurement.chain.arm_id = ArmId::new_v7();
    assert!(transition(measurement).is_err());
}

#[test]
fn chain_rejects_unknown_capability_kind_even_if_context_lists_it() {
    let mut f = Fixture::new();
    f.target.kind_key = "invented_provider".into();
    f.arm.key.channel = "invented_provider".into();
    f.current.sections.channels[0].channel = "any".into();
    let mut ctx = f.context();
    ctx.supported_kinds = &["invented_provider"];
    assert!(validate_chain(&f.chain, &ctx).is_err());
}

#[test]
fn publication_validation_rejects_nil_slot_and_target_ids() {
    let f = Fixture::new();
    let mut slot = f.slot();
    slot.id = Uuid::nil().into();
    slot.capability_id = Uuid::nil().into();
    let publication = f.publication(&slot, &f.piece(1));
    assert!(publication.validate_for_slot(&slot).is_err());
}
