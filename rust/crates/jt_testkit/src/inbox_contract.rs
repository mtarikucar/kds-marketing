//! The same inbox contracts exercised by both adapters. Races are additionally tested on PostgreSQL.
use crate::fakes::{FIXED_NOW, deps};
use jt_app::usecases::auth::{self, RegisterInput};
use jt_app::{
    error::ErrorCode,
    ports::inbox::*,
    ports::{UnitOfWork, UserRow},
};
use jt_capability::{Capability, CapabilityId, NewCapability};
use jt_connector::{EventKind, InboundEvent, InboundEventId, Provider};
use jt_inbox::*;
use jt_tenancy::{Email, Permission, SystemRole, UserId, WorkspaceId, WorkspaceStatus};
use serde_json::json;
use std::sync::Arc;
use time::Duration;
use uuid::Uuid;

pub struct Fixture {
    pub uow: Arc<dyn UnitOfWork>,
    pub ws: WorkspaceId,
    pub other: WorkspaceId,
    pub user: UserId,
}
impl Fixture {
    pub async fn new(uow: Arc<dyn UnitOfWork>) -> Self {
        let (ws, other, user) = (
            WorkspaceId::new_v7(),
            WorkspaceId::new_v7(),
            UserId::new_v7(),
        );
        let mut t = uow.user().await.unwrap();
        t.users()
            .insert(UserRow {
                id: user,
                email: Email::parse(&format!("{}@example.test", user.as_uuid())).unwrap(),
                password_hash: "plain:test".into(),
                display_name: "Owner".into(),
                created_at: FIXED_NOW,
            })
            .await
            .unwrap();
        for id in [ws, other] {
            t.workspaces_create(
                id,
                "Contract",
                &id.to_string(),
                WorkspaceStatus::Active,
                FIXED_NOW,
            )
            .await
            .unwrap();
            t.lost_reasons_initialize(id).await.unwrap();
        }
        t.commit().await.unwrap();
        Self {
            uow,
            ws,
            other,
            user,
        }
    }
    pub fn person(&self, name: &str) -> Person {
        Person {
            id: PersonId::new_v7(),
            workspace_id: self.ws,
            display_name: name.into(),
            company: "Company".into(),
            first_touch: FirstTouch {
                source: Source::Import,
                capability_id: None,
                at: FIXED_NOW,
            },
            merged_into: None,
            erased_at: None,
            created_at: FIXED_NOW,
            updated_at: FIXED_NOW,
        }
    }
    pub async fn insert_person(&self, name: &str) -> Person {
        let p = self.person(name);
        let mut t = self.uow.tenant(self.ws).await.unwrap();
        t.people().insert(p.clone()).await.unwrap();
        t.commit().await.unwrap();
        p
    }
    pub async fn capability(&self) -> CapabilityId {
        let c = Capability::new(
            CapabilityId::new_v7(),
            self.ws,
            NewCapability {
                kind_key: "sms_line".into(),
                name: "SMS".into(),
                ..NewCapability::default()
            },
            FIXED_NOW,
        )
        .unwrap();
        let mut t = self.uow.tenant(self.ws).await.unwrap();
        t.capabilities().insert(c.clone(), None).await.unwrap();
        t.commit().await.unwrap();
        c.id
    }
    pub fn conversation(&self, p: PersonId, c: CapabilityId) -> Conversation {
        Conversation {
            created_at: FIXED_NOW,
            updated_at: FIXED_NOW,
            id: ConversationId::new_v7(),
            workspace_id: self.ws,
            person_id: p,
            capability_id: c,
            kind_key: "sms_line".into(),
            state: ConvState::Open,
            executor: Executor::Agent,
            executor_generation: 0,
            last_inbound_at: Some(FIXED_NOW),
            last_outbound_at: None,
        }
    }
    pub fn journey(&self, p: PersonId) -> Journey {
        Journey {
            id: JourneyId::new_v7(),
            workspace_id: self.ws,
            person_id: p,
            status: JourneyStatus::New,
            owner: Some(self.user),
            opened_at: FIXED_NOW,
            closed_at: None,
            lost_reason: None,
            unreachable_attempts: 0,
            source: Source::Import,
            updated_at: FIXED_NOW,
            reduce_input: ReduceInput::default(),
        }
    }
    /// Seed a valid new journey through the domain proof, then explicitly assign its owner.
    /// The complete initial-state assertion prevents fixtures from silently discarding a stage.
    pub async fn insert_journey(
        &self,
        repos: &mut dyn jt_app::ports::TenantRepos,
        row: &Journey,
    ) -> Result<(), jt_app::error::AppError> {
        let initial = begin_journey(
            row.id,
            row.workspace_id,
            row.person_id,
            row.source.clone(),
            row.opened_at,
        );
        let mut expected = row.clone();
        expected.owner = None;
        assert_eq!(
            initial.journey(),
            &expected,
            "fixture must be an initial journey"
        );
        repos.journeys().insert_initial(initial).await?;
        if row.owner.is_some() {
            repos.journeys().assign_owner(row.id, row.owner).await?;
        }
        Ok(())
    }
    pub fn event(&self, j: JourneyId, key: &str, kind: JourneyEventKind) -> JourneyEvent {
        JourneyEvent {
            id: JourneyEventId::new_v7(),
            workspace_id: self.ws,
            journey_id: j,
            source: EventSource::Human(self.user),
            idempotency_key: key.into(),
            kind,
            reason_label: Some("Fiyat".into()),
            at: FIXED_NOW + Duration::minutes(1),
        }
    }
    pub fn message(&self, c: ConversationId) -> Message {
        Message {
            id: MessageId::new_v7(),
            workspace_id: self.ws,
            conversation_id: c,
            direction: Direction::Inbound,
            author: Author::Customer,
            body: "Hello".into(),
            external_id: Some("provider-1".into()),
            status: MsgStatus::Received,
            cost_minor: None,
            at: FIXED_NOW,
        }
    }
}

pub async fn request_keys_workspace_scope_and_24h_expiry(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow).await;
    let now = FIXED_NOW;
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    assert!(
        t.request_keys()
            .store("key", json!({"id":1}), now)
            .await
            .unwrap()
    );
    assert!(
        !t.request_keys()
            .store(
                "key",
                json!({"id":2}),
                now + Duration::hours(24) - Duration::nanoseconds(1)
            )
            .await
            .unwrap()
    );
    assert_eq!(
        t.request_keys()
            .get("key", now + Duration::hours(24) - Duration::nanoseconds(1))
            .await
            .unwrap(),
        Some(json!({"id":1}))
    );
    assert_eq!(
        t.request_keys()
            .get("key", now + Duration::hours(24))
            .await
            .unwrap(),
        None
    );
    assert!(
        t.request_keys()
            .store("key", json!({"id":2}), now + Duration::hours(24))
            .await
            .unwrap()
    );
    t.commit().await.unwrap();
    let mut t = f.uow.tenant(f.other).await.unwrap();
    assert_eq!(t.request_keys().get("key", now).await.unwrap(), None);
    assert!(t.request_keys().store("key", json!(3), now).await.unwrap());
    t.commit().await.unwrap();
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        t.request_keys()
            .get("key", now + Duration::hours(25))
            .await
            .unwrap(),
        Some(json!({"id":2}))
    );
    assert!(
        t.request_keys()
            .store("rollback", json!(4), now)
            .await
            .unwrap()
    );
    drop(t);
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    assert_eq!(t.request_keys().get("rollback", now).await.unwrap(), None);
}

pub async fn consumer_filters_before_limit_ignores_ack(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow).await;
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    let mut ids = vec![];
    for i in 0..4 {
        let e = InboundEvent {
            id: InboundEventId::new_v7(),
            workspace_id: f.ws,
            provider: Provider::Meta,
            capability_id: None,
            external_id: format!("event-{i}"),
            kind: EventKind::Message,
            payload: json!({}),
            received_at: FIXED_NOW + Duration::seconds(i),
            processed_at: Some(FIXED_NOW),
        };
        ids.push(e.id);
        t.inbound_events().insert_if_new(e, None).await.unwrap();
    }
    for id in &ids[..2] {
        assert!(t.consumption().try_claim("inbox@1", *id).await.unwrap());
        t.consumption()
            .record(
                "inbox@1",
                *id,
                ConsumptionOutcome {
                    consumed_at: FIXED_NOW,
                    outcome: "deferred".into(),
                },
            )
            .await
            .unwrap();
    }
    t.commit().await.unwrap();
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        t.inbound_events()
            .list_for_consumer("inbox@1", None, 1)
            .await
            .unwrap()[0]
            .id,
        ids[2]
    );
    assert_eq!(
        t.inbound_events()
            .list_for_consumer(
                "inbox@1",
                Some((FIXED_NOW + Duration::seconds(2), ids[2])),
                1
            )
            .await
            .unwrap()[0]
            .id,
        ids[3]
    );
    assert_eq!(
        t.inbound_events()
            .list_for_consumer("inbox@2", None, 10)
            .await
            .unwrap()
            .len(),
        4
    );
    assert!(!t.consumption().try_claim("inbox@1", ids[0]).await.unwrap());
    assert!(t.consumption().try_claim("inbox@1", ids[2]).await.unwrap());
    let p = f.person("rolled back");
    t.people().insert(p.clone()).await.unwrap();
    t.consumption()
        .record(
            "inbox@1",
            ids[2],
            ConsumptionOutcome {
                consumed_at: FIXED_NOW,
                outcome: "completed".into(),
            },
        )
        .await
        .unwrap();
    drop(t);
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    assert!(t.people().get(p.id).await.unwrap().is_none());
    assert!(t.consumption().try_claim("inbox@1", ids[2]).await.unwrap());
    t.people().insert(p.clone()).await.unwrap();
    t.consumption()
        .record(
            "inbox@1",
            ids[2],
            ConsumptionOutcome {
                consumed_at: FIXED_NOW,
                outcome: "completed".into(),
            },
        )
        .await
        .unwrap();
    t.commit().await.unwrap();
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    assert_eq!(t.people().get(p.id).await.unwrap(), Some(p));
    assert_eq!(
        t.inbound_events()
            .list_for_consumer("inbox@1", None, 10)
            .await
            .unwrap()
            .len(),
        1
    );
    let mut t = f.uow.tenant(f.other).await.unwrap();
    assert!(
        t.inbound_events()
            .list_for_consumer("inbox@1", None, 10)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        t.consumption()
            .try_claim("inbox@1", ids[0])
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
}

pub async fn people_identities_and_tombstones(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow).await;
    let a = f.insert_person("Ada %").await;
    let b = f.insert_person("Bora").await;
    let identity = Identity {
        id: IdentityId::new_v7(),
        workspace_id: f.ws,
        person_id: a.id,
        channel: IdentityChannel::Phone,
        value_normalized: "+905550000000".into(),
        value_display: "0555 000 00 00".into(),
        active: true,
        first_seen_at: FIXED_NOW,
    };
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    t.identities().insert(identity.clone()).await.unwrap();
    let a = t.people().get(a.id).await.unwrap().unwrap();
    assert_eq!(t.people().lock(a.id).await.unwrap(), Some(a.clone()));
    assert_eq!(
        t.people()
            .find_by_identity(IdentityChannel::Phone, &identity.value_normalized)
            .await
            .unwrap(),
        Some(a.clone())
    );
    assert_eq!(
        t.people().search("%", 10, 0).await.unwrap(),
        vec![a.clone()]
    );
    // An empty query pages through every person in (created_at, id) order.
    let everyone = t.people().search("", 10, 0).await.unwrap();
    assert!(!everyone.is_empty());
    for (i, person) in everyone.iter().enumerate() {
        assert_eq!(
            t.people().search("", 1, i as u32).await.unwrap(),
            vec![person.clone()]
        );
    }
    assert!(
        t.people()
            .search("", 10, everyone.len() as u32)
            .await
            .unwrap()
            .is_empty()
    );
    t.commit().await.unwrap();
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    let mut dup = identity.clone();
    dup.id = IdentityId::new_v7();
    dup.person_id = b.id;
    assert_eq!(
        t.identities().insert(dup.clone()).await.unwrap_err().code,
        ErrorCode::Conflict
    );
    drop(t);
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    t.identities().deactivate_for(a.id).await.unwrap();
    t.identities().insert(dup.clone()).await.unwrap();
    t.identities().move_to(b.id, a.id).await.unwrap();
    assert!(t.identities().list(b.id).await.unwrap().is_empty());
    let live = t.identities().list(a.id).await.unwrap();
    assert_eq!(live.len(), 1);
    assert_eq!(live[0].id, dup.id);
    t.people()
        .mark_merged(a.id, Some(b.id), FIXED_NOW)
        .await
        .unwrap();
    assert!(
        t.people()
            .find_by_identity(IdentityChannel::Phone, &identity.value_normalized)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        t.people().get(a.id).await.unwrap().unwrap().first_touch,
        a.first_touch
    );
    t.people().mark_merged(a.id, None, FIXED_NOW).await.unwrap();
    t.people().set_erased(a.id, FIXED_NOW).await.unwrap();
    assert!(
        t.people()
            .find_by_identity(IdentityChannel::Phone, &identity.value_normalized)
            .await
            .unwrap()
            .is_none()
    );
    t.commit().await.unwrap();
    let mut t = f.uow.tenant(f.other).await.unwrap();
    assert!(t.people().get(a.id).await.unwrap().is_none());
    assert!(t.identities().list(a.id).await.unwrap().is_empty());
    let mut wrong = dup;
    wrong.id = IdentityId::new_v7();
    wrong.workspace_id = f.other;
    assert_eq!(
        t.identities().insert(wrong).await.unwrap_err().code,
        ErrorCode::NotFound
    );
}

pub async fn conversations_and_message_dedupe(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow).await;
    let p = f.insert_person("Person").await;
    let cap = f.capability().await;
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    let c = t
        .conversations()
        .upsert_on_inbound(f.conversation(p.id, cap))
        .await
        .unwrap();
    assert_eq!(c.state, ConvState::Ours);
    assert_eq!(
        t.conversations()
            .update_executor(
                c.id,
                Executor::Human {
                    user_id: Some(f.user)
                }
            )
            .await
            .unwrap(),
        1
    );
    t.conversations()
        .update_state(
            c.id,
            ConvState::Snoozed {
                until: FIXED_NOW + Duration::days(1),
            },
            None,
        )
        .await
        .unwrap();
    assert!(matches!(
        t.conversations().get(c.id).await.unwrap().unwrap().state,
        ConvState::Snoozed { .. }
    ));
    let reopened = t
        .conversations()
        .upsert_on_inbound(f.conversation(p.id, cap))
        .await
        .unwrap();
    assert_eq!(reopened.id, c.id);
    assert_eq!(reopened.executor_generation, 1);
    assert_eq!(
        reopened.executor,
        Executor::Human {
            user_id: Some(f.user)
        }
    );
    assert_eq!(reopened.state, ConvState::Ours);
    assert_eq!(
        t.conversations()
            .update_executor(c.id, Executor::Agent)
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        t.conversations()
            .update_executor(c.id, Executor::Agent)
            .await
            .unwrap(),
        3
    );
    t.conversations()
        .update_state(c.id, ConvState::Theirs, Some(FIXED_NOW))
        .await
        .unwrap();
    assert_eq!(
        t.conversations()
            .lock(c.id)
            .await
            .unwrap()
            .unwrap()
            .last_outbound_at,
        Some(FIXED_NOW)
    );
    assert_eq!(
        t.conversations().list(Some(p.id), 10).await.unwrap().len(),
        1
    );
    let m = f.message(c.id);
    assert_eq!(
        t.messages().insert_if_new(m.clone()).await.unwrap(),
        Some(m.id)
    );
    let mut replay = m.clone();
    replay.id = MessageId::new_v7();
    assert_eq!(t.messages().insert_if_new(replay).await.unwrap(), None);
    for _ in 0..2 {
        let mut local = m.clone();
        local.id = MessageId::new_v7();
        local.external_id = None;
        assert!(t.messages().insert_if_new(local).await.unwrap().is_some());
    }
    t.messages()
        .set_status(
            m.id,
            MsgStatus::Refused {
                reason: "fence".into(),
            },
            None,
            Some(12),
        )
        .await
        .unwrap();
    let rows = t.messages().list(c.id, 10).await.unwrap();
    assert_eq!(rows.len(), 3);
    let stored = rows.iter().find(|r| r.id == m.id).unwrap();
    assert_eq!(stored.cost_minor, Some(12));
    assert_eq!(
        stored.status,
        MsgStatus::Refused {
            reason: "fence".into()
        }
    );
    assert_eq!(stored.external_id, m.external_id);
    t.commit().await.unwrap();
    let mut t = f.uow.tenant(f.other).await.unwrap();
    assert!(t.conversations().get(c.id).await.unwrap().is_none());
    assert!(t.messages().list(c.id, 10).await.unwrap().is_empty());
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    let mut collision = m;
    collision.external_id = None;
    assert_eq!(
        t.messages()
            .insert_if_new(collision)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
}

/// Domain creation proofs preserve exact initial state, scope and uniqueness on both adapters.
pub async fn initial_journey_is_scoped_and_immutable(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow).await;
    let person = f.insert_person("Initial journey").await;
    let initial = begin_journey(
        JourneyId::new_v7(),
        f.ws,
        person.id,
        Source::Repeat,
        FIXED_NOW,
    );
    let expected = initial.journey().clone();
    let mut forged_copy = expected.clone();
    forged_copy.status = JourneyStatus::Won;
    forged_copy.closed_at = Some(FIXED_NOW);
    forged_copy.unreachable_attempts = 7;
    assert_ne!(&forged_copy, initial.journey());
    let mut r = f.uow.tenant(f.ws).await.unwrap();
    r.journeys().insert_initial(initial.clone()).await.unwrap();
    assert_eq!(
        r.journeys().get(expected.id).await.unwrap(),
        Some(expected.clone())
    );
    assert_eq!(r.journeys().reducer_revision(expected.id).await.unwrap(), 0);
    assert!(
        r.journeys()
            .events(expected.id, 10)
            .await
            .unwrap()
            .is_empty()
    );
    r.commit().await.unwrap();
    let mut r = f.uow.tenant(f.other).await.unwrap();
    assert!(r.journeys().get(expected.id).await.unwrap().is_none());
    assert_eq!(
        r.journeys()
            .insert_initial(initial.clone())
            .await
            .unwrap_err()
            .code,
        ErrorCode::Internal
    );
    drop(r);
    let mut r = f.uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        r.journeys().insert_initial(initial).await.unwrap_err().code,
        ErrorCode::Conflict
    );
    drop(r);
    let mut r = f.uow.tenant(f.other).await.unwrap();
    let foreign_person = begin_journey(
        JourneyId::new_v7(),
        f.other,
        person.id,
        Source::Import,
        FIXED_NOW,
    );
    assert_eq!(
        r.journeys()
            .insert_initial(foreign_person)
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    drop(r);
    let mut r = f.uow.tenant(f.ws).await.unwrap();
    assert_eq!(r.journeys().get(expected.id).await.unwrap(), Some(expected));
}

pub async fn reducer_patch_and_event_are_atomic(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow).await;
    let p = f.insert_person("Journey").await;
    let j = f.journey(p.id);
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    f.insert_journey(t.as_mut(), &j).await.unwrap();
    t.commit().await.unwrap();
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        f.insert_journey(t.as_mut(), &f.journey(p.id))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    drop(t);
    for i in 0..3 {
        let mut t = f.uow.tenant(f.ws).await.unwrap();
        let current = t.journeys().lock(j.id).await.unwrap().unwrap();
        let e = f.event(
            j.id,
            &format!("call-{i}"),
            JourneyEventKind::CallMade { connected: false },
        );
        let transition = reduce(&current, &e, &ReducePolicy::default()).unwrap();
        t.journeys()
            .apply_transition(j.id, transition, e)
            .await
            .unwrap();
        t.commit().await.unwrap();
    }
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    let current = t.journeys().get(j.id).await.unwrap().unwrap();
    assert_eq!(current.status, JourneyStatus::Unreachable);
    assert_eq!(current.unreachable_attempts, 3);
    let lost = f.event(
        j.id,
        "lost",
        JourneyEventKind::Lost {
            reason_key: "fiyat".into(),
        },
    );
    let transition = reduce(&current, &lost, &ReducePolicy::default()).unwrap();
    t.journeys()
        .apply_transition(j.id, transition, lost.clone())
        .await
        .unwrap();
    assert!(t.journeys().open_for(p.id).await.unwrap().is_none());
    let mut current = t.journeys().latest_for(p.id).await.unwrap().unwrap();
    assert_eq!(current.lost_reason.as_ref().unwrap().reason_label, "Fiyat");
    assert!(current.closed_at.is_some());
    current.reduce_input = ReduceInput::new([], true).unwrap();
    let reopen = f.event(j.id, "reopen", JourneyEventKind::Reopened);
    let transition = reduce(&current, &reopen, &ReducePolicy::default()).unwrap();
    t.journeys()
        .apply_transition(j.id, transition, reopen)
        .await
        .unwrap();
    let reopened = t.journeys().get(j.id).await.unwrap().unwrap();
    assert_eq!(reopened.status, JourneyStatus::Contacted);
    assert_eq!(reopened.unreachable_attempts, 0);
    assert!(reopened.closed_at.is_none() && reopened.lost_reason.is_none());
    assert_eq!(t.journeys().events(j.id, 500).await.unwrap().len(), 5);
    t.commit().await.unwrap();
    // Existing event key cannot produce another patch, even if the candidate event would win.
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    let current = t.journeys().lock(j.id).await.unwrap().unwrap();
    let e = f.event(
        j.id,
        "reopen",
        JourneyEventKind::Won {
            product: "Product".into(),
            amount_minor: 1,
            currency: "TRY".into(),
        },
    );
    let transition = reduce(&current, &e, &ReducePolicy::default()).unwrap();
    assert_eq!(
        t.journeys()
            .apply_transition(j.id, transition, e)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    drop(t);
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    assert_eq!(t.journeys().get(j.id).await.unwrap().unwrap(), reopened);
    assert_eq!(t.journeys().events(j.id, 500).await.unwrap().len(), 5);
    let mut t = f.uow.tenant(f.other).await.unwrap();
    assert!(t.journeys().get(j.id).await.unwrap().is_none());
    assert!(t.journeys().events(j.id, 500).await.unwrap().is_empty());
}

pub async fn tasks_notes_merges_and_outbox(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow).await;
    let p = f.insert_person("Keeper").await;
    let q = f.insert_person("Merged").await;
    let cap = f.capability().await;
    let j = f.journey(p.id);
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    f.insert_journey(t.as_mut(), &j).await.unwrap();
    let c = t
        .conversations()
        .upsert_on_inbound(f.conversation(p.id, cap))
        .await
        .unwrap();
    let m = f.message(c.id);
    t.messages().insert_if_new(m.clone()).await.unwrap();
    let mut task = Task {
        id: TaskId::new_v7(),
        workspace_id: f.ws,
        journey_id: j.id,
        title: "Call".into(),
        due_at: FIXED_NOW,
        assignee: Some(f.user),
        status: TaskStatus::Open,
    };
    t.tasks().insert(task.clone()).await.unwrap();
    assert_eq!(t.tasks().list(j.id).await.unwrap(), vec![task.clone()]);
    t.tasks()
        .set_status(task.id, TaskStatus::Done)
        .await
        .unwrap();
    task.status = TaskStatus::Done;
    assert_eq!(t.tasks().list(j.id).await.unwrap(), vec![task]);
    let note = Note {
        id: NoteId::new_v7(),
        workspace_id: f.ws,
        journey_id: j.id,
        author: EventSource::Human(f.user),
        text: "Note".into(),
        at: FIXED_NOW,
    };
    t.notes().insert(note.clone()).await.unwrap();
    assert_eq!(t.notes().list(j.id).await.unwrap(), vec![note]);
    let mut merge = MergeRow {
        id: MergeId::new_v7(),
        workspace_id: f.ws,
        source_id: q.id,
        target_id: p.id,
        decision: MergeDecision::Auto {
            keep: p.id,
            merge: q.id,
        },
        conflicts: vec![],
        status: "applied".into(),
        moved_snapshot: json!({"identity_ids":[]}),
        at: FIXED_NOW,
        applied_by: Some(f.user),
        undone_at: None,
    };
    t.merges().insert(merge.clone()).await.unwrap();
    assert_eq!(
        t.merges().lock(merge.id).await.unwrap(),
        Some(merge.clone())
    );
    assert_eq!(t.merges().list(p.id).await.unwrap(), vec![merge.clone()]);
    t.merges().mark_undone(merge.id, FIXED_NOW).await.unwrap();
    merge.status = "undone".into();
    merge.undone_at = Some(FIXED_NOW);
    assert_eq!(t.merges().get(merge.id).await.unwrap(), Some(merge.clone()));
    let mut out = OutboxRow {
        id: Uuid::now_v7(),
        workspace_id: f.ws,
        conversation_id: c.id,
        message_id: m.id,
        capability_id: cap,
        intent: json!({"text":"hello"}),
        expected_generation: 0,
        fence_snapshot: None,
        conversation_merged: false,
        state: "queued".into(),
        attempts: 0,
        last_error: None,
        created_at: FIXED_NOW,
        updated_at: FIXED_NOW,
    };
    t.outbox().insert(out.clone()).await.unwrap();
    assert_eq!(t.outbox().lock(out.id).await.unwrap(), Some(out.clone()));
    assert_eq!(
        t.outbox()
            .list_pending("queued", FIXED_NOW + Duration::seconds(1), 10)
            .await
            .unwrap(),
        vec![out.clone()]
    );
    out.state = "unknown".into();
    out.attempts = 1;
    out.last_error = Some("uncertain".into());
    out.fence_snapshot = Some(json!({"generation":0}));
    t.outbox().update(out.clone()).await.unwrap();
    assert_eq!(t.outbox().get(out.id).await.unwrap(), Some(out.clone()));
    t.commit().await.unwrap();
    let mut t = f.uow.tenant(f.other).await.unwrap();
    assert!(t.tasks().list(j.id).await.unwrap().is_empty());
    assert!(t.notes().list(j.id).await.unwrap().is_empty());
    assert!(t.merges().get(merge.id).await.unwrap().is_none());
    assert!(t.outbox().get(out.id).await.unwrap().is_none());
}

pub async fn lost_defaults_existing_and_new_workspaces(uow: Arc<dyn UnitOfWork>) {
    // Use the actual registration use case: initialization must not depend on first inbox use.
    let deps = deps(uow.clone());
    let registered = auth::register(
        &deps,
        RegisterInput {
            email: "register@example.test".into(),
            password: "correct horse battery".into(),
            display_name: "Owner".into(),
            workspace_name: "New workspace".into(),
        },
    )
    .await
    .unwrap();
    let ws = registered.me.current_workspace.unwrap();
    let mut t = uow.tenant(ws).await.unwrap();
    let rows = t.lost_reasons().list().await.unwrap();
    assert_eq!(rows.len(), 6);
    assert!(rows.iter().all(|r| r.active && r.seeded));
    for (key, label) in LOST_REASON_DEFAULTS {
        assert!(rows.iter().any(|r| r.key == *key && r.label == *label));
    }
    for role in [SystemRole::Owner, SystemRole::Manager, SystemRole::Rep] {
        let stored = t.roles().find_by_key(role.key()).await.unwrap().unwrap();
        assert_eq!(stored.permissions, role.permissions());
        assert!(stored.permissions.contains(&Permission::InboxWork));
        assert_eq!(
            stored.permissions.contains(&Permission::InboxManage),
            role != SystemRole::Rep
        );
    }
    let mut edited = rows[0].clone();
    edited.label = "Edited".into();
    edited.active = false;
    t.lost_reasons().set(edited.clone()).await.unwrap();
    t.lost_reasons().initialize().await.unwrap();
    assert!(t.lost_reasons().list().await.unwrap().contains(&edited));
    t.commit().await.unwrap();
}

/// User references have the same NOT_FOUND contract as tenancy repositories.
pub async fn missing_user_references_are_not_found(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow).await;
    let p = f.insert_person("Person").await;
    let q = f.insert_person("Other").await;
    let mut bad = f.journey(p.id);
    bad.owner = Some(UserId::new_v7());
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        f.insert_journey(t.as_mut(), &bad).await.unwrap_err().code,
        ErrorCode::NotFound
    );
    drop(t);
    let j = f.journey(p.id);
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    f.insert_journey(t.as_mut(), &j).await.unwrap();
    t.commit().await.unwrap();
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        t.tasks()
            .insert(Task {
                id: TaskId::new_v7(),
                workspace_id: f.ws,
                journey_id: j.id,
                title: "Call".into(),
                due_at: FIXED_NOW,
                assignee: Some(UserId::new_v7()),
                status: TaskStatus::Open
            })
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    drop(t);
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        t.merges()
            .insert(MergeRow {
                id: MergeId::new_v7(),
                workspace_id: f.ws,
                source_id: q.id,
                target_id: p.id,
                decision: MergeDecision::Auto {
                    keep: p.id,
                    merge: q.id
                },
                conflicts: vec![],
                status: "applied".into(),
                moved_snapshot: json!({}),
                at: FIXED_NOW,
                applied_by: Some(UserId::new_v7()),
                undone_at: None
            })
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
}

/// The inbound upsert's conflict target is the person/capability pair; a proposed id only
/// identifies a newly inserted row, never replaces the id of an existing conversation.
pub async fn conversation_upsert_uses_the_natural_key(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow).await;
    let p = f.insert_person("One").await;
    let q = f.insert_person("Two").await;
    let cap = f.capability().await;
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    let a = t
        .conversations()
        .upsert_on_inbound(f.conversation(p.id, cap))
        .await
        .unwrap();
    let b = t
        .conversations()
        .upsert_on_inbound(f.conversation(q.id, cap))
        .await
        .unwrap();
    let candidate = Conversation {
        created_at: FIXED_NOW,
        updated_at: FIXED_NOW,
        id: b.id,
        ..f.conversation(p.id, cap)
    };
    assert_eq!(
        t.conversations()
            .upsert_on_inbound(candidate)
            .await
            .unwrap()
            .id,
        a.id
    );
    t.commit().await.unwrap();
}

/// External-id lookup is tenant/account scoped; echo candidates preserve our outbound row.
pub async fn message_receipt_lookup_and_echo_binding(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow).await;
    let p = f.insert_person("Receipt").await;
    let cap = f.capability().await;
    let other_cap = f.capability().await;
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    let c = t
        .conversations()
        .upsert_on_inbound(f.conversation(p.id, cap))
        .await
        .unwrap();
    let other = t
        .conversations()
        .upsert_on_inbound(f.conversation(p.id, other_cap))
        .await
        .unwrap();
    let mut m = f.message(c.id);
    m.direction = Direction::Outbound;
    m.author = Author::Human(f.user);
    m.status = MsgStatus::Sent;
    t.messages().insert_if_new(m.clone()).await.unwrap();
    let mut different_account = m.clone();
    different_account.id = MessageId::new_v7();
    different_account.conversation_id = other.id;
    t.messages()
        .insert_if_new(different_account.clone())
        .await
        .unwrap();
    assert_eq!(
        t.messages()
            .find_by_external_id(cap, "provider-1")
            .await
            .unwrap(),
        Some(m.clone())
    );
    assert_eq!(
        t.messages()
            .find_by_external_id(other_cap, "provider-1")
            .await
            .unwrap(),
        Some(different_account)
    );
    assert!(
        t.messages()
            .find_by_external_id(cap, "missing")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        t.messages()
            .find_by_external_id(CapabilityId::new_v7(), "provider-1")
            .await
            .unwrap()
            .is_none()
    );

    let mut pending = m.clone();
    pending.id = MessageId::new_v7();
    pending.external_id = None;
    pending.status = MsgStatus::Queued;
    t.messages().insert_if_new(pending.clone()).await.unwrap();
    let mut row = OutboxRow {
        id: Uuid::now_v7(),
        workspace_id: f.ws,
        conversation_id: c.id,
        message_id: pending.id,
        capability_id: cap,
        intent: json!({}),
        expected_generation: 0,
        fence_snapshot: None,
        conversation_merged: false,
        state: "queued".into(),
        attempts: 0,
        last_error: None,
        created_at: FIXED_NOW,
        updated_at: FIXED_NOW,
    };
    t.outbox().insert(row.clone()).await.unwrap();
    assert!(
        t.messages()
            .echo_candidates(c.id, &m.body, FIXED_NOW)
            .await
            .unwrap()
            .is_empty()
    );
    for state in ["sending", "sent"] {
        row.state = state.into();
        row.fence_snapshot = None;
        t.outbox().update(row.clone()).await.unwrap();
        assert!(
            t.messages()
                .echo_candidates(c.id, &m.body, FIXED_NOW)
                .await
                .unwrap()
                .is_empty()
        );
        // A manual echo arrived while our reply was only queued; send started later.
        row.fence_snapshot = Some(
            json!({"send_at": (FIXED_NOW + Duration::seconds(1)).unix_timestamp_nanos().to_string()}),
        );
        t.outbox().update(row.clone()).await.unwrap();
        assert!(
            t.messages()
                .echo_candidates(c.id, &m.body, FIXED_NOW)
                .await
                .unwrap()
                .is_empty()
        );
        row.fence_snapshot = Some(json!({"send_at": FIXED_NOW.unix_timestamp_nanos().to_string()}));
        t.outbox().update(row.clone()).await.unwrap();
        assert_eq!(
            t.messages()
                .echo_candidates(c.id, &m.body, FIXED_NOW)
                .await
                .unwrap(),
            vec![pending.clone()]
        );
        assert!(
            t.messages()
                .echo_candidates(other.id, &m.body, FIXED_NOW)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            t.messages()
                .echo_candidates(c.id, "different text", FIXED_NOW)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            t.messages()
                .echo_candidates(c.id, &m.body, FIXED_NOW - Duration::seconds(1))
                .await
                .unwrap()
                .is_empty()
        );
    }
    assert!(
        t.messages()
            .echo_candidates(c.id, &m.body, FIXED_NOW + Duration::minutes(6))
            .await
            .unwrap()
            .is_empty()
    );
    for state in ["unknown", "failed", "refused"] {
        row.state = state.into();
        t.outbox().update(row.clone()).await.unwrap();
        assert!(
            t.messages()
                .echo_candidates(c.id, &m.body, FIXED_NOW)
                .await
                .unwrap()
                .is_empty()
        );
    }
    row.state = "sending".into();
    t.outbox().update(row.clone()).await.unwrap();
    let mut second = pending.clone();
    second.id = MessageId::new_v7();
    t.messages().insert_if_new(second.clone()).await.unwrap();
    let mut second_outbox = row.clone();
    second_outbox.id = Uuid::now_v7();
    second_outbox.message_id = second.id;
    t.outbox().insert(second_outbox.clone()).await.unwrap();
    assert_eq!(
        t.messages()
            .echo_candidates(c.id, &m.body, FIXED_NOW)
            .await
            .unwrap()
            .len(),
        2
    );
    second_outbox.state = "failed".into();
    t.outbox().update(second_outbox).await.unwrap();
    // Receipt may finalize after the echo arrived but before it is consumed.
    row.state = "sent".into();
    row.updated_at = FIXED_NOW + Duration::seconds(1);
    t.outbox().update(row).await.unwrap();
    assert_eq!(
        t.messages()
            .echo_candidates(c.id, &m.body, FIXED_NOW)
            .await
            .unwrap(),
        vec![pending.clone()]
    );
    // Echo binds the id; the later receipt repeats the same id and adds status/cost.
    t.messages()
        .set_status(pending.id, MsgStatus::Queued, Some("echo-id".into()), None)
        .await
        .unwrap();
    t.messages()
        .set_status(pending.id, MsgStatus::Sent, Some("echo-id".into()), Some(4))
        .await
        .unwrap();
    let sent = t
        .messages()
        .find_by_external_id(cap, "echo-id")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(sent.id, pending.id);
    assert_eq!(sent.author, pending.author);
    assert_eq!(sent.cost_minor, Some(4));
    assert!(
        t.messages()
            .echo_candidates(c.id, &m.body, FIXED_NOW)
            .await
            .unwrap()
            .is_empty()
    );
    t.commit().await.unwrap();
    let mut other = f.uow.tenant(f.other).await.unwrap();
    assert!(
        other
            .messages()
            .find_by_external_id(cap, "provider-1")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        other
            .messages()
            .echo_candidates(c.id, &m.body, FIXED_NOW)
            .await
            .unwrap()
            .is_empty()
    );
}

pub async fn call_events_are_scoped_bounded_ordered_and_uncapped(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let until = FIXED_NOW + Duration::seconds(1);
    let mut expected = Vec::new();
    for (ws, provider, kind, unique_id, at, count) in [
        (
            f.ws,
            Provider::Netgsm,
            EventKind::CallEvent,
            "target",
            FIXED_NOW,
            105,
        ),
        (
            f.ws,
            Provider::Netgsm,
            EventKind::CallEvent,
            "target",
            until,
            2,
        ),
        (
            f.ws,
            Provider::Netgsm,
            EventKind::CallEvent,
            "target",
            until + Duration::microseconds(1),
            1,
        ),
        (
            f.ws,
            Provider::Netgsm,
            EventKind::CallEvent,
            "unrelated",
            FIXED_NOW,
            1,
        ),
        (
            f.ws,
            Provider::Meta,
            EventKind::CallEvent,
            "target",
            FIXED_NOW,
            1,
        ),
        (
            f.ws,
            Provider::Netgsm,
            EventKind::Message,
            "target",
            FIXED_NOW,
            1,
        ),
        (
            f.other,
            Provider::Netgsm,
            EventKind::CallEvent,
            "target",
            FIXED_NOW,
            1,
        ),
    ] {
        let mut r = uow.tenant(ws).await.unwrap();
        for n in 0..count {
            let event = InboundEvent {
                id: InboundEventId::new_v7(),
                workspace_id: ws,
                capability_id: None,
                provider,
                kind: kind.clone(),
                external_id: Uuid::now_v7().to_string(),
                payload: json!({"unique_id": unique_id, "scenario":"answer"}),
                received_at: at,
                processed_at: (n % 2 == 0).then_some(until),
            };
            if count > 1 {
                expected.push(event.clone());
            }
            r.inbound_events().insert_if_new(event, None).await.unwrap();
        }
        r.commit().await.unwrap();
    }
    expected.sort_by_key(|e| (e.received_at, e.id));
    let mut r = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        r.inbound_events()
            .call_events("target", until)
            .await
            .unwrap(),
        expected
    );
    // The derived lookup key must not interfere with append-only processing metadata updates.
    let pending = expected
        .iter_mut()
        .find(|e| e.processed_at.is_none())
        .unwrap();
    assert!(
        r.inbound_events()
            .mark_processed(pending.id, until)
            .await
            .unwrap()
    );
    pending.processed_at = Some(until);
    assert_eq!(
        r.inbound_events()
            .call_events("target", until)
            .await
            .unwrap(),
        expected
    );
    assert!(
        r.inbound_events()
            .call_events("missing", until)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        r.inbound_events()
            .call_events("target", FIXED_NOW - Duration::microseconds(1))
            .await
            .unwrap()
            .is_empty()
    );
}

pub async fn mail_subject_is_the_newest_received_mail_of_the_capability(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let (mailbox, other) = (f.capability().await, f.capability().await);
    let later = FIXED_NOW + Duration::seconds(1);
    let mut r = uow.tenant(f.ws).await.unwrap();
    for (n, (capability, kind, message_id, subject, at)) in [
        (
            mailbox,
            EventKind::Message,
            "<a@example.com>",
            json!("Old"),
            FIXED_NOW,
        ),
        (
            mailbox,
            EventKind::Message,
            "<a@example.com>",
            json!("Help"),
            later,
        ),
        (
            mailbox,
            EventKind::Status,
            "<b@example.com>",
            json!("Sent copy"),
            FIXED_NOW,
        ),
        (
            other,
            EventKind::Message,
            "<c@example.com>",
            json!("Elsewhere"),
            FIXED_NOW,
        ),
        (
            mailbox,
            EventKind::Message,
            "<d@example.com>",
            serde_json::Value::Null,
            FIXED_NOW,
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let event = InboundEvent {
            id: InboundEventId::new_v7(),
            workspace_id: f.ws,
            capability_id: Some(capability),
            provider: Provider::Mail,
            kind,
            external_id: format!("imap:account:INBOX:1:{n}"),
            payload: json!({"from":"ada@example.com", "message_id":message_id, "subject":subject}),
            received_at: at,
            processed_at: None,
        };
        r.inbound_events().insert_if_new(event, None).await.unwrap();
    }
    r.commit().await.unwrap();
    let mut r = uow.tenant(f.ws).await.unwrap();
    let events = r.inbound_events();
    assert_eq!(
        events
            .mail_subject(mailbox, "<a@example.com>")
            .await
            .unwrap()
            .as_deref(),
        Some("Help")
    );
    // A sent copy is not received mail, another capability's mail is not this one's, and a
    // mail without a subject or an unknown Message-ID has none.
    for id in [
        "<b@example.com>",
        "<c@example.com>",
        "<d@example.com>",
        "<z@example.com>",
    ] {
        assert_eq!(
            events.mail_subject(mailbox, id).await.unwrap(),
            None,
            "{id}"
        );
    }
    assert_eq!(
        events
            .mail_subject(other, "<c@example.com>")
            .await
            .unwrap()
            .as_deref(),
        Some("Elsewhere")
    );
    let mut o = uow.tenant(f.other).await.unwrap();
    assert_eq!(
        o.inbound_events()
            .mail_subject(mailbox, "<a@example.com>")
            .await
            .unwrap(),
        None
    );
}

// ---------------------------------------------------------------------------------------------
// Public items, subjects and cursors (migration 0019)
// ---------------------------------------------------------------------------------------------

impl Fixture {
    /// A capability of `kind_key` on the made-up provider account `external_id`.
    pub async fn account(&self, kind_key: &str, external_id: &str) -> CapabilityId {
        let c = Capability::new(
            CapabilityId::new_v7(),
            self.ws,
            NewCapability {
                kind_key: kind_key.into(),
                name: kind_key.into(),
                external_id: Some(external_id.into()),
                ..NewCapability::default()
            },
            FIXED_NOW,
        )
        .unwrap();
        let mut t = self.uow.tenant(self.ws).await.unwrap();
        t.capabilities().insert(c.clone(), None).await.unwrap();
        t.commit().await.unwrap();
        c.id
    }
    /// `p`'s conversation on the public surface `cap`, of that capability's kind, stored.
    pub async fn public_conversation(&self, p: PersonId, cap: CapabilityId) -> Conversation {
        let mut t = self.uow.tenant(self.ws).await.unwrap();
        let mut c = self.conversation(p, cap);
        c.kind_key = t
            .capabilities()
            .find(cap)
            .await
            .unwrap()
            .expect("the capability is stored")
            .kind_key;
        let c = t.conversations().upsert_on_inbound(c).await.unwrap();
        t.commit().await.unwrap();
        c
    }
    /// An inbound comment message of `c`, `minutes` after [`FIXED_NOW`], stored.
    pub async fn comment_message(
        &self,
        c: ConversationId,
        external_id: &str,
        minutes: i64,
    ) -> MessageId {
        let mut m = self.message(c);
        m.external_id = Some(format!("comment:{external_id}"));
        m.at = FIXED_NOW + Duration::minutes(minutes);
        let mut t = self.uow.tenant(self.ws).await.unwrap();
        t.messages().insert_if_new(m.clone()).await.unwrap();
        t.commit().await.unwrap();
        m.id
    }
    /// An owed, top-level comment `external_id` of `c` with its message, written `minutes` after
    /// [`FIXED_NOW`] (not stored).
    pub fn public_item(
        &self,
        c: &Conversation,
        message_id: MessageId,
        external_id: &str,
        minutes: i64,
    ) -> PublicItem {
        let at = FIXED_NOW + Duration::minutes(minutes);
        PublicItem {
            id: PublicItemId::new_v7(),
            workspace_id: self.ws,
            capability_id: c.capability_id,
            conversation_id: c.id,
            message_id,
            subject_id: None,
            kind: PublicKind::Comment,
            external_id: external_id.into(),
            parent_external_id: None,
            root_external_id: external_id.into(),
            created_at: at,
            deadline: None,
            private_reply_until: Some(at + Duration::days(7)),
            answer: AnswerState::Awaiting,
            moderation: Moderation::Visible,
            private_reply_message_id: None,
            live: false,
            agent_answers: 0,
            checked_at: None,
            updated_at: at,
        }
    }
    /// An outbound message of `c` and its outbox row in `state`, a public-item intent of
    /// `visibility` drafted by `drafted_by`, created `minutes` after [`FIXED_NOW`] (stored).
    pub async fn public_outbox(
        &self,
        c: &Conversation,
        state: &str,
        visibility: &str,
        drafted_by: &serde_json::Value,
        minutes: i64,
    ) -> Uuid {
        let at = FIXED_NOW + Duration::minutes(minutes);
        let mut m = self.message(c.id);
        m.direction = Direction::Outbound;
        m.author = Author::Agent;
        m.external_id = None;
        m.status = MsgStatus::Queued;
        m.at = at;
        let id = Uuid::now_v7();
        let mut t = self.uow.tenant(self.ws).await.unwrap();
        t.messages().insert_if_new(m.clone()).await.unwrap();
        t.outbox()
            .insert(OutboxRow {
                id,
                workspace_id: self.ws,
                conversation_id: c.id,
                message_id: m.id,
                capability_id: c.capability_id,
                intent: json!({"kind": "reply", "public": {
                    "item_id": PublicItemId::new_v7(), "visibility": visibility,
                    "drafted_by": drafted_by
                }}),
                expected_generation: c.executor_generation,
                fence_snapshot: None,
                conversation_merged: false,
                state: state.into(),
                attempts: 0,
                last_error: None,
                created_at: at,
                updated_at: at,
            })
            .await
            .unwrap();
        t.commit().await.unwrap();
        id
    }
}

/// Insert, replay, references (the item's conversation and subject on its own capability),
/// bounds, reads in order, updates, deadlines and the item a message is.
pub async fn public_items_contract(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let cap = f.account("instagram", "ig-1").await;
    let other_cap = f.account("instagram", "ig-2").await;
    let p = f.insert_person("Commenter").await;
    let c = f.public_conversation(p.id, cap).await;
    assert_eq!(c.kind_key, "instagram");
    let elsewhere = f.public_conversation(p.id, other_cap).await;
    let m1 = f.comment_message(c.id, "c1", 0).await;
    let m2 = f.comment_message(c.id, "c2", 1).await;
    let m3 = f.comment_message(c.id, "c3", 2).await;
    let first = f.public_item(&c, m1, "c1", 0);
    let mut reply = f.public_item(&c, m2, "c2", 1);
    reply.parent_external_id = Some("c1".into());
    reply.root_external_id = "c1".into();
    let mut other_thread = f.public_item(&c, m3, "c3", 2);
    other_thread.live = true;
    let mut t = uow.tenant(f.ws).await.unwrap();
    let foreign_subject = t
        .public_subjects()
        .upsert(PublicSubject {
            id: PublicSubjectId::new_v7(),
            workspace_id: f.ws,
            capability_id: other_cap,
            kind: SubjectKind::Post,
            external_id: "m-elsewhere".into(),
            title: String::new(),
            url: None,
            image_url: None,
            facts: json!({}),
            publication_id: None,
            first_seen_at: FIXED_NOW,
            updated_at: FIXED_NOW,
        })
        .await
        .unwrap();
    t.commit().await.unwrap();

    let mut t = uow.tenant(f.ws).await.unwrap();
    assert!(t.public_items().insert(first.clone()).await.unwrap());
    // A replay of the same comment is refused quietly, whatever its id.
    let mut replay = first.clone();
    replay.id = PublicItemId::new_v7();
    assert!(!t.public_items().insert(replay.clone()).await.unwrap());
    assert!(t.public_items().insert(reply.clone()).await.unwrap());
    assert!(t.public_items().insert(other_thread.clone()).await.unwrap());
    t.commit().await.unwrap();

    // References are the workspace's own.
    for (broken, code) in [
        (
            PublicItem {
                message_id: MessageId::new_v7(),
                external_id: "x1".into(),
                ..first.clone()
            },
            ErrorCode::NotFound,
        ),
        (
            PublicItem {
                conversation_id: ConversationId::new_v7(),
                external_id: "x2".into(),
                ..first.clone()
            },
            ErrorCode::NotFound,
        ),
        (
            PublicItem {
                subject_id: Some(PublicSubjectId::new_v7()),
                external_id: "x3".into(),
                ..first.clone()
            },
            ErrorCode::NotFound,
        ),
        (
            PublicItem {
                private_reply_message_id: Some(MessageId::new_v7()),
                external_id: "x4".into(),
                ..first.clone()
            },
            ErrorCode::NotFound,
        ),
        (
            PublicItem {
                workspace_id: f.other,
                external_id: "x5".into(),
                ..first.clone()
            },
            ErrorCode::Internal,
        ),
        // The conversation, or the subject, of another capability.
        (
            PublicItem {
                conversation_id: elsewhere.id,
                external_id: "x6".into(),
                ..first.clone()
            },
            ErrorCode::Internal,
        ),
        (
            PublicItem {
                subject_id: Some(foreign_subject.id),
                external_id: "x7".into(),
                ..first.clone()
            },
            ErrorCode::Internal,
        ),
        // An external id is 1 to 512 characters.
        (
            PublicItem {
                external_id: String::new(),
                ..first.clone()
            },
            ErrorCode::Internal,
        ),
        (
            PublicItem {
                external_id: "x".repeat(513),
                ..first.clone()
            },
            ErrorCode::Internal,
        ),
    ] {
        let mut t = uow.tenant(f.ws).await.unwrap();
        let e = t.public_items().insert(broken.clone()).await.unwrap_err();
        assert_eq!(e.code, code, "{}", broken.external_id);
    }

    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        t.public_items().get(first.id).await.unwrap(),
        Some(first.clone())
    );
    assert_eq!(
        t.public_items().lock(reply.id).await.unwrap(),
        Some(reply.clone())
    );
    assert_eq!(t.public_items().get(replay.id).await.unwrap(), None);
    assert_eq!(
        t.public_items().find_by_external(cap, "c1").await.unwrap(),
        Some(first.clone())
    );
    assert_eq!(
        t.public_items()
            .find_by_external(cap, "nope")
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        t.public_items().for_conversation(c.id).await.unwrap(),
        vec![first.clone(), reply.clone(), other_thread.clone()]
    );
    assert_eq!(
        t.public_items().thread(cap, "c1", 10).await.unwrap(),
        vec![first.clone(), reply.clone()]
    );
    assert_eq!(
        t.public_items().thread(cap, "c1", 1).await.unwrap(),
        vec![first.clone()]
    );
    drop(t);
    // Another workspace sees none of it.
    let mut other = uow.tenant(f.other).await.unwrap();
    assert_eq!(other.public_items().get(first.id).await.unwrap(), None);
    assert!(
        other
            .public_items()
            .for_conversation(c.id)
            .await
            .unwrap()
            .is_empty()
    );
    drop(other);

    // An update writes the item's changing state; its identity and thread stay.
    let later = FIXED_NOW + Duration::minutes(10);
    let mut answered = first.clone();
    answered.answer = AnswerState::Answered {
        by: AnsweredBy::Us,
        message_id: Some(m3),
        at: later,
    };
    answered.moderation = Moderation::Hidden;
    answered.agent_answers = 1;
    answered.deadline = Some(later + Duration::hours(1));
    answered.updated_at = later;
    let mut t = uow.tenant(f.ws).await.unwrap();
    t.public_items().update(answered.clone()).await.unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        t.public_items().get(first.id).await.unwrap(),
        Some(answered.clone())
    );
    let e = t
        .public_items()
        .update(PublicItem {
            id: PublicItemId::new_v7(),
            ..answered.clone()
        })
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
    drop(t);
    let mut t = uow.tenant(f.ws).await.unwrap();
    let e = t
        .public_items()
        .update(PublicItem {
            subject_id: Some(foreign_subject.id),
            ..answered.clone()
        })
        .await
        .unwrap_err();
    assert_eq!(
        e.code,
        ErrorCode::Internal,
        "a subject of another capability"
    );
    drop(t);

    // Deadlines: owed and pending items before the bound, soonest first.
    let mut t = uow.tenant(f.ws).await.unwrap();
    let mut due_soon = reply.clone();
    due_soon.answer = AnswerState::Pending { message_id: m3 };
    due_soon.deadline = Some(FIXED_NOW + Duration::minutes(30));
    let mut due_later = other_thread.clone();
    due_later.deadline = Some(FIXED_NOW + Duration::minutes(50));
    for item in [&due_soon, &due_later] {
        t.public_items().update(item.clone()).await.unwrap();
    }
    t.commit().await.unwrap();
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        t.public_items()
            .due_before(FIXED_NOW + Duration::hours(3), 10)
            .await
            .unwrap(),
        vec![due_soon.clone(), due_later.clone()],
        "the answered item is not due"
    );
    assert_eq!(
        t.public_items()
            .due_before(FIXED_NOW + Duration::minutes(30), 10)
            .await
            .unwrap(),
        vec![],
        "strictly before the bound"
    );
    assert_eq!(
        t.public_items()
            .due_before(FIXED_NOW + Duration::hours(3), 1)
            .await
            .unwrap(),
        vec![due_soon.clone()]
    );

    // The item a message is.
    assert_eq!(
        t.public_items().item_for_message(m1).await.unwrap(),
        Some(answered.clone())
    );
    assert_eq!(
        t.public_items().item_for_message(m2).await.unwrap(),
        Some(due_soon.clone())
    );
    assert_eq!(
        t.public_items()
            .item_for_message(MessageId::new_v7())
            .await
            .unwrap(),
        None
    );
}

/// A subject is stored once per capability and external id; a refresh keeps its id and first
/// sighting.
pub async fn public_subjects_contract(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let cap = f.account("instagram", "ig-1").await;
    let first = PublicSubject {
        id: PublicSubjectId::new_v7(),
        workspace_id: f.ws,
        capability_id: cap,
        kind: SubjectKind::Post,
        external_id: "m1".into(),
        title: "Yeni sezon".into(),
        url: Some("https://example.com/p/1".into()),
        image_url: None,
        facts: json!({"media_product_type": "FEED"}),
        publication_id: None,
        first_seen_at: FIXED_NOW,
        updated_at: FIXED_NOW,
    };
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        t.public_subjects().upsert(first.clone()).await.unwrap(),
        first
    );
    t.commit().await.unwrap();
    let later = FIXED_NOW + Duration::days(1);
    let refresh = PublicSubject {
        id: PublicSubjectId::new_v7(),
        title: "Yeni sezon geldi".into(),
        image_url: Some("https://example.com/i/1.jpg".into()),
        facts: json!({"media_product_type": "REELS"}),
        first_seen_at: later,
        updated_at: later,
        ..first.clone()
    };
    let expected = PublicSubject {
        id: first.id,
        first_seen_at: FIXED_NOW,
        ..refresh.clone()
    };
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        t.public_subjects().upsert(refresh.clone()).await.unwrap(),
        expected
    );
    t.commit().await.unwrap();
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        t.public_subjects().get(first.id).await.unwrap(),
        Some(expected.clone())
    );
    assert_eq!(t.public_subjects().get(refresh.id).await.unwrap(), None);
    assert_eq!(
        t.public_subjects()
            .find_by_external(cap, "m1")
            .await
            .unwrap(),
        Some(expected.clone())
    );
    assert_eq!(
        t.public_subjects()
            .find_by_external(cap, "m2")
            .await
            .unwrap(),
        None
    );
    drop(t);

    // An item may name the stored subject.
    let p = f.insert_person("Commenter").await;
    let c = f.public_conversation(p.id, cap).await;
    let m = f.comment_message(c.id, "c1", 0).await;
    let mut item = f.public_item(&c, m, "c1", 0);
    item.subject_id = Some(first.id);
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert!(t.public_items().insert(item).await.unwrap());
    t.commit().await.unwrap();

    // References are the workspace's own.
    for (broken, code) in [
        (
            PublicSubject {
                capability_id: CapabilityId::new_v7(),
                external_id: "m3".into(),
                ..first.clone()
            },
            ErrorCode::NotFound,
        ),
        (
            PublicSubject {
                publication_id: Some(Uuid::now_v7()),
                external_id: "m4".into(),
                ..first.clone()
            },
            ErrorCode::NotFound,
        ),
        (
            PublicSubject {
                workspace_id: f.other,
                external_id: "m5".into(),
                ..first.clone()
            },
            ErrorCode::Internal,
        ),
        // 0019's bounds.
        (
            PublicSubject {
                title: "a".repeat(281),
                external_id: "m6".into(),
                ..first.clone()
            },
            ErrorCode::Internal,
        ),
        (
            PublicSubject {
                external_id: String::new(),
                ..first.clone()
            },
            ErrorCode::Internal,
        ),
        (
            PublicSubject {
                external_id: "m".repeat(513),
                ..first.clone()
            },
            ErrorCode::Internal,
        ),
        (
            PublicSubject {
                url: Some(format!("https://example.com/{}", "p".repeat(2_048))),
                external_id: "m7".into(),
                ..first.clone()
            },
            ErrorCode::Internal,
        ),
        (
            PublicSubject {
                image_url: Some(format!("https://example.com/{}", "i".repeat(4_096))),
                external_id: "m8".into(),
                ..first.clone()
            },
            ErrorCode::Internal,
        ),
        (
            PublicSubject {
                facts: json!(["not", "an", "object"]),
                external_id: "m9".into(),
                ..first.clone()
            },
            ErrorCode::Internal,
        ),
    ] {
        let mut t = uow.tenant(f.ws).await.unwrap();
        let e = t
            .public_subjects()
            .upsert(broken.clone())
            .await
            .unwrap_err();
        assert_eq!(e.code, code, "{}", broken.external_id);
    }
    let mut other = uow.tenant(f.other).await.unwrap();
    assert_eq!(other.public_subjects().get(first.id).await.unwrap(), None);
    assert_eq!(
        other
            .public_subjects()
            .find_by_external(cap, "m1")
            .await
            .unwrap(),
        None
    );
}

/// One cursor per capability, replaced on each store; an object only.
pub async fn public_cursors_contract(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let cap = f.account("trendyol", "seller-1").await;
    let other_cap = f.account("hepsiburada", "merchant-1").await;
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(t.public_cursors().get(cap).await.unwrap(), None);
    t.public_cursors()
        .store(cap, json!({"scanned_until_ms": 1}), FIXED_NOW)
        .await
        .unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(f.ws).await.unwrap();
    t.public_cursors()
        .store(
            cap,
            json!({"scanned_until_ms": 2}),
            FIXED_NOW + Duration::minutes(5),
        )
        .await
        .unwrap();
    t.commit().await.unwrap();
    let mut t = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        t.public_cursors().get(cap).await.unwrap(),
        Some(json!({"scanned_until_ms": 2}))
    );
    assert_eq!(t.public_cursors().get(other_cap).await.unwrap(), None);
    drop(t);
    let mut t = uow.tenant(f.ws).await.unwrap();
    let e = t
        .public_cursors()
        .store(cap, json!([1]), FIXED_NOW)
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Internal);
    drop(t);
    let mut t = uow.tenant(f.ws).await.unwrap();
    let e = t
        .public_cursors()
        .store(CapabilityId::new_v7(), json!({}), FIXED_NOW)
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
    drop(t);
    let mut other = uow.tenant(f.other).await.unwrap();
    assert_eq!(other.public_cursors().get(cap).await.unwrap(), None);
}

/// Reconciliation takes the least recently checked items first, so a sweep of N rotates through
/// every open item instead of pinning to the oldest N.
pub async fn reconcile_order_rotates(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let cap = f.account("instagram", "ig-1").await;
    let p = f.insert_person("Commenter").await;
    let c = f.public_conversation(p.id, cap).await;
    let mut items = Vec::new();
    for n in 0..5 {
        let external = format!("c{n}");
        let m = f.comment_message(c.id, &external, n).await;
        items.push(f.public_item(&c, m, &external, n));
    }
    // One settled item is never reconciled.
    let m = f.comment_message(c.id, "settled", 9).await;
    let mut settled = f.public_item(&c, m, "settled", 9);
    settled.answer = AnswerState::Handled {
        by: EventSource::Agent,
        reason: HandledReason::Spam,
        at: FIXED_NOW,
    };
    let mut t = uow.tenant(f.ws).await.unwrap();
    for item in items.iter().chain([&settled]) {
        assert!(t.public_items().insert(item.clone()).await.unwrap());
    }
    t.commit().await.unwrap();
    let mut by_id = items.clone();
    by_id.sort_by_key(|i| i.id);
    let ids = |rows: &[PublicItem]| rows.iter().map(|i| i.id).collect::<Vec<_>>();

    let mut seen = Vec::new();
    for round in 0..3 {
        let mut t = uow.tenant(f.ws).await.unwrap();
        let batch = t.public_items().to_reconcile(cap, 2).await.unwrap();
        assert_eq!(batch.len(), 2, "round {round}");
        assert!(batch.iter().all(|i| i.id != settled.id));
        let checked = ids(&batch);
        t.public_items()
            .mark_checked(&checked, FIXED_NOW + Duration::minutes(round))
            .await
            .unwrap();
        t.commit().await.unwrap();
        seen.push(checked);
    }
    // Never-checked items first, by id; then the least recently checked.
    assert_eq!(seen[0], ids(&by_id[0..2]));
    assert_eq!(seen[1], ids(&by_id[2..4]));
    assert_eq!(seen[2], vec![by_id[4].id, by_id[0].id]);
    // `checked_at` is set; the item's version (`updated_at`) is not.
    let mut t = uow.tenant(f.ws).await.unwrap();
    let first = t.public_items().get(by_id[0].id).await.unwrap().unwrap();
    assert_eq!(first.checked_at, Some(FIXED_NOW + Duration::minutes(2)));
    assert_eq!(first.updated_at, by_id[0].updated_at);
    // Another workspace's ids are ignored.
    let mut other = uow.tenant(f.other).await.unwrap();
    other
        .public_items()
        .mark_checked(&[by_id[1].id], FIXED_NOW + Duration::days(1))
        .await
        .unwrap();
    other.commit().await.unwrap();
    let again = t.public_items().get(by_id[1].id).await.unwrap().unwrap();
    assert_eq!(again.checked_at, Some(FIXED_NOW));
}

/// The agent's public replies on a capability since a time, as `daily_ops_cap` counts them: its
/// public-item outbox rows created since then, in any state but refused (held, queued and
/// uncertain ones included), never a human's, a private reply or another capability's.
pub async fn outbox_counts_agent_public_replies(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow.clone()).await;
    let cap = f.account("instagram", "ig-1").await;
    let other_cap = f.account("instagram", "ig-2").await;
    let p = f.insert_person("Commenter").await;
    let c = f.public_conversation(p.id, cap).await;
    let elsewhere = f.public_conversation(p.id, other_cap).await;
    let agent = json!({"kind": "agent", "connection_id": Uuid::now_v7(), "user_id": f.user});
    let human = json!({"kind": "human", "user_id": f.user});
    for (conversation, state, visibility, drafted_by, minutes) in [
        (&c, "queued", "public", &agent, 0),
        (&c, "held", "public", &agent, 1),
        (&c, "sending", "public", &agent, 2),
        (&c, "sent", "public", &agent, 3),
        (&c, "failed", "public", &agent, 4),
        (&c, "unknown", "public", &agent, 5),
        (&c, "refused", "public", &agent, 6),
        (&c, "sent", "private", &agent, 7),
        (&c, "sent", "public", &human, 8),
        (&elsewhere, "sent", "public", &agent, 9),
        (&c, "sent", "public", &agent, -10),
    ] {
        f.public_outbox(conversation, state, visibility, drafted_by, minutes)
            .await;
    }
    let mut t = uow.tenant(f.ws).await.unwrap();
    let count = |cap, minutes| {
        let since = FIXED_NOW + Duration::minutes(minutes);
        (cap, since)
    };
    for ((capability, since), expected) in [
        (count(cap, 0), 6),
        (count(cap, 3), 3),
        (count(cap, -60), 7),
        (count(cap, 60), 0),
        (count(other_cap, 0), 1),
    ] {
        assert_eq!(
            t.outbox()
                .agent_public_replies_since(capability, since)
                .await
                .unwrap(),
            expected,
            "since {since}"
        );
    }
    drop(t);
    let mut other = uow.tenant(f.other).await.unwrap();
    assert_eq!(
        other
            .outbox()
            .agent_public_replies_since(cap, FIXED_NOW - Duration::days(1))
            .await
            .unwrap(),
        0
    );
}

/// Erasing a person refuses their replies waiting for approval, as it refuses the queued ones.
pub async fn erasure_refuses_held_replies(uow: Arc<dyn UnitOfWork>) {
    use jt_app::usecases::inbox::erasure;
    let f = Fixture::new(uow.clone()).await;
    let cap = f.account("instagram", "ig-1").await;
    let p = f.insert_person("Commenter").await;
    let c = f.public_conversation(p.id, cap).await;
    let agent = json!({"kind": "agent", "connection_id": Uuid::now_v7(), "user_id": f.user});
    let held = f.public_outbox(&c, "held", "public", &agent, 0).await;
    let queued = f.public_outbox(&c, "queued", "public", &agent, 1).await;
    let sent = f.public_outbox(&c, "sent", "public", &agent, 2).await;
    let ctx = jt_app::ctx::Ctx {
        workspace_id: f.ws,
        actor: jt_ledger::Actor::Human { user_id: f.user },
        permissions: SystemRole::Owner.permissions(),
        role_key: Some("owner".into()),
        now: FIXED_NOW + Duration::hours(1),
        agent_connection_id: None,
    };
    erasure::erase(
        &deps(uow.clone()),
        &ctx,
        p.id,
        erasure::EraseInput { confirm: true },
    )
    .await
    .unwrap();
    let mut t = uow.tenant(f.ws).await.unwrap();
    for (id, state) in [(held, "refused"), (queued, "refused"), (sent, "sent")] {
        assert_eq!(t.outbox().get(id).await.unwrap().unwrap().state, state);
    }
}
