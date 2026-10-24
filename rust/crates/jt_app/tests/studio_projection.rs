#[path = "support/studio.rs"]
mod support;
use jt_app::{ports::UnitOfWork, usecases::studio::views::*};
use jt_strategy::LaneKind;
use serde_json::json;
use time::Duration;

fn query() -> StudioQuery {
    StudioQuery {
        hypothesis_id: None,
        lane: None,
        from: jt_testkit::fakes::FIXED_NOW - Duration::days(1),
        until: jt_testkit::fakes::FIXED_NOW + Duration::days(7),
    }
}
fn filter() -> StudioLedgerQuery {
    let q = query();
    StudioLedgerQuery {
        hypothesis_id: None,
        lane: None,
        from: q.from,
        until: q.until,
        before: None,
        limit: 2,
    }
}
#[tokio::test]
async fn hypothesis_filter_updates_all_five_regions() {
    let w = support::world().await;
    let all = overview(&w.d, &w.ctx, query()).await.unwrap();
    assert!(!all.slots.is_empty());
    let absent = jt_strategy::HypothesisId::new_v7();
    let mut q = query();
    q.hypothesis_id = Some(absent);
    let out = overview(&w.d, &w.ctx, q).await.unwrap();
    assert!(out.hypotheses.is_empty());
    assert!(out.slots.is_empty());
    assert!(out.today.slots.is_empty());
    assert!(out.learned.arms.is_empty());
    let mut f = filter();
    f.hypothesis_id = Some(absent);
    assert!(ledger(&w.d, &w.ctx, f).await.unwrap().entries.is_empty());
}
#[tokio::test]
async fn organic_visible_and_paid_four_case_visibility() {
    for account in [false, true] {
        for strategy in [false, true] {
            let w = support::world().await;
            if account {
                w.paid().await;
            }
            let mut r = w.uow.tenant(w.f.ws).await.unwrap();
            let mut v = r.strategy().find(w.current).await.unwrap().unwrap();
            v.sections.paid_enabled = strategy;
            let hypotheses = r.hypotheses().list(v.id).await.unwrap();
            r.strategy()
                .set_status(
                    v.id,
                    jt_strategy::VersionStatus::Archived,
                    w.ctx.now,
                    v.approved_by,
                )
                .await
                .unwrap();
            v.id = jt_strategy::StrategyVersionId::new_v7();
            v.number += 1;
            r.strategy().insert(v.clone()).await.unwrap();
            for h in hypotheses {
                r.hypotheses().upsert(v.id, h).await.unwrap();
            }
            r.commit().await.unwrap();
            let out = overview(&w.d, &w.ctx, query()).await.unwrap();
            assert!(out.lane_support.organic.visible);
            assert_eq!(out.lane_support.paid.visible, account && strategy);
        }
    }
}
#[tokio::test]
async fn ledger_export_is_tenant_filtered_and_redacted() {
    let w = support::world().await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    for n in 0..7 {
        r.ledger().append(ledger_entry(&w.ctx, "studio.slot_cancel", "studio_slot", w.f.slot.id,
            json!({"evidence_key":format!("evidence-{n}"),"token":"never-export", "url":"https://example.test/x?signature=never-export", "bytes":"never-export"})).unwrap()).await.unwrap();
    }
    r.ledger()
        .append(
            ledger_entry(
                &w.ctx,
                "inbox.commission",
                "journey",
                "elsewhere",
                json!({}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    let out = ledger_export(&w.d, &w.ctx, StudioLedgerExportInput { filter: filter() })
        .await
        .unwrap();
    assert_eq!(out.content.lines().count(), 8);
    assert!(!out.content.contains("never-export"));
    assert!(!out.content.contains("commission"));
    assert!(out.content.contains("evidence-6"));
    let other = support::world().await;
    assert_eq!(
        ledger_export(
            &w.d,
            &other.ctx,
            StudioLedgerExportInput { filter: filter() }
        )
        .await
        .unwrap_err()
        .code,
        jt_app::error::ErrorCode::NotFound
    );
    let mut f = filter();
    f.hypothesis_id = Some(w.f.slot.chain.hypothesis_id);
    f.lane = Some(LaneKind::Organic);
    assert_eq!(
        ledger_export(&w.d, &w.ctx, StudioLedgerExportInput { filter: f })
            .await
            .unwrap()
            .content
            .lines()
            .count(),
        8
    );
}
#[tokio::test]
async fn ledger_export_neutralizes_formula_cells() {
    let w = support::world().await;
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    for text in [
        "=SUM(1,2)",
        "+cmd",
        "-cmd",
        "@SUM(1)",
        "\t=cmd",
        "\r=cmd",
        "  =cmd",
    ] {
        r.ledger()
            .append(ledger_entry(&w.ctx, "studio.test", "test", text, json!({})).unwrap())
            .await
            .unwrap();
    }
    r.commit().await.unwrap();
    let out = ledger_export(&w.d, &w.ctx, StudioLedgerExportInput { filter: filter() })
        .await
        .unwrap();
    assert!(out.content.contains("\"'=SUM(1,2)\""));
    assert!(out.content.contains("\"'@SUM(1)\""));
    assert!(out.content.contains("\"'  =cmd\""));
}
#[tokio::test]
async fn ledger_survives_archive_but_is_status_gated() {
    let w = support::world().await;
    w.archive().await;
    assert!(ledger(&w.d, &w.ctx, filter()).await.is_ok());
    assert!(overview(&w.d, &w.ctx, query()).await.is_err());
    let mut platform = w.uow.platform().await.unwrap();
    platform
        .workspace_set_status(w.f.ws, jt_tenancy::WorkspaceStatus::Suspended)
        .await
        .unwrap();
    platform.commit().await.unwrap();
    assert_eq!(
        ledger(&w.d, &w.ctx, filter()).await.unwrap_err().code,
        jt_app::error::ErrorCode::WorkspaceInactive
    );
    assert_eq!(
        ledger_export(&w.d, &w.ctx, StudioLedgerExportInput { filter: filter() })
            .await
            .unwrap_err()
            .code,
        jt_app::error::ErrorCode::WorkspaceInactive
    );
}

fn ledger_entry(
    ctx: &jt_app::ctx::Ctx,
    action: &str,
    kind: &str,
    id: impl std::fmt::Display,
    payload: serde_json::Value,
) -> Result<jt_ledger::LedgerEntry, jt_ledger::LedgerError> {
    let mut e = jt_ledger::LedgerEntry::new(
        ctx.workspace_id,
        ctx.actor.clone(),
        jt_ledger::Action::new(action)?,
        payload,
        ctx.now,
    );
    e.subject = Some(jt_ledger::Subject {
        kind: kind.into(),
        id: id.to_string(),
    });
    Ok(e)
}

#[tokio::test]
async fn approval_and_unknown_outcome_show_actionable_reason() {
    use jt_app::usecases::studio::{control, work};
    let w = support::world().await;
    w.policy(true, 0).await;
    let out = overview(&w.d, &w.ctx, query()).await.unwrap();
    assert_eq!(out.slots[0].state, jt_studio::SlotState::Ready);
    assert!(
        out.today
            .blockers
            .iter()
            .any(|b| b.reason == "human_approval_required")
    );
    control::approve(
        &w.d,
        &w.ctx,
        control::ApprovalInput {
            target: jt_app::ports::studio::ApprovalTarget::Slot(w.f.slot.id),
            expected_revision: 1,
        },
    )
    .await
    .unwrap();
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    let attempt = r
        .studio()
        .claim_publication(w.ctx.now)
        .await
        .unwrap()
        .unwrap();
    r.studio()
        .finish_publication(
            attempt.id(),
            jt_app::ports::studio::PublishOutcome::Unknown(jt_app::error::AppError::internal(
                "lost response",
            )),
            w.ctx.now,
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    let out = overview(&w.d, &w.ctx, query()).await.unwrap();
    assert!(
        out.today
            .blockers
            .iter()
            .any(|b| b.reason == "publish_unknown"
                && b.next_action.as_deref() == Some("review_publication_duplicate_risk"))
    );
    assert_eq!(
        work::slot_get(&w.d, &w.ctx, w.f.slot.id)
            .await
            .unwrap()
            .attempts
            .len(),
        1
    );
}
#[tokio::test]
async fn ledger_cursor_filters_across_chunks_and_preserves_global_takeover() {
    let w = support::world().await;
    let other = jt_testkit::studio_contract::ready(&w.uow).await;
    let mut foreign = w.ctx.clone();
    foreign.workspace_id = other.ws;
    let mut r = w.uow.tenant(other.ws).await.unwrap();
    r.ledger()
        .append(
            ledger_entry(
                &foreign,
                "studio.test",
                "studio_slot",
                other.slot.id,
                json!({"evidence_key":"foreign-tenant"}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.ledger()
        .append(
            ledger_entry(
                &w.ctx,
                "studio.slot_cancel",
                "studio_slot",
                w.f.slot.id,
                json!({"evidence_key":"matching-old"}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    for _ in 0..501 {
        r.ledger()
            .append(
                ledger_entry(&w.ctx, "studio.test", "unrelated", "no-chain", json!({})).unwrap(),
            )
            .await
            .unwrap();
    }
    r.commit().await.unwrap();
    w.brake(true, None, 0).await;
    let mut q = filter();
    q.hypothesis_id = Some(w.f.slot.chain.hypothesis_id);
    q.limit = 1;
    let first = ledger(&w.d, &w.ctx, q.clone()).await.unwrap();
    assert_eq!(first.entries[0].entry.action.as_str(), "studio.brake");
    q.before = first.next_before;
    let second = ledger(&w.d, &w.ctx, q.clone()).await.unwrap();
    assert_eq!(
        second.entries[0].entry.payload["evidence_key"],
        "matching-old"
    );
    q.before = second.next_before;
    assert!(ledger(&w.d, &w.ctx, q).await.unwrap().entries.is_empty());
    let out = ledger_export(&w.d, &w.ctx, StudioLedgerExportInput { filter: filter() })
        .await
        .unwrap();
    assert!(!out.content.contains("foreign-tenant"));
    let foreign_out = ledger_export(&w.d, &foreign, StudioLedgerExportInput { filter: filter() })
        .await
        .unwrap();
    assert!(foreign_out.content.contains("foreign-tenant"));
    assert!(!foreign_out.content.contains("matching-old"));
}
