use jt_app::{
    ctx::Ctx,
    ports::{LedgerFilter, UnitOfWork},
    usecases::{
        Deps,
        inbox::{consumer, erasure, journeys, people},
    },
};
use jt_capability::{Capability, CapabilityId, NewCapability};
use jt_connector::{EventKind, InboundEvent, InboundEventId, Provider};
use jt_inbox::*;
use jt_ledger::Actor;
use jt_pg::TenantTx;
use jt_tenancy::{SystemRole, WorkspaceId};
use jt_testkit::{TestDb, fakes::FIXED_NOW, inbox_contract::Fixture};
use serde_json::{Value, json};
use std::sync::Arc;

struct World {
    db: TestDb,
    deps: Deps,
    ctx: Ctx,
    person: PersonId,
    cap: CapabilityId,
}
async fn setup() -> World {
    let db = TestDb::new().await;
    let uow = Arc::new(jt_pg::PgUnitOfWork::new(db.pool.clone()));
    let f = Fixture::new(uow.clone()).await;
    let deps = jt_testkit::fakes::deps(uow.clone());
    let ctx = Ctx {
        workspace_id: f.ws,
        actor: Actor::Human { user_id: f.user },
        permissions: SystemRole::Owner.permissions(),
        role_key: Some("owner".into()),
        now: FIXED_NOW,
        agent_connection_id: None,
    };
    let p=people::create(&deps,&ctx,serde_json::from_value(json!({"display_name":"Private Name","source":"form","identities":[{"channel":"email","value":" Private@Example.com "},{"channel":"phone","value":"05321234567"}]})).unwrap()).await.unwrap().person;
    let c = Capability::new(
        CapabilityId::new_v7(),
        f.ws,
        NewCapability {
            kind_key: "mailbox".into(),
            name: "Mail".into(),
            ..Default::default()
        },
        FIXED_NOW,
    )
    .unwrap();
    let mut r = uow.tenant(f.ws).await.unwrap();
    r.capabilities().insert(c.clone(), None).await.unwrap();
    r.commit().await.unwrap();
    World {
        db,
        deps,
        ctx,
        person: p.id,
        cap: c.id,
    }
}
async fn event(w: &World, ws: WorkspaceId, id: &str, payload: Value, raw: &[u8]) -> InboundEventId {
    let event = InboundEvent {
        id: InboundEventId::new_v7(),
        workspace_id: ws,
        capability_id: if ws == w.ctx.workspace_id {
            Some(w.cap)
        } else {
            None
        },
        provider: Provider::Mail,
        external_id: id.into(),
        kind: EventKind::Message,
        payload,
        received_at: FIXED_NOW,
        processed_at: None,
    };
    let id = event.id;
    let mut r = w.deps.uow.tenant(ws).await.unwrap();
    r.inbound_events()
        .insert_if_new(event, Some(raw.to_vec()))
        .await
        .unwrap();
    r.commit().await.unwrap();
    id
}
async fn erase(w: &World) {
    erasure::erase(
        &w.deps,
        &w.ctx,
        w.person,
        erasure::EraseInput { confirm: true },
    )
    .await
    .unwrap();
}
#[tokio::test]
async fn erasure_nulls_matching_raw_preserves_unrelated_parsed_data() {
    let w = setup().await;
    let ws = w.ctx.workspace_id;
    let a = event(
        &w,
        ws,
        "matching",
        json!({"from":"PRIVATE@example.com","text":"Private body","message_id":"m1"}),
        b"shared raw batch private body",
    )
    .await;
    let other = json!({"from":"other@example.com","text":"Other body","message_id":"m2"});
    let b = event(
        &w,
        ws,
        "same-batch",
        other.clone(),
        b"shared raw batch private body",
    )
    .await;
    let c = event(&w, ws, "other-batch", other.clone(), b"unrelated raw").await;
    let (other_ws, _) = w.db.seed_workspace("unrelated").await;
    event(
        &w,
        other_ws,
        "cross-tenant",
        other.clone(),
        b"shared raw batch private body",
    )
    .await;
    erase(&w).await;
    let mut tx = TenantTx::begin(&w.db.pool, ws).await.unwrap();
    for (id, matching, has_raw) in [(a, true, false), (b, false, false), (c, false, true)] {
        let (p, raw): (Value, Option<Vec<u8>>) = sqlx::query_as(
            "select payload,raw from inbound_events where workspace_id=$1 and id=$2",
        )
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .fetch_one(tx.conn())
        .await
        .unwrap();
        assert_eq!(raw.is_some(), has_raw);
        if matching {
            assert_eq!(p["text"], "");
            assert_eq!(p["from"], "");
            assert_eq!(p["person_id"], json!(w.person));
            assert_eq!(p["message_id"], "m1");
        } else {
            assert_eq!(p, other);
        }
    }
    tx.commit().await.unwrap();
    let mut tx = TenantTx::begin(&w.db.pool, other_ws).await.unwrap();
    let raw: Option<Vec<u8>> =
        sqlx::query_scalar("select raw from inbound_events where workspace_id=$1")
            .bind(other_ws.as_uuid())
            .fetch_one(tx.conn())
            .await
            .unwrap();
    assert!(raw.is_some());
}
#[tokio::test]
async fn erased_identity_replay_is_scrubbed_before_storage() {
    let w = setup().await;
    let ws = w.ctx.workspace_id;
    event(
        &w,
        ws,
        "imap:old",
        json!({"from":"private@example.com","text":"Hello","message_id":"old"}),
        b"old",
    )
    .await;
    assert_eq!(
        consumer::consume_workspace(&w.deps, ws, FIXED_NOW)
            .await
            .changed,
        1
    );
    erase(&w).await;
    for id in ["imap:reset:1", "webhook-replay"] {
        event(
            &w,
            ws,
            id,
            json!({"from":" Private@EXAMPLE.com ","text":"Replay","message_id":id}),
            b"replay",
        )
        .await;
    }
    let mut r = w.deps.uow.tenant(ws).await.unwrap();
    for rows in [
        r.inbound_events().list_pending(100).await.unwrap(),
        r.inbound_events()
            .list(jt_app::ports::EventQuery {
                pending_only: false,
                provider: None,
                kind: None,
                order: jt_app::ports::EventOrder::NewestFirst { before: None },
                limit: 100,
            })
            .await
            .unwrap(),
    ] {
        for row in rows {
            assert!(
                !row.payload
                    .to_string()
                    .to_lowercase()
                    .contains("private@example.com")
            );
            assert!(!row.payload.to_string().contains("Replay"));
        }
    }
    drop(r);
    let mut tx = TenantTx::begin(&w.db.pool, ws).await.unwrap();
    let raws: i64 = sqlx::query_scalar(
        "select count(*) from inbound_events where workspace_id=$1 and raw is not null",
    )
    .bind(ws.as_uuid())
    .fetch_one(tx.conn())
    .await
    .unwrap();
    assert_eq!(raws, 0);
    tx.commit().await.unwrap();
    let result = consumer::consume_workspace(&w.deps, ws, FIXED_NOW).await;
    assert_eq!(result.failed, 0);
    assert_eq!(result.changed, 0);
    assert_eq!(result.skipped, 2);
    let mut tx = TenantTx::begin(&w.db.pool, ws).await.unwrap();
    let (people,identities,drops):(i64,i64,i64)=sqlx::query_as("select (select count(*) from people where workspace_id=$1),(select count(*) from identities where workspace_id=$1),(select count(*) from event_consumption where workspace_id=$1 and outcome='erased_identity_drop')").bind(ws.as_uuid()).fetch_one(tx.conn()).await.unwrap();
    assert_eq!((people, identities, drops), (1, 0, 2));
}
#[tokio::test]
async fn ledger_storage_unchanged_reads_masked() {
    let w = setup().await;
    let ws = w.ctx.workspace_id;
    let payload = json!({"person_id":w.person,"name":"Private Name","nested":{"email":"private@example.com","body":"secret"},"amount_minor":1234});
    let mut tx = TenantTx::begin(&w.db.pool, ws).await.unwrap();
    sqlx::query("insert into ledger_entries(workspace_id,at,actor_kind,actor_component,action,payload) values($1,now(),'system','test','inbox.test',$2)").bind(ws.as_uuid()).bind(&payload).execute(tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
    erase(&w).await;
    let mut r = w.deps.uow.tenant(ws).await.unwrap();
    let rows = r
        .ledger()
        .list(LedgerFilter {
            action_prefix: Some("inbox.test".into()),
            limit: 100,
            actor_kind: None,
            agent_connection_id: None,
            before_id: None,
        })
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].entry.payload["name"], "");
    assert_eq!(rows[0].entry.payload["nested"]["email"], "");
    assert_eq!(rows[0].entry.payload["amount_minor"], 1234);
    drop(r);
    let mut tx = TenantTx::begin(&w.db.pool, ws).await.unwrap();
    let stored: Value = sqlx::query_scalar(
        "select payload from ledger_entries where workspace_id=$1 and action='inbox.test'",
    )
    .bind(ws.as_uuid())
    .fetch_one(tx.conn())
    .await
    .unwrap();
    assert_eq!(stored, payload);
}
#[tokio::test]
async fn erase_keeps_anonymous_ids_amounts_and_tombstone() {
    let w = setup().await;
    let ws = w.ctx.workspace_id;
    let mut r = w.deps.uow.tenant(ws).await.unwrap();
    let j = r.journeys().open_for(w.person).await.unwrap().unwrap();
    drop(r);
    journeys::report(&w.deps,&w.ctx,j.id,serde_json::from_value(json!({"kind":"won","idempotency_key":"won","payload":{"product":"Private product","amount_minor":1234,"currency":"TRY"}})).unwrap()).await.unwrap();
    erase(&w).await;
    let mut r = w.deps.uow.tenant(ws).await.unwrap();
    let p = r.people().get(w.person).await.unwrap().unwrap();
    assert_eq!(p.display_name, "silinmiş kişi");
    assert!(p.company.is_empty());
    assert!(p.erased_at.is_some());
    assert!(r.identities().list(w.person).await.unwrap().is_empty());
    let events = r.journeys().events(j.id, 100).await.unwrap();
    assert!(
        matches!(&events[0].kind,JourneyEventKind::Won{product,amount_minor:1234,..} if product.is_empty())
    );
    assert!(r.commissions().by_journey(j.id).await.unwrap().is_some());
}
#[tokio::test]
async fn ordinary_append_only_still_enforced() {
    let w = setup().await;
    let ws = w.ctx.workspace_id;
    let id = event(
        &w,
        ws,
        "event",
        json!({"person_id":w.person,"text":"Private"}),
        b"raw",
    )
    .await;
    erase(&w).await;
    let mut tx = TenantTx::begin(&w.db.pool, ws).await.unwrap();
    let flag: bool =
        sqlx::query_scalar("select coalesce(current_setting('jeeta.erasure',true)='on',false)")
            .fetch_one(tx.conn())
            .await
            .unwrap();
    assert!(!flag);
    let err = sqlx::query("update inbound_events set payload='{}' where workspace_id=$1 and id=$2")
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .execute(tx.conn())
        .await
        .unwrap_err();
    assert!(err.to_string().contains("append-only"));
}

#[tokio::test]
async fn erasure_scrubs_complete_inventory_and_rolls_back_atomically() {
    use jt_app::ports::inbox::{AppointmentRow, MergeRow, OutboxRow, QuoteRow};
    let w = setup().await;
    let ws = w.ctx.workspace_id;
    event(
        &w,
        ws,
        "inventory",
        json!({"from":"private@example.com","text":"Private message","message_id":"inventory"}),
        b"Private raw",
    )
    .await;
    assert_eq!(
        consumer::consume_workspace(&w.deps, ws, FIXED_NOW)
            .await
            .changed,
        1
    );
    let mut r = w.deps.uow.tenant(ws).await.unwrap();
    let j = r.journeys().open_for(w.person).await.unwrap().unwrap().id;
    let c = r.conversations().list(Some(w.person), 100).await.unwrap()[0].id;
    let m = r.messages().list(c, 100).await.unwrap()[0].id;
    let other = Person {
        id: PersonId::new_v7(),
        display_name: "Unrelated".into(),
        ..r.people().get(w.person).await.unwrap().unwrap()
    };
    r.people().insert(other.clone()).await.unwrap();
    r.notes()
        .insert(Note {
            id: NoteId::new_v7(),
            workspace_id: ws,
            journey_id: j,
            author: EventSource::System,
            text: "Private note".into(),
            at: FIXED_NOW,
        })
        .await
        .unwrap();
    r.tasks()
        .insert(Task {
            id: TaskId::new_v7(),
            workspace_id: ws,
            journey_id: j,
            title: "Private task".into(),
            due_at: FIXED_NOW,
            assignee: None,
            status: TaskStatus::Open,
        })
        .await
        .unwrap();
    let q = QuoteRow {
        id: uuid::Uuid::now_v7(),
        workspace_id: ws,
        quote: Quote {
            journey_id: j,
            amount_minor: 1234,
            currency: "TRY".into(),
            valid_until: FIXED_NOW,
            file_ref: Some("Private asset".into()),
            channel: Channel::Email,
            state: QuoteState::Sent,
        },
        created_at: FIXED_NOW,
    };
    r.quotes().insert(q.clone()).await.unwrap();
    r.appointments()
        .insert(AppointmentRow {
            id: uuid::Uuid::now_v7(),
            workspace_id: ws,
            appointment: Appointment {
                journey_id: j,
                starts_at: FIXED_NOW,
                ends_at: FIXED_NOW + time::Duration::hours(1),
                location: "Private address".into(),
                state: AppointmentState::Booked,
            },
            created_at: FIXED_NOW,
        })
        .await
        .unwrap();
    let oid = uuid::Uuid::now_v7();
    r.outbox().insert(OutboxRow{id:oid,workspace_id:ws,conversation_id:c,message_id:m,capability_id:w.cap,intent:json!({"mail":{"to":"private@example.com","text":"Private queued body","attachments":[{"bytes":[1,2,3]}]}}),expected_generation:0,fence_snapshot:Some(json!({"phone":"private"})),conversation_merged:false,state:"queued".into(),attempts:0,last_error:Some("private error".into()),created_at:FIXED_NOW,updated_at:FIXED_NOW}).await.unwrap();
    r.request_keys()
        .store(
            "quote-cache",
            json!({"quote":q,"delivery":{"message_id":m,"state":"queued"}}),
            FIXED_NOW,
        )
        .await
        .unwrap();
    r.request_keys()
        .store("unrelated-cache", json!({"public":"unchanged"}), FIXED_NOW)
        .await
        .unwrap();
    let merge_id = MergeId::new_v7();
    r.merges()
        .insert(MergeRow {
            id: merge_id,
            workspace_id: ws,
            source_id: other.id,
            target_id: w.person,
            decision: MergeDecision::Suggest(vec![]),
            conflicts: vec![],
            status: "suggested".into(),
            moved_snapshot: json!({"private":"original person"}),
            at: FIXED_NOW,
            applied_by: None,
            undone_at: None,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    // Fail after all other inventory mutations: every scrub, hash and log must roll back.
    let mut tx = TenantTx::begin(&w.db.pool, ws).await.unwrap();
    sqlx::raw_sql("create function test_erasure_failure() returns trigger language plpgsql as $$ begin raise exception 'injected failure'; end $$; create trigger test_erasure_failure before delete on identities for each row execute function test_erasure_failure();").execute(tx.conn()).await.unwrap();
    tx.commit().await.unwrap();
    assert!(
        erasure::erase(
            &w.deps,
            &w.ctx,
            w.person,
            erasure::EraseInput { confirm: true }
        )
        .await
        .is_err()
    );
    let mut r = w.deps.uow.tenant(ws).await.unwrap();
    assert!(r.erasure().get(w.person).await.unwrap().is_none());
    assert!(
        !r.erasure()
            .is_erased_identity(
                IdentityChannel::Email,
                &identity_hash(IdentityChannel::Email, "private@example.com")
            )
            .await
            .unwrap()
    );
    assert_eq!(
        r.messages().list(c, 100).await.unwrap()[0].body,
        "Private message"
    );
    drop(r);
    let mut tx = TenantTx::begin(&w.db.pool, ws).await.unwrap();
    sqlx::raw_sql(
        "drop trigger test_erasure_failure on identities; drop function test_erasure_failure();",
    )
    .execute(tx.conn())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    erase(&w).await;
    let mut r = w.deps.uow.tenant(ws).await.unwrap();
    assert_eq!(
        r.people()
            .get(other.id)
            .await
            .unwrap()
            .unwrap()
            .display_name,
        "Unrelated"
    );
    assert!(r.messages().list(c, 100).await.unwrap()[0].body.is_empty());
    assert!(r.notes().list(j).await.unwrap()[0].text.is_empty());
    assert!(
        r.quotes().list(j).await.unwrap()[0]
            .quote
            .file_ref
            .is_none()
    );
    assert_eq!(
        r.quotes().list(j).await.unwrap()[0].quote.amount_minor,
        1234
    );
    assert!(
        r.appointments().list(j).await.unwrap()[0]
            .appointment
            .location
            .is_empty()
    );
    let o = r.outbox().get(oid).await.unwrap().unwrap();
    assert_eq!(o.state, "refused");
    assert_eq!(o.intent, json!({}));
    assert!(o.fence_snapshot.is_none());
    assert!(o.last_error.is_none());
    assert!(
        r.request_keys()
            .get("quote-cache", FIXED_NOW)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        r.request_keys()
            .get("unrelated-cache", FIXED_NOW)
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(
        r.merges()
            .get(merge_id)
            .await
            .unwrap()
            .unwrap()
            .moved_snapshot,
        json!({})
    );
}

#[tokio::test]
async fn erasure_covers_inactive_identities_and_transitive_aliases() {
    let w = setup().await;
    let ws = w.ctx.workspace_id;
    let mut r = w.deps.uow.tenant(ws).await.unwrap();
    let template = r.people().get(w.person).await.unwrap().unwrap();
    let a = Person {
        id: PersonId::new_v7(),
        display_name: "Old private name".into(),
        ..template.clone()
    };
    let b = Person {
        id: PersonId::new_v7(),
        ..template
    };
    r.people().insert(a.clone()).await.unwrap();
    r.people().insert(b.clone()).await.unwrap();
    r.people()
        .mark_merged(a.id, Some(b.id), FIXED_NOW)
        .await
        .unwrap();
    r.people()
        .mark_merged(b.id, Some(w.person), FIXED_NOW)
        .await
        .unwrap();
    r.identities()
        .insert(Identity {
            id: IdentityId::new_v7(),
            workspace_id: ws,
            person_id: a.id,
            channel: IdentityChannel::Email,
            value_normalized: "historical@example.com".into(),
            value_display: "Historical@example.com".into(),
            active: false,
            first_seen_at: FIXED_NOW,
        })
        .await
        .unwrap();
    r.identities().deactivate_for(w.person).await.unwrap();
    r.commit().await.unwrap();
    let eid = event(
        &w,
        ws,
        "historic",
        json!({"person_id":a.id,"text":"historic private body"}),
        b"historic private raw",
    )
    .await;
    erase(&w).await;
    let mut r = w.deps.uow.tenant(ws).await.unwrap();
    for id in [a.id, b.id, w.person] {
        let p = r.people().get(id).await.unwrap().unwrap();
        assert_eq!(p.display_name, "silinmiş kişi");
        assert!(p.erased_at.is_some());
        assert!(r.erasure().get(id).await.unwrap().is_some());
    }
    for email in ["historical@example.com", "private@example.com"] {
        assert!(
            r.erasure()
                .is_erased_identity(
                    IdentityChannel::Email,
                    &identity_hash(IdentityChannel::Email, email)
                )
                .await
                .unwrap()
        );
    }
    drop(r);
    let mut tx = TenantTx::begin(&w.db.pool, ws).await.unwrap();
    let (p, raw): (Value, Option<Vec<u8>>) =
        sqlx::query_as("select payload,raw from inbound_events where workspace_id=$1 and id=$2")
            .bind(ws.as_uuid())
            .bind(eid.as_uuid())
            .fetch_one(tx.conn())
            .await
            .unwrap();
    assert_eq!(p["text"], "");
    assert!(raw.is_none());
    let count: i64 = sqlx::query_scalar("select count(*) from identities where workspace_id=$1")
        .bind(ws.as_uuid())
        .fetch_one(tx.conn())
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn erasure_identity_matching_respects_channel_namespace() {
    let w = setup().await;
    let ws = w.ctx.workspace_id;
    let payload = json!({"from":"user905321234567@example.com","text":"Unrelated private body"});
    let id = event(
        &w,
        ws,
        "numeric-email",
        payload.clone(),
        b"unrelated numeric-email raw",
    )
    .await;
    erase(&w).await;
    let mut tx = TenantTx::begin(&w.db.pool, ws).await.unwrap();
    let (stored, raw): (Value, Option<Vec<u8>>) =
        sqlx::query_as("select payload,raw from inbound_events where workspace_id=$1 and id=$2")
            .bind(ws.as_uuid())
            .bind(id.as_uuid())
            .fetch_one(tx.conn())
            .await
            .unwrap();
    assert_eq!(stored, payload);
    assert!(raw.is_some());
}

#[tokio::test]
async fn erasure_scrubs_formatted_sent_recipients_and_provider_status_pii() {
    let w = setup().await;
    let ws = w.ctx.workspace_id;
    let sent=event(&w,ws,"sent-header",json!({"from":"support@example.com","to":"Other <other@example.com>, Private Name <PRIVATE@example.com>","text":"Private sent body","subject":"Private subject","message_id":"sent-id"}),b"private sent raw").await;
    let status = event(
        &w,
        ws,
        "wa-status",
        json!({"status":{"id":"status-id","recipient_id":"905321234567","status":"delivered"}}),
        b"private status raw",
    )
    .await;
    erase(&w).await;
    let mut tx = TenantTx::begin(&w.db.pool, ws).await.unwrap();
    for id in [sent, status] {
        let (p, raw): (Value, Option<Vec<u8>>) = sqlx::query_as(
            "select payload,raw from inbound_events where workspace_id=$1 and id=$2",
        )
        .bind(ws.as_uuid())
        .bind(id.as_uuid())
        .fetch_one(tx.conn())
        .await
        .unwrap();
        assert!(raw.is_none());
        assert!(!p.to_string().contains("PRIVATE@example.com"));
        assert!(!p.to_string().contains("905321234567"));
        if id == sent {
            assert_eq!(p["text"], "");
        } else {
            assert_eq!(p["status"]["status"], "delivered");
        }
    }
}

#[tokio::test]
async fn erasure_clears_family_sender_references_before_deleting_inactive_keys() {
    let w = setup().await;
    let ws = w.ctx.workspace_id;
    event(
        &w,
        ws,
        "before-merge",
        json!({"from":"private@example.com","text":"Private","message_id":"before-merge"}),
        b"raw",
    )
    .await;
    assert_eq!(
        consumer::consume_workspace(&w.deps, ws, FIXED_NOW)
            .await
            .changed,
        1
    );
    let mut r = w.deps.uow.tenant(ws).await.unwrap();
    let alias = Person {
        id: PersonId::from(uuid::Uuid::nil()),
        merged_into: Some(w.person),
        ..r.people().get(w.person).await.unwrap().unwrap()
    };
    r.people().insert(alias.clone()).await.unwrap();
    r.commit().await.unwrap();
    // A merged message can retain its inactive original sender, now on an older alias.
    let mut tx = TenantTx::begin(&w.db.pool, ws).await.unwrap();
    sqlx::query(
        "update identities set person_id=$2,active=false where workspace_id=$1 and channel='email'",
    )
    .bind(ws.as_uuid())
    .bind(alias.id.as_uuid())
    .execute(tx.conn())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    erase(&w).await;
    let mut r = w.deps.uow.tenant(ws).await.unwrap();
    assert!(
        r.people()
            .get(alias.id)
            .await
            .unwrap()
            .unwrap()
            .erased_at
            .is_some()
    );
    assert!(
        r.erasure()
            .is_erased_identity(
                IdentityChannel::Email,
                &identity_hash(IdentityChannel::Email, "private@example.com")
            )
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn erasure_preserves_unknown_mail_evidence_without_personal_send_data() {
    use jt_app::ports::inbox::OutboxRow;
    let w = setup().await;
    let ws = w.ctx.workspace_id;
    event(
        &w,
        ws,
        "mail-before-erasure",
        json!({"from":"private@example.com","text":"Private","message_id":"inbound"}),
        b"raw",
    )
    .await;
    assert_eq!(
        consumer::consume_workspace(&w.deps, ws, FIXED_NOW)
            .await
            .changed,
        1
    );
    let mut r = w.deps.uow.tenant(ws).await.unwrap();
    let c = r.conversations().list(Some(w.person), 100).await.unwrap()[0].id;
    let message = MessageId::new_v7();
    let id = uuid::Uuid::now_v7();
    let mid = format!("<{id}@public.example>");
    r.messages()
        .insert_if_new(Message {
            id: message,
            workspace_id: ws,
            conversation_id: c,
            direction: Direction::Outbound,
            author: Author::Agent,
            body: "Private outgoing text".into(),
            external_id: None,
            status: MsgStatus::Unknown,
            cost_minor: None,
            at: FIXED_NOW,
        })
        .await
        .unwrap();
    r.outbox().insert(OutboxRow{id,workspace_id:ws,conversation_id:c,message_id:message,capability_id:w.cap,intent:json!({"mail":{"to":"private@example.com","text":"Private outgoing text","message_id":mid}}),expected_generation:0,fence_snapshot:None,conversation_merged:false,state:"unknown".into(),attempts:1,last_error:None,created_at:FIXED_NOW,updated_at:FIXED_NOW}).await.unwrap();
    r.commit().await.unwrap();
    erase(&w).await;
    let mut r = w.deps.uow.tenant(ws).await.unwrap();
    let intent = r.outbox().get(id).await.unwrap().unwrap().intent;
    assert_eq!(intent, json!({"mail":{"message_id":mid}}));
    r.inbound_events()
        .insert_if_new(
            InboundEvent {
                id: InboundEventId::new_v7(),
                workspace_id: ws,
                capability_id: Some(w.cap),
                provider: Provider::Mail,
                external_id: "imap:Sent:evidence".into(),
                kind: EventKind::Status,
                payload: json!({"message_id":mid,"status":"sent"}),
                received_at: FIXED_NOW,
                processed_at: None,
            },
            None,
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert_eq!(
        consumer::consume_workspace(&w.deps, ws, FIXED_NOW)
            .await
            .changed,
        1
    );
    let mut r = w.deps.uow.tenant(ws).await.unwrap();
    assert_eq!(r.outbox().get(id).await.unwrap().unwrap().state, "sent");
    assert!(
        r.messages()
            .get(message)
            .await
            .unwrap()
            .unwrap()
            .body
            .is_empty()
    );
}

async fn provider_erasure_payload(kind: &str, provider: Provider, payload: Value) -> Value {
    let w = setup().await;
    let ws = w.ctx.workspace_id;
    let mut cap = Capability::new(
        CapabilityId::new_v7(),
        ws,
        NewCapability {
            kind_key: kind.into(),
            name: "Provider".into(),
            ..Default::default()
        },
        FIXED_NOW,
    )
    .unwrap();
    cap.external_id = Some("page".into());
    let mut r = w.deps.uow.tenant(ws).await.unwrap();
    r.capabilities().insert(cap.clone(), None).await.unwrap();
    if kind == "messenger" {
        r.identities()
            .insert(Identity {
                id: IdentityId::new_v7(),
                workspace_id: ws,
                person_id: w.person,
                channel: IdentityChannel::Messenger,
                value_normalized: scope_opaque("page", "customer-id"),
                value_display: "customer-id".into(),
                active: true,
                first_seen_at: FIXED_NOW,
            })
            .await
            .unwrap();
    }
    let id = InboundEventId::new_v7();
    r.inbound_events()
        .insert_if_new(
            InboundEvent {
                id,
                workspace_id: ws,
                capability_id: Some(cap.id),
                provider,
                external_id: "provider-shape".into(),
                kind: EventKind::Status,
                payload,
                received_at: FIXED_NOW,
                processed_at: None,
            },
            Some(b"provider private raw".to_vec()),
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    erase(&w).await;
    let mut tx = TenantTx::begin(&w.db.pool, ws).await.unwrap();
    let (payload, raw): (Value, Option<Vec<u8>>) =
        sqlx::query_as("select payload,raw from inbound_events where workspace_id=$1 and id=$2")
            .bind(ws.as_uuid())
            .bind(id.as_uuid())
            .fetch_one(tx.conn())
            .await
            .unwrap();
    assert!(raw.is_none());
    payload
}
#[tokio::test]
async fn erasure_scrubs_netgsm_copied_rows_calls_and_recordings() {
    for (kind, payload) in [
        (
            "sms_line",
            json!({"from":"+905321234567","text":"private SMS","row":{"ceptel":"05321234567","mesaj":"private SMS"}}),
        ),
        (
            "netgsm_pbx",
            json!({"scenario":"hangup","unique_id":"call-id","customer_num":"05321234567","recording":"https://record.example/private","raw":{"arayan":"05321234567","seskaydi":"https://record.example/private"}}),
        ),
        (
            "netgsm_pbx",
            json!({"scenario":"cdr","unique_id":"cdr-id","source":"05321234567","destination":"123","recording":"https://record.example/private","raw":{"source":"05321234567"}}),
        ),
    ] {
        let p = provider_erasure_payload(kind, Provider::Netgsm, payload).await;
        assert!(!p.to_string().contains("5321234567"));
        assert!(!p.to_string().contains("private"));
    }
}
#[tokio::test]
async fn erasure_matches_iys_email_channel_on_sms_capability() {
    let p=provider_erasure_payload("sms_line",Provider::Netgsm,json!({"channel":"EPOSTA","recipient":"private@example.com","status":"RET","granted":false,"source":"iys","raw":{"recipient":"private@example.com","type":"EPOSTA"}})).await;
    assert!(!p.to_string().contains("private@example.com"));
    assert_eq!(p["status"], "RET");
    assert_eq!(p["granted"], false);
    assert_eq!(p["source"], "iys");
}
#[tokio::test]
async fn erasure_matches_flattened_meta_delivery_receipts() {
    let p=provider_erasure_payload("messenger",Provider::Meta,json!({"mid":"message-id","watermark":1234,"sender":{"id":"customer-id"},"recipient":{"id":"page"}})).await;
    assert!(!p.to_string().contains("customer-id"));
    assert_eq!(p["mid"], "message-id");
    assert_eq!(p["watermark"], 1234);
}

#[tokio::test]
async fn scrubbed_mail_evidence_still_reconciles_unknown_send() {
    use jt_app::ports::inbox::OutboxRow;
    let w = setup().await;
    let ws = w.ctx.workspace_id;
    event(
        &w,
        ws,
        "mail-before-erasure",
        json!({"from":"private@example.com","text":"Private","message_id":"inbound"}),
        b"raw",
    )
    .await;
    assert_eq!(
        consumer::consume_workspace(&w.deps, ws, FIXED_NOW)
            .await
            .changed,
        1
    );
    let mut r = w.deps.uow.tenant(ws).await.unwrap();
    let c = r.conversations().list(Some(w.person), 100).await.unwrap()[0].id;
    let message = MessageId::new_v7();
    let id = uuid::Uuid::now_v7();
    let mid = format!("<{id}@public.example>");
    r.messages()
        .insert_if_new(Message {
            id: message,
            workspace_id: ws,
            conversation_id: c,
            direction: Direction::Outbound,
            author: Author::Agent,
            body: "Private outgoing text".into(),
            external_id: None,
            status: MsgStatus::Unknown,
            cost_minor: None,
            at: FIXED_NOW,
        })
        .await
        .unwrap();
    r.outbox().insert(OutboxRow{id,workspace_id:ws,conversation_id:c,message_id:message,capability_id:w.cap,intent:json!({"mail":{"to":"private@example.com","text":"Private outgoing text","message_id":mid}}),expected_generation:0,fence_snapshot:None,conversation_merged:false,state:"unknown".into(),attempts:1,last_error:None,created_at:FIXED_NOW,updated_at:FIXED_NOW}).await.unwrap();
    r.commit().await.unwrap();
    let mut r = w.deps.uow.tenant(ws).await.unwrap();
    let intent = r.outbox().get(id).await.unwrap().unwrap().intent;
    assert_eq!(intent["mail"]["message_id"], mid);
    r.inbound_events()
        .insert_if_new(
            InboundEvent {
                id: InboundEventId::new_v7(),
                workspace_id: ws,
                capability_id: Some(w.cap),
                provider: Provider::Mail,
                external_id: "imap:Sent:evidence".into(),
                kind: EventKind::Status,
                payload: json!({"message_id":mid,"status":"sent","to":"private@example.com","text":"Private sent text"}),
                received_at: FIXED_NOW,
                processed_at: None,
            },
            None,
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    erase(&w).await;
    assert_eq!(
        consumer::consume_workspace(&w.deps, ws, FIXED_NOW)
            .await
            .changed,
        1
    );
    let mut r = w.deps.uow.tenant(ws).await.unwrap();
    assert_eq!(r.outbox().get(id).await.unwrap().unwrap().state, "sent");
    assert!(
        r.messages()
            .get(message)
            .await
            .unwrap()
            .unwrap()
            .body
            .is_empty()
    );
}

async fn outbound_message(w: &World, external: &str) -> MessageId {
    let mut r = w.deps.uow.tenant(w.ctx.workspace_id).await.unwrap();
    let c = r
        .conversations()
        .upsert_on_inbound(Conversation {
            id: ConversationId::new_v7(),
            workspace_id: w.ctx.workspace_id,
            person_id: w.person,
            capability_id: w.cap,
            kind_key: "mailbox".into(),
            state: ConvState::Ours,
            executor: Executor::Agent,
            executor_generation: 0,
            last_inbound_at: Some(FIXED_NOW),
            last_outbound_at: None,
            created_at: FIXED_NOW,
            updated_at: FIXED_NOW,
        })
        .await
        .unwrap();
    let id = MessageId::new_v7();
    r.messages()
        .insert_if_new(Message {
            id,
            workspace_id: w.ctx.workspace_id,
            conversation_id: c.id,
            direction: Direction::Outbound,
            author: Author::Agent,
            body: "Private outgoing".into(),
            external_id: Some(external.into()),
            status: MsgStatus::Sent,
            cost_minor: None,
            at: FIXED_NOW,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    id
}

#[tokio::test]
async fn late_dlr_after_erasure_stores_no_recipient() {
    use jt_app::ports::{
        compliance::{OutboundJobRow, OutboundJobState},
        connectors::{DeliveryState, DeliveryStatus},
    };
    let w = setup().await;
    let ws = w.ctx.workspace_id;
    let message = outbound_message(&w, "sms-job").await;
    let id = uuid::Uuid::now_v7();
    let mut r = w.deps.uow.tenant(ws).await.unwrap();
    r.outbound_jobs()
        .insert(OutboundJobRow {
            id,
            workspace_id: ws,
            capability_id: w.cap,
            provider_job_id: Some("sms-job".into()),
            message_id: Some(message),
            state: OutboundJobState::Sent,
            last_status: None,
            created_at: FIXED_NOW,
            updated_at: FIXED_NOW,
        })
        .await
        .unwrap();
    r.commit().await.unwrap();
    erase(&w).await;
    let mut r = w.deps.uow.tenant(ws).await.unwrap();
    r.people().set_write_time(FIXED_NOW).await.unwrap();
    r.outbound_jobs()
        .record_status(
            ws,
            w.cap,
            vec![DeliveryStatus {
                job_id: "sms-job".into(),
                recipient: "+905321234567".into(),
                status: DeliveryState::Delivered,
                at: None,
                raw_code: "1".into(),
            }],
        )
        .await
        .unwrap();
    let job = r.outbound_jobs().get(w.cap, id).await.unwrap().unwrap();
    assert!(job.last_status.is_none());
    assert_eq!(serde_json::to_value(job.state).unwrap(), "erased");
    assert!(
        r.outbound_jobs()
            .pending_job_ids(ws, w.cap, 100)
            .await
            .unwrap()
            .is_empty()
    );
    r.commit().await.unwrap();
}

#[tokio::test]
async fn mail_bounce_for_erased_person_is_scrubbed() {
    let w = setup().await;
    let ws = w.ctx.workspace_id;
    outbound_message(&w, "<original@example.com>").await;
    for status in ["failed", "complaint"] {
        event(&w, ws, status, json!({"message_id":"<original@example.com>","status":status,"from":"mailer-daemon@example.com","to":"support@example.com","text":"Private bounce"}), b"private@example.com original body").await;
    }
    let other = event(
        &w,
        ws,
        "unrelated-bounce",
        json!({"message_id":"<unrelated@example.com>","status":"failed","text":"Unrelated bounce"}),
        b"unrelated body",
    )
    .await;
    erase(&w).await;
    event(
        &w,
        ws,
        "late-bounce",
        json!({"message_id":"<original@example.com>","status":"failed","text":"Private bounce"}),
        b"private@example.com original body",
    )
    .await;
    let mut tx = TenantTx::begin(&w.db.pool, ws).await.unwrap();
    let rows: Vec<(uuid::Uuid, Value, Option<Vec<u8>>)> =
        sqlx::query_as("select id,payload,raw from inbound_events where workspace_id=$1")
            .bind(ws.as_uuid())
            .fetch_all(tx.conn())
            .await
            .unwrap();
    for (id, payload, raw) in rows {
        if id == other.as_uuid() {
            assert_eq!(payload["text"], "Unrelated bounce");
            assert!(raw.is_some());
        } else {
            assert_eq!(payload["text"], "");
            assert!(raw.is_none());
            assert_eq!(payload["message_id"], "<original@example.com>");
        }
    }
}
