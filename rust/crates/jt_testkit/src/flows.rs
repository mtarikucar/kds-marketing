//! Application flows that tests share, run through the real use cases.

use jt_app::usecases::Deps;
use jt_app::usecases::auth::LoginInput;
use jt_app::usecases::platform;
use jt_tenancy::{WorkspaceId, WorkspaceStatus};

/// The platform operator [`activate_workspace`] signs in as.
pub const OPERATOR_EMAIL: &str = "ops@jeeta.test";
/// Its password.
pub const OPERATOR_PASSWORD: &str = "operator passphrase";

/// Activates workspace `ws` as the platform operator does after payment: creates the operator
/// [`OPERATOR_EMAIL`] unless an operator exists, signs in as it and sets the status through
/// `platform::set_status`, which ledgers the change.
///
/// Panics when a step fails, e.g. when another operator was bootstrapped first.
pub async fn activate_workspace(deps: &Deps, ws: WorkspaceId) {
    platform::bootstrap(deps, OPERATOR_EMAIL, OPERATOR_PASSWORD)
        .await
        .expect("the test operator is bootstrapped");
    let session = platform::login(
        deps,
        LoginInput {
            email: OPERATOR_EMAIL.into(),
            password: OPERATOR_PASSWORD.into(),
        },
    )
    .await
    .expect("the test operator signs in (was another operator bootstrapped first?)");
    let pctx = platform::resolve(deps, &session.token)
        .await
        .expect("the operator session resolves");
    platform::set_status(deps, &pctx, ws, WorkspaceStatus::Active)
        .await
        .expect("the operator activates the workspace");
}

/// Give SMS fixtures an explicit price and a finite strategy cap. Existing prices stay intact.
pub async fn price_sms(deps: &Deps, ws: WorkspaceId) {
    use jt_strategy::{LaneKind, StrategyVersionId, VersionStatus};
    let now = deps.clock.now();
    let mut r = deps.uow.tenant(ws).await.unwrap();
    let caps: Vec<_> = r
        .capabilities()
        .list(Default::default())
        .await
        .unwrap()
        .into_iter()
        .filter(|c| c.kind_key == "sms_line" && c.budget_item_ids.is_empty())
        .collect();
    if caps.is_empty() {
        return;
    }
    let mut v = r
        .strategy()
        .current_approved()
        .await
        .unwrap()
        .expect("approved SMS fixture strategy");
    if !v
        .sections
        .budget_frame
        .lanes
        .iter()
        .any(|l| l.lane == LaneKind::Organic)
    {
        let hs = r.hypotheses().list(v.id).await.unwrap();
        r.strategy()
            .set_status(v.id, VersionStatus::Archived, now, None)
            .await
            .unwrap();
        v.id = StrategyVersionId::new_v7();
        v.number = r.strategy().next_number().await.unwrap();
        v.sections.budget_frame.lanes.push(jt_strategy::Lane {
            lane: LaneKind::Organic,
            period: jt_strategy::Period::Monthly,
            cap_minor: 100000,
            currency: "TRY".into(),
        });
        r.strategy().insert(v.clone()).await.unwrap();
        for h in hs {
            r.hypotheses().upsert(v.id, h).await.unwrap();
        }
    }
    for c in caps {
        let id = jt_capability::BudgetItemId::new_v7();
        r.budget()
            .insert_item(jt_capability::BudgetItem {
                id,
                workspace_id: ws,
                name: "SMS test price".into(),
                kind: jt_capability::BudgetKind::SmsBudget,
                unit: jt_capability::Unit::Currency("TRY".into()),
                cap: 100000,
                unit_cost_minor: Some(3),
                period: jt_capability::Period::Monthly,
                strategy_version_id: Some(v.id.0),
                created_at: now,
                retired_at: None,
            })
            .await
            .unwrap();
        r.budget().link(c.id, id).await.unwrap();
    }
    r.commit().await.unwrap();
}
