use jt_app::ports::UnitOfWork;
use jt_testkit::{fakes::FIXED_NOW, inbox_contract::Fixture};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn request_completion_compares_response_and_preserves_expiry() {
    let db = jt_testkit::TestDb::new().await;
    let uow = Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
    let f = Fixture::new(uow.clone()).await;
    let mut r = uow.tenant(f.ws).await.unwrap();
    let queued = json!({"message_id":"first","state":"queued"});
    let sent = json!({"message_id":"first","state":"sent"});
    assert!(
        r.request_keys()
            .store("reply", queued.clone(), FIXED_NOW)
            .await
            .unwrap()
    );
    assert!(
        !r.request_keys()
            .complete("reply", json!({}), sent.clone())
            .await
            .unwrap()
    );
    assert!(
        r.request_keys()
            .complete("reply", queued, sent.clone())
            .await
            .unwrap()
    );
    assert_eq!(
        r.request_keys().get("reply", FIXED_NOW).await.unwrap(),
        Some(sent)
    );
    assert!(
        r.request_keys()
            .get("reply", FIXED_NOW + time::Duration::hours(24))
            .await
            .unwrap()
            .is_none()
    );
    r.commit().await.unwrap();
}

use jt_app::{
    ctx::Ctx,
    usecases::{Deps, inbox::replies},
};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{Credential, Provider};
use jt_inbox::*;
use jt_ledger::Actor;
use jt_tenancy::Permission;
use jt_testkit::fakes::{ScriptedConnector, ScriptedRegistry};

async fn ready(
    uow: Arc<jt_pg::PgUnitOfWork>,
) -> (Deps, Ctx, ConversationId, JourneyId, Arc<ScriptedConnector>) {
    let f = Fixture::new(uow.clone()).await;
    let mut deps = jt_testkit::fakes::deps(uow.clone());
    let connector = Arc::new(ScriptedConnector::new(Provider::Netgsm));
    deps.connectors = Arc::new(ScriptedRegistry::new().with_connector(connector.clone()));
    let p = f.insert_person("Recipient").await;
    let mut cap = Capability::new(
        CapabilityId::new_v7(),
        f.ws,
        NewCapability {
            kind_key: "sms_line".into(),
            name: "SMS".into(),
            ..Default::default()
        },
        FIXED_NOW,
    )
    .unwrap();
    cap.status = StoredStatus::Verified;
    cap.last_verified_at = Some(FIXED_NOW);
    let credential = Credential::NetgsmSms {
        usercode: "user".into(),
        password: "secret".into(),
        msgheader: "ACME".into(),
    };
    let sealed = deps
        .seal
        .seal(f.ws, &serde_json::to_vec(&credential).unwrap())
        .unwrap();
    let c = f.conversation(p.id, cap.id);
    let j = f.journey(p.id);
    let mut r = uow.tenant(f.ws).await.unwrap();
    r.capabilities().insert(cap, Some(sealed)).await.unwrap();
    r.identities()
        .insert(Identity {
            id: IdentityId::new_v7(),
            workspace_id: f.ws,
            person_id: p.id,
            channel: IdentityChannel::Phone,
            value_normalized: "+905321234567".into(),
            value_display: "test".into(),
            active: true,
            first_seen_at: FIXED_NOW,
        })
        .await
        .unwrap();
    r.strategy()
        .insert(jt_strategy::StrategyVersion {
            id: jt_strategy::StrategyVersionId::new_v7(),
            workspace_id: f.ws,
            number: 1,
            status: jt_strategy::VersionStatus::Approved,
            sections: jt_strategy::Sections::default(),
            created_at: FIXED_NOW,
            created_by: Actor::Human { user_id: f.user },
            submitted_at: Some(FIXED_NOW),
            approved_at: Some(FIXED_NOW),
            approved_by: Some(f.user),
            archived_at: None,
        })
        .await
        .unwrap();
    r.journeys().insert(j.clone()).await.unwrap();
    r.conversations()
        .upsert_on_inbound(c.clone())
        .await
        .unwrap();
    r.commit().await.unwrap();
    let ctx = Ctx {
        workspace_id: f.ws,
        actor: Actor::Human { user_id: f.user },
        permissions: [Permission::InboxWork].into(),
        role_key: Some("owner".into()),
        now: FIXED_NOW,
        agent_connection_id: None,
    };
    (deps, ctx, c.id, j.id, connector)
}
fn reply_input() -> replies::ReplyInput {
    serde_json::from_value(json!({"text":"Hello","intent":"reply","request_key":"same"})).unwrap()
}
fn receipt() -> Result<jt_app::ports::connectors::SendReceipt, jt_connector::ConnectorError> {
    Ok(jt_app::ports::connectors::SendReceipt {
        provider_id: "sms-job".into(),
        cost_minor: None,
    })
}

#[tokio::test]
async fn provider_io_releases_postgres_locks_and_concurrent_workers_claim_once() {
    let db = jt_testkit::TestDb::new().await;
    let uow = Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
    let (deps, ctx, cid, jid, connector) = ready(uow.clone()).await;
    let q = match replies::enqueue(&deps, &ctx, cid, reply_input())
        .await
        .unwrap()
    {
        replies::Enqueued::New(id) => id,
        _ => panic!(),
    };
    let ws = ctx.workspace_id;
    let io_uow = uow.clone();
    connector.push_sms(receipt());
    connector.push_send_hook(move || async move {
        tokio::time::timeout(std::time::Duration::from_secs(5), async move {
            let mut r = io_uow.tenant(ws).await.unwrap();
            r.people().lock_workspace().await.unwrap();
            r.conversations().lock(cid).await.unwrap().unwrap();
            r.journeys().lock(jid).await.unwrap().unwrap();
            assert_eq!(r.outbox().lock(q).await.unwrap().unwrap().state, "sending");
            r.conversations()
                .update_executor(cid, Executor::Human { user_id: None })
                .await
                .unwrap();
            r.commit().await.unwrap();
        })
        .await
        .expect("provider I/O must hold no DB lock");
    });
    let (a, b) = tokio::join!(
        replies::send_step(&deps, &ctx, q),
        replies::send_step(&deps, &ctx, q)
    );
    assert!(matches!(a.unwrap().state.as_str(), "sending" | "sent"));
    assert!(matches!(b.unwrap().state.as_str(), "sending" | "sent"));
    assert_eq!(connector.calls().len(), 1);
    let mut r = uow.tenant(ws).await.unwrap();
    let row = r.outbox().get(q).await.unwrap().unwrap();
    assert_eq!(row.state, "sent");
    assert_eq!(row.attempts, 1);
    assert_eq!(r.journeys().events(jid, 50).await.unwrap().len(), 1);
    assert_eq!(
        r.conversations().get(cid).await.unwrap().unwrap().executor,
        Executor::Human { user_id: None }
    );
}

#[tokio::test]
async fn concurrent_request_key_replies_store_one_message_and_one_provider_write() {
    let db = jt_testkit::TestDb::new().await;
    let uow = Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
    let (deps, ctx, cid, _, connector) = ready(uow.clone()).await;
    connector.push_sms(receipt());
    let (a, b) = tokio::join!(
        replies::reply(&deps, &ctx, cid, reply_input()),
        replies::reply(&deps, &ctx, cid, reply_input())
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(a.message_id, b.message_id);
    assert!(matches!(a.state.as_str(), "sent" | "queued"));
    assert!(matches!(b.state.as_str(), "sent" | "queued"));
    assert_eq!(connector.calls().len(), 1);
    let mut r = uow.tenant(ctx.workspace_id).await.unwrap();
    assert_eq!(r.messages().list(cid, 50).await.unwrap().len(), 1);
    let stored = r
        .request_keys()
        .get("same", FIXED_NOW)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored["state"], "sent");
}
