use jt_strategy::{HypothesisId, LaneKind, StrategyVersionId};
use jt_studio::*;
use jt_tenancy::WorkspaceId;
use time::OffsetDateTime;
fn fixture() -> (Arm, Measurement) {
    let ws = WorkspaceId::new_v7();
    let h = HypothesisId::new_v7();
    let a = Arm::new(
        ArmId::new_v7(),
        ws,
        ArmKey {
            hypothesis_id: h,
            content_type: "text".into(),
            channel: "x".into(),
            lane: LaneKind::Organic,
        },
    )
    .unwrap();
    let m = Measurement {
        id: MeasurementId::new_v7(),
        chain: Chain {
            workspace_id: ws,
            born_version_id: StrategyVersionId::new_v7(),
            hypothesis_id: h,
            arm_id: a.id,
        },
        evidence_key: "post:24:r1".into(),
        publication_id: Some(PublicationId::new_v7()),
        binding_id: None,
        window: MeasurementWindow::Hours24,
        evidence_revision: 0,
        scheduled_at: None,
        account_timezone: None,
        minor_unit_exponent: None,
        measured_at: OffsetDateTime::UNIX_EPOCH,
        source: "x".into(),
        raw_metrics: [
            ("engagements".into(), Some(20)),
            ("impressions".into(), Some(100)),
        ]
        .into(),
        metric_scope: "post".into(),
        date: None,
        currency: None,
        status: MeasurementStatus::Complete,
        rule_version: "studio-learning-v1".into(),
    };
    (a, m)
}
#[test]
fn learning_and_weekly_weights_match_ruling_vectors() {
    let (a, mut m) = fixture();
    let p = LearningPolicy::default();
    let r = reward(&m, &p).unwrap().unwrap();
    assert_eq!(r.value, 0.2);
    let u = learn(&a, &r, &p).unwrap();
    assert!((u.alpha_delta - 0.2).abs() < 1e-12);
    assert!((u.beta_delta - 0.8).abs() < 1e-12);
    let mut learned = a.clone();
    learned.alpha += u.alpha_delta;
    learned.beta += u.beta_delta;
    assert!((reweight(&[learned], &p).unwrap()[0].weight - 0.4).abs() < 1e-12);
    m.raw_metrics.insert("engagements".into(), Some(150));
    assert_eq!(reward(&m, &p).unwrap().unwrap().value, 1.0);
}
#[test]
fn missing_metrics_do_not_reward_zero() {
    let (_, mut m) = fixture();
    let p = LearningPolicy::default();
    for n in [None, Some(0), Some(-1)] {
        m.raw_metrics.insert("impressions".into(), n);
        assert!(reward(&m, &p).unwrap().is_none());
    }
}
#[test]
fn account_counters_do_not_become_post_reward() {
    let (_, mut m) = fixture();
    m.metric_scope = "account".into();
    assert!(reward(&m, &LearningPolicy::default()).is_err());
}
#[test]
fn replacement_and_independent_reward_match_vectors() {
    let (mut a, mut m) = fixture();
    let p = LearningPolicy::default();
    let first = reward(&m, &p).unwrap().unwrap();
    a.alpha += first.value;
    a.beta += 1.0 - first.value;
    m.window = MeasurementWindow::Days7;
    m.id = MeasurementId::new_v7();
    m.raw_metrics.insert("engagements".into(), Some(80));
    let next = reward(&m, &p).unwrap().unwrap();
    a.alpha += next.value - first.value;
    a.beta += first.value - next.value;
    assert!((a.alpha - 1.8).abs() < 1e-12);
    assert!((a.beta - 1.2).abs() < 1e-12);
    assert!((reweight(&[a.clone()], &p).unwrap()[0].weight - 0.6).abs() < 1e-12);
    m.publication_id = Some(PublicationId::new_v7());
    m.raw_metrics.insert("engagements".into(), Some(100));
    let u = learn(&a, &reward(&m, &p).unwrap().unwrap(), &p).unwrap();
    a.alpha += u.alpha_delta;
    a.beta += u.beta_delta;
    assert!((a.alpha - 2.8).abs() < 1e-12);
    assert!((reweight(&[a], &p).unwrap()[0].weight - 0.7).abs() < 1e-12);
}
#[test]
fn observation_selection_uses_window_then_revision_not_arrival() {
    let (_, mut m) = fixture();
    let early = m.clone();
    m.window = MeasurementWindow::Days7;
    m.raw_metrics.insert("engagements".into(), Some(80));
    assert_eq!(
        observations(&[m.clone(), early.clone()]).unwrap()[0].value,
        0.8
    );
    let mut correction = m.clone();
    correction.evidence_revision = 1;
    correction
        .raw_metrics
        .insert("engagements".into(), Some(30));
    assert_eq!(observations(&[correction, m, early]).unwrap()[0].value, 0.3);
}
