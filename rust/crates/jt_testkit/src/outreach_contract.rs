//! Outreach's repository contracts (`jt_app::ports::outreach`), exercised by both adapters: the
//! in-memory fake (`tests/outreach_fakes.rs`) and PostgreSQL (`jt_pg/tests/outreach_repos.rs`).
//! What only PostgreSQL can show (`for update skip locked`, races) is PostgreSQL's own tests.
//! Every value is invented: `example.invalid` domains and made-up names.

use std::collections::BTreeMap;
use std::sync::Arc;

use jt_app::error::ErrorCode;
use jt_app::ports::UnitOfWork;
use jt_app::ports::outreach::{
    CampaignQuery, CampaignRow, EnrollmentQuery, EnrollmentRow, ReportQuery, SendRow,
    TemplateQuery, TemplateRow,
};
use jt_capability::{Capability, CapabilityId, Hours, NewCapability};
use jt_inbox::{
    Author, CommercialBasis, ConversationId, Direction, Message, MessageId, MsgStatus, PersonId,
};
use jt_ledger::Actor;
use jt_outreach::{
    Approval, Audience, CampaignId, CampaignStatus, Definition, EnrollmentId, EnrollmentStatus,
    Lang, PauseReason, Schedule, SendId, SendOutcome, SkipReason, Step, StopReason, Template,
    TemplateId, Throttle,
};
use jt_strategy::StrategyVersionId;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::fakes::FIXED_NOW;
use crate::inbox_contract::Fixture;
use crate::prospects_contract::approved_version;

/// `FIXED_NOW` plus `m` minutes.
pub fn at(m: i64) -> OffsetDateTime {
    FIXED_NOW + Duration::minutes(m)
}

/// A workspace with a mailbox, an approved strategy version and a conversation to hang
/// messages off.
pub struct World {
    pub f: Fixture,
    pub mailbox: CapabilityId,
    pub version: StrategyVersionId,
    pub conversation: ConversationId,
}

/// A capability of `kind` in `ws`.
pub async fn capability(
    uow: &Arc<dyn UnitOfWork>,
    ws: jt_tenancy::WorkspaceId,
    kind: &str,
) -> CapabilityId {
    let c = Capability::new(
        CapabilityId::new_v7(),
        ws,
        NewCapability {
            kind_key: kind.into(),
            name: "Satış".into(),
            ..NewCapability::default()
        },
        FIXED_NOW,
    )
    .unwrap();
    let mut t = uow.tenant(ws).await.unwrap();
    t.capabilities().insert(c.clone(), None).await.unwrap();
    t.commit().await.unwrap();
    c.id
}

pub async fn world(uow: Arc<dyn UnitOfWork>) -> World {
    let f = Fixture::new(uow.clone()).await;
    let mailbox = capability(&uow, f.ws, "mailbox").await;
    let version = approved_version(&uow, f.ws).await;
    let p = f.insert_person("Mesaj").await;
    let mut t = uow.tenant(f.ws).await.unwrap();
    let c = t
        .conversations()
        .upsert_on_inbound(f.conversation(p.id, mailbox))
        .await
        .unwrap();
    t.commit().await.unwrap();
    World {
        f,
        mailbox,
        version,
        conversation: c.id,
    }
}

fn author(w: &World) -> Actor {
    Actor::Human { user_id: w.f.user }
}

pub fn template(w: &World, minute: i64) -> TemplateRow {
    TemplateRow {
        template: Template {
            id: TemplateId::new_v7(),
            name: "Tanışma".into(),
            language: Lang::Tr,
            subject: "{{company}} için".into(),
            body: "Merhaba {{contact_name|ekibiniz}},\nhttps://ornek.example.invalid/a".into(),
            revision: 1,
            archived: false,
        },
        created_by: author(w),
        updated_at: at(minute),
    }
}

pub fn definition() -> Definition {
    Definition {
        sender_name: "Ayşe Deneme".into(),
        steps: vec![
            Step {
                template_id: TemplateId::new_v7(),
                delay_days: 0,
                same_thread: false,
                snapshot: None,
            },
            Step {
                template_id: TemplateId::new_v7(),
                delay_days: 3,
                same_thread: true,
                snapshot: None,
            },
        ],
        audience: Audience {
            explicit: vec![PersonId(Uuid::from_u128(9))],
            ..Audience::default()
        },
        schedule: Schedule {
            start_at: None,
            window: Hours {
                tz: "Europe/Istanbul".into(),
                from: 9,
                to: 18,
                days: vec![1, 2, 3, 4, 5],
            },
        },
        throttle: Throttle {
            per_hour: 20,
            per_day: 100,
        },
        click_tracking: false,
        evergreen: false,
        segment_key: None,
    }
}

/// A draft campaign of `w` created at `at(minute)`.
pub fn campaign(w: &World, minute: i64) -> CampaignRow {
    CampaignRow {
        id: CampaignId::new_v7(),
        name: "Ekim tanışma".into(),
        mailbox_id: w.mailbox,
        status: CampaignStatus::Draft,
        definition: definition(),
        revision: 1,
        approval: None,
        pause_reason: None,
        strategy_version_id: w.version,
        created_by: author(w),
        created_at: at(minute),
        updated_at: at(minute),
        launched_at: None,
        completed_at: None,
    }
}

/// A running campaign, stored.
pub async fn running(w: &World, minute: i64) -> CampaignRow {
    let mut c = campaign(w, minute);
    c.status = CampaignStatus::Running;
    c.launched_at = Some(at(minute));
    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    t.outreach_campaigns().insert(&c).await.unwrap();
    t.commit().await.unwrap();
    c
}

/// An active enrollment of `person` in `campaign`, due at `at(due)`.
pub fn enrollment(campaign: CampaignId, person: PersonId, due: i64) -> EnrollmentRow {
    EnrollmentRow {
        id: EnrollmentId::new_v7(),
        campaign_id: campaign,
        person_id: person,
        journey_id: None,
        prospect_id: None,
        status: EnrollmentStatus::Active,
        stop: None,
        skip: None,
        next_step: 1,
        next_send_at: Some(at(due)),
        personalization: BTreeMap::from([("opener".to_owned(), "Merhaba".to_owned())]),
        basis: Some(CommercialBasis::Consent),
        enrolled_at: at(0),
        stopped_at: None,
        last_sent_at: None,
    }
}

async fn enroll(w: &World, rows: &[EnrollmentRow]) -> jt_app::ports::outreach::InsertReport {
    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    let report = t.outreach_enrollments().insert_many(rows).await.unwrap();
    t.commit().await.unwrap();
    report
}

async fn person(w: &World) -> PersonId {
    w.f.insert_person("Örnek Kafe").await.id
}

async fn get_enrollment(w: &World, id: EnrollmentId) -> EnrollmentRow {
    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    t.outreach_enrollments().get(id).await.unwrap().unwrap()
}

/// An outbound message of the world's conversation.
async fn message(w: &World) -> MessageId {
    let m = Message {
        id: MessageId::new_v7(),
        workspace_id: w.f.ws,
        conversation_id: w.conversation,
        direction: Direction::Outbound,
        author: Author::System,
        body: "Merhaba".into(),
        external_id: None,
        status: MsgStatus::Queued,
        cost_minor: None,
        at: FIXED_NOW,
    };
    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    t.messages().insert_if_new(m.clone()).await.unwrap();
    t.commit().await.unwrap();
    m.id
}

/// A send of step `step` of `e`, created at `at(minute)`, stored.
async fn send(
    w: &World,
    e: &EnrollmentRow,
    mailbox: CapabilityId,
    step: u8,
    domain: &str,
    outcome: SendOutcome,
    minute: i64,
) -> SendRow {
    let row = SendRow {
        id: SendId::new_v7(),
        enrollment_id: e.id,
        campaign_id: e.campaign_id,
        mailbox_id: mailbox,
        step,
        outbox_id: Uuid::now_v7(),
        message_id: message(w).await,
        recipient_domain: domain.into(),
        outcome,
        created_at: at(minute),
        sent_at: None,
        replied_at: None,
        replied_threaded: None,
        first_clicked_at: None,
        clicks: 0,
        automated_clicks: 0,
        unsubscribed_at: None,
    };
    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    t.outreach_sends().insert(&row).await.unwrap();
    t.commit().await.unwrap();
    row
}

pub async fn templates_round_trip_and_are_revision_checked(uow: Arc<dyn UnitOfWork>) {
    let w = world(uow).await;
    let older = template(&w, 0);
    let mut newer = template(&w, 5);
    let mut archived = template(&w, 9);
    archived.template.archived = true;
    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    for row in [&older, &newer, &archived] {
        t.outreach_templates().insert(row).await.unwrap();
    }
    t.commit().await.unwrap();

    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    assert_eq!(
        t.outreach_templates().get(older.template.id).await.unwrap(),
        Some(older.clone())
    );
    assert_eq!(
        t.outreach_templates()
            .lock(newer.template.id)
            .await
            .unwrap(),
        Some(newer.clone())
    );
    // A revision-checked write: a stale one writes nothing.
    let mut edited = newer.clone();
    edited.template.body = "Yeni metin".into();
    edited.template.revision = 2;
    edited.updated_at = at(20);
    assert!(!t.outreach_templates().update(&edited, 2).await.unwrap());
    assert!(t.outreach_templates().update(&edited, 1).await.unwrap());
    assert!(!t.outreach_templates().update(&edited, 1).await.unwrap());
    t.commit().await.unwrap();
    newer = edited;

    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    assert_eq!(
        t.outreach_templates().get(newer.template.id).await.unwrap(),
        Some(newer.clone())
    );
    // Most recently edited first; archived ones only when asked; paged.
    let page = t
        .outreach_templates()
        .list(&TemplateQuery {
            include_archived: false,
            limit: 1,
            before: None,
        })
        .await
        .unwrap();
    assert_eq!(page.items, vec![newer.clone()]);
    let rest = t
        .outreach_templates()
        .list(&TemplateQuery {
            include_archived: false,
            limit: 10,
            before: page.next,
        })
        .await
        .unwrap();
    assert_eq!(rest.items, vec![older.clone()]);
    assert_eq!(rest.next, None);
    let all = t
        .outreach_templates()
        .list(&TemplateQuery {
            include_archived: true,
            limit: 10,
            before: None,
        })
        .await
        .unwrap();
    assert_eq!(all.items, vec![newer, archived, older.clone()]);
    drop(t);

    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    let err = t.outreach_templates().insert(&older).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
}

pub async fn campaigns_round_trip_and_are_revision_checked(uow: Arc<dyn UnitOfWork>) {
    let w = world(uow).await;
    let draft = campaign(&w, 0);
    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    t.outreach_campaigns().insert(&draft).await.unwrap();
    t.commit().await.unwrap();

    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    assert_eq!(
        t.outreach_campaigns().lock(draft.id).await.unwrap(),
        Some(draft.clone())
    );
    // A state change keeps the revision; a save moves it; a stale write writes nothing.
    let mut paused = draft.clone();
    paused.status = CampaignStatus::Paused;
    paused.pause_reason = Some(PauseReason::Manual);
    paused.launched_at = Some(at(1));
    paused.approval = Some(Approval {
        revision: 1,
        by: w.f.user,
        at: at(1),
    });
    paused.updated_at = at(1);
    assert!(t.outreach_campaigns().update(&paused, 1).await.unwrap());
    let mut saved = paused.clone();
    saved.revision = 2;
    saved.approval = None;
    saved.definition.click_tracking = true;
    saved.updated_at = at(2);
    assert!(!t.outreach_campaigns().update(&saved, 2).await.unwrap());
    assert!(t.outreach_campaigns().update(&saved, 1).await.unwrap());
    t.commit().await.unwrap();

    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    assert_eq!(
        t.outreach_campaigns().get(draft.id).await.unwrap(),
        Some(saved.clone())
    );
    drop(t);
    let launched_later = running(&w, 5).await;
    let mut launched_first = campaign(&w, 6);
    launched_first.status = CampaignStatus::Running;
    launched_first.launched_at = Some(at(-30));
    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    t.outreach_campaigns()
        .insert(&launched_first)
        .await
        .unwrap();
    t.commit().await.unwrap();
    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    let running_ids: Vec<CampaignId> = t
        .outreach_campaigns()
        .by_status(CampaignStatus::Running, 10)
        .await
        .unwrap()
        .iter()
        .map(|c| c.id)
        .collect();
    assert_eq!(running_ids, vec![launched_first.id, launched_later.id]);
    // Newest first, filtered by status, paged.
    let page = t
        .outreach_campaigns()
        .list(&CampaignQuery {
            status: None,
            limit: 2,
            before: None,
        })
        .await
        .unwrap();
    assert_eq!(
        page.items.iter().map(|c| c.id).collect::<Vec<_>>(),
        vec![launched_first.id, launched_later.id]
    );
    let rest = t
        .outreach_campaigns()
        .list(&CampaignQuery {
            status: None,
            limit: 2,
            before: page.next,
        })
        .await
        .unwrap();
    assert_eq!(rest.items, vec![saved.clone()]);
    let paused_only = t
        .outreach_campaigns()
        .list(&CampaignQuery {
            status: Some(CampaignStatus::Paused),
            limit: 10,
            before: None,
        })
        .await
        .unwrap();
    assert_eq!(paused_only.items, vec![saved]);
    drop(t);

    // A mailbox of no capability of the workspace; a row breaking its checks.
    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    let mut stray = campaign(&w, 7);
    stray.mailbox_id = CapabilityId::new_v7();
    let err = t.outreach_campaigns().insert(&stray).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    drop(t);
    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    let mut broken = campaign(&w, 8);
    broken.status = CampaignStatus::Paused;
    let err = t.outreach_campaigns().insert(&broken).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Internal, "paused without a reason");
}

pub async fn one_active_enrollment_per_person(uow: Arc<dyn UnitOfWork>) {
    let w = world(uow).await;
    let (a, b, c) = (
        running(&w, 0).await,
        running(&w, 1).await,
        running(&w, 2).await,
    );
    let p = person(&w).await;
    let first = enrollment(a.id, p, 0);
    let report = enroll(&w, std::slice::from_ref(&first)).await;
    assert_eq!(report.inserted, vec![first.id]);

    // Active elsewhere: written skipped, without a basis or a next send.
    let second = enrollment(b.id, p, 0);
    let report = enroll(&w, std::slice::from_ref(&second)).await;
    assert_eq!(report.active_elsewhere, vec![second.id]);
    assert!(report.inserted.is_empty());
    let stored = get_enrollment(&w, second.id).await;
    assert_eq!(stored.status, EnrollmentStatus::Skipped);
    assert_eq!(stored.skip, Some(SkipReason::ActiveElsewhere));
    assert_eq!(stored.basis, None);
    assert_eq!(stored.next_send_at, None);

    // One enrollment per campaign and person.
    let again = enrollment(a.id, p, 5);
    let report = enroll(&w, &[again]).await;
    assert_eq!(report.already_enrolled, vec![p]);

    // Within one batch: the second active row of a person is active elsewhere too.
    let q = person(&w).await;
    let (x, y) = (enrollment(c.id, q, 0), enrollment(b.id, q, 0));
    let report = enroll(&w, &[x.clone(), y.clone()]).await;
    assert_eq!(report.inserted, vec![x.id]);
    assert_eq!(report.active_elsewhere, vec![y.id]);

    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    assert_eq!(
        t.outreach_enrollments().active_for(p).await.unwrap(),
        Some(first.clone())
    );
    assert_eq!(
        t.outreach_enrollments().count_active(a.id).await.unwrap(),
        1
    );
    assert_eq!(
        t.outreach_enrollments().count_active(b.id).await.unwrap(),
        0
    );
    // Personalization is replaced whole.
    let values = BTreeMap::from([("konu".to_owned(), "Kahve".to_owned())]);
    assert!(
        t.outreach_enrollments()
            .personalize(first.id, &values)
            .await
            .unwrap()
    );
    assert!(
        !t.outreach_enrollments()
            .personalize(EnrollmentId::new_v7(), &values)
            .await
            .unwrap()
    );
    t.commit().await.unwrap();
    assert_eq!(get_enrollment(&w, first.id).await.personalization, values);

    // Once stopped, the person may be active in another campaign.
    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    assert!(
        t.outreach_enrollments()
            .stop(first.id, &StopReason::Replied, at(10))
            .await
            .unwrap()
    );
    t.commit().await.unwrap();
    let d = running(&w, 3).await;
    let fresh = enrollment(d.id, p, 0);
    let report = enroll(&w, std::slice::from_ref(&fresh)).await;
    assert_eq!(report.inserted, vec![fresh.id]);

    // Lists by id, filtered by status.
    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    let page = t
        .outreach_enrollments()
        .list(
            b.id,
            &EnrollmentQuery {
                status: Some(EnrollmentStatus::Skipped),
                limit: 1,
                after: None,
            },
        )
        .await
        .unwrap();
    let mut skipped = [second.id, y.id];
    skipped.sort();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].id, skipped[0]);
    let rest = t
        .outreach_enrollments()
        .list(
            b.id,
            &EnrollmentQuery {
                status: Some(EnrollmentStatus::Skipped),
                limit: 10,
                after: page.next,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        rest.items.iter().map(|e| e.id).collect::<Vec<_>>(),
        vec![skipped[1]]
    );
}

pub async fn due_skips_locked_and_future(uow: Arc<dyn UnitOfWork>) {
    let w = world(uow).await;
    let (a, other) = (running(&w, 0).await, running(&w, 1).await);
    let mut rows = vec![];
    for due in [-5, -10, 30] {
        rows.push(enrollment(a.id, person(&w).await, due));
    }
    let elsewhere = enrollment(other.id, person(&w).await, -20);
    rows.push(elsewhere);
    enroll(&w, &rows).await;
    let stopped = enrollment(a.id, person(&w).await, -30);
    enroll(&w, std::slice::from_ref(&stopped)).await;
    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    t.outreach_enrollments()
        .stop(stopped.id, &StopReason::Manual, at(-1))
        .await
        .unwrap();
    t.commit().await.unwrap();

    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    let due: Vec<EnrollmentId> = t
        .outreach_enrollments()
        .due(a.id, at(0), 10)
        .await
        .unwrap()
        .iter()
        .map(|e| e.id)
        .collect();
    assert_eq!(due, vec![rows[1].id, rows[0].id], "oldest due first");
    let one = t.outreach_enrollments().due(a.id, at(0), 1).await.unwrap();
    assert_eq!(one.len(), 1);
    assert_eq!(one[0], rows[1]);
    let later: Vec<EnrollmentId> = t
        .outreach_enrollments()
        .due(a.id, at(30), 10)
        .await
        .unwrap()
        .iter()
        .map(|e| e.id)
        .collect();
    assert_eq!(later, vec![rows[1].id, rows[0].id, rows[2].id]);
}

pub async fn advance_completes_after_last(uow: Arc<dyn UnitOfWork>) {
    let w = world(uow).await;
    let a = running(&w, 0).await;
    let e = enrollment(a.id, person(&w).await, 0);
    enroll(&w, std::slice::from_ref(&e)).await;
    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    assert!(
        t.outreach_enrollments()
            .advance(e.id, 2, Some(at(60)), at(1))
            .await
            .unwrap()
    );
    assert!(
        t.outreach_enrollments()
            .postpone(e.id, at(80))
            .await
            .unwrap()
    );
    t.commit().await.unwrap();
    let after_one = get_enrollment(&w, e.id).await;
    assert_eq!(after_one.status, EnrollmentStatus::Active);
    assert_eq!(after_one.next_step, 2);
    assert_eq!(after_one.next_send_at, Some(at(80)));
    assert_eq!(after_one.last_sent_at, Some(at(1)));

    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    assert!(
        t.outreach_enrollments()
            .advance(e.id, 3, None, at(81))
            .await
            .unwrap()
    );
    t.commit().await.unwrap();
    let done = get_enrollment(&w, e.id).await;
    assert_eq!(done.status, EnrollmentStatus::Completed);
    assert_eq!(done.next_send_at, None);
    assert_eq!(done.next_step, 3);
    assert_eq!(done.last_sent_at, Some(at(81)));

    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    assert!(
        !t.outreach_enrollments()
            .advance(e.id, 3, Some(at(90)), at(90))
            .await
            .unwrap()
    );
    assert!(
        !t.outreach_enrollments()
            .postpone(e.id, at(90))
            .await
            .unwrap()
    );
    assert!(
        !t.outreach_enrollments()
            .stop(e.id, &StopReason::Manual, at(90))
            .await
            .unwrap()
    );
    t.commit().await.unwrap();
    assert_eq!(get_enrollment(&w, e.id).await, done);
}

pub async fn stop_all_for_stops_only_active(uow: Arc<dyn UnitOfWork>) {
    let w = world(uow).await;
    let (a, b) = (running(&w, 0).await, running(&w, 1).await);
    let p = person(&w).await;
    let done = enrollment(a.id, p, 0);
    enroll(&w, std::slice::from_ref(&done)).await;
    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    t.outreach_enrollments()
        .advance(done.id, 2, None, at(1))
        .await
        .unwrap();
    t.commit().await.unwrap();
    let live = enrollment(b.id, p, 0);
    let other = enrollment(a.id, person(&w).await, 0);
    enroll(&w, &[live.clone(), other.clone()]).await;

    let reason = StopReason::Refused("IZIN_YOK".into());
    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    assert_eq!(
        t.outreach_enrollments()
            .stop_all_for(p, &reason, at(5))
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        t.outreach_enrollments()
            .stop_all_for(p, &reason, at(6))
            .await
            .unwrap(),
        0
    );
    t.commit().await.unwrap();
    let stopped = get_enrollment(&w, live.id).await;
    assert_eq!(stopped.status, EnrollmentStatus::Stopped);
    assert_eq!(stopped.stop, Some(reason));
    assert_eq!(stopped.stopped_at, Some(at(5)));
    assert_eq!(stopped.next_send_at, None);
    assert_eq!(
        get_enrollment(&w, done.id).await.status,
        EnrollmentStatus::Completed
    );
    assert_eq!(
        get_enrollment(&w, other.id).await.status,
        EnrollmentStatus::Active
    );

    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    assert_eq!(
        t.outreach_enrollments()
            .stop_campaign(a.id, &StopReason::CampaignCanceled, at(7))
            .await
            .unwrap(),
        1
    );
    t.commit().await.unwrap();
    assert_eq!(
        get_enrollment(&w, other.id).await.stop,
        Some(StopReason::CampaignCanceled)
    );
}

pub async fn send_outcome_written_once_per_transition(uow: Arc<dyn UnitOfWork>) {
    let w = world(uow).await;
    let a = running(&w, 0).await;
    let e = enrollment(a.id, person(&w).await, 0);
    enroll(&w, std::slice::from_ref(&e)).await;
    let s = send(
        &w,
        &e,
        w.mailbox,
        1,
        "ornek.example.invalid",
        SendOutcome::Queued,
        0,
    )
    .await;
    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    assert_eq!(
        t.outreach_sends().by_outbox(s.outbox_id).await.unwrap(),
        Some(s.clone())
    );
    let sends = t.outreach_sends();
    assert!(
        sends
            .set_outcome(s.id, SendOutcome::Sent, at(1))
            .await
            .unwrap()
    );
    assert!(
        !sends
            .set_outcome(s.id, SendOutcome::Sent, at(2))
            .await
            .unwrap()
    );
    assert!(
        !sends
            .set_outcome(s.id, SendOutcome::Failed, at(2))
            .await
            .unwrap()
    );
    assert!(
        sends
            .set_outcome(s.id, SendOutcome::Bounced, at(3))
            .await
            .unwrap()
    );
    assert!(
        !sends
            .set_outcome(s.id, SendOutcome::Complained, at(4))
            .await
            .unwrap()
    );
    assert!(sends.mark_replied(s.id, true, at(5)).await.unwrap());
    assert!(!sends.mark_replied(s.id, false, at(6)).await.unwrap());
    assert!(sends.unsubscribed(s.id, at(7)).await.unwrap());
    assert!(!sends.unsubscribed(s.id, at(8)).await.unwrap());
    sends.click(s.id, true, at(8)).await.unwrap();
    sends.click(s.id, false, at(9)).await.unwrap();
    sends.click(s.id, false, at(10)).await.unwrap();
    t.commit().await.unwrap();

    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    let stored = t.outreach_sends().get(s.id).await.unwrap().unwrap();
    assert_eq!(stored.outcome, SendOutcome::Bounced);
    assert_eq!(stored.sent_at, Some(at(1)), "the first send time stays");
    assert_eq!(stored.replied_at, Some(at(5)));
    assert_eq!(stored.replied_threaded, Some(true));
    assert_eq!(stored.unsubscribed_at, Some(at(7)));
    assert_eq!(
        (
            stored.clicks,
            stored.automated_clicks,
            stored.first_clicked_at
        ),
        (2, 1, Some(at(9)))
    );
    // A click on no send; a second send for one outbox entry.
    let err = t
        .outreach_sends()
        .click(SendId::new_v7(), false, at(11))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    drop(t);
    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    let mut twin = s.clone();
    twin.id = SendId::new_v7();
    let err = t.outreach_sends().insert(&twin).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    drop(t);
    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    let mut orphan = s;
    orphan.id = SendId::new_v7();
    orphan.outbox_id = Uuid::now_v7();
    orphan.enrollment_id = EnrollmentId::new_v7();
    let err = t.outreach_sends().insert(&orphan).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
}

pub async fn counts_by_window(uow: Arc<dyn UnitOfWork>) {
    let w = world(uow).await;
    let (a, b) = (running(&w, 0).await, running(&w, 1).await);
    let p = person(&w).await;
    let e = enrollment(a.id, p, 0);
    let other = enrollment(b.id, person(&w).await, 0);
    enroll(&w, &[e.clone(), other.clone()]).await;
    let domain = "ornek.example.invalid";
    send(&w, &e, w.mailbox, 1, domain, SendOutcome::Sent, -120).await;
    send(&w, &e, w.mailbox, 2, domain, SendOutcome::Bounced, -30).await;
    let newest = send(&w, &e, w.mailbox, 3, domain, SendOutcome::Queued, -5).await;
    send(&w, &e, w.mailbox, 4, domain, SendOutcome::Refused, -1).await;
    send(&w, &other, w.mailbox, 1, domain, SendOutcome::Sent, -2).await;

    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    let s = t.outreach_sends();
    assert_eq!(s.count_campaign_since(a.id, at(-60)).await.unwrap(), 2);
    assert_eq!(
        s.count_campaign_since(a.id, at(-5)).await.unwrap(),
        1,
        "since is inclusive"
    );
    assert_eq!(
        s.count_campaign_since(a.id, at(-200)).await.unwrap(),
        3,
        "refused sends never count"
    );
    assert_eq!(s.count_mailbox_since(w.mailbox, at(-200)).await.unwrap(), 4);
    assert_eq!(
        s.person_send_times(p, at(-60)).await.unwrap(),
        vec![at(-30), at(-5)]
    );
    assert_eq!(
        s.latest_for_person(p, at(-200))
            .await
            .unwrap()
            .map(|r| r.id),
        Some(newest.id)
    );
    assert_eq!(s.latest_for_person(p, at(0)).await.unwrap(), None);
    assert_eq!(
        s.recent_outcomes(a.id, 3).await.unwrap(),
        vec![
            SendOutcome::Refused,
            SendOutcome::Queued,
            SendOutcome::Bounced
        ]
    );
    assert_eq!(s.recent_outcomes(a.id, 10).await.unwrap().len(), 4);
}

pub async fn domain_counts_by_mailbox(uow: Arc<dyn UnitOfWork>) {
    let w = world(uow).await;
    let second = capability(&w.f.uow, w.f.ws, "mailbox").await;
    let a = running(&w, 0).await;
    let e = enrollment(a.id, person(&w).await, 0);
    enroll(&w, std::slice::from_ref(&e)).await;
    let (ours, theirs) = ("ornek.example.invalid", "deneme.example.invalid");
    send(&w, &e, w.mailbox, 1, ours, SendOutcome::Sent, -50).await;
    send(&w, &e, w.mailbox, 2, ours, SendOutcome::Unknown, -10).await;
    send(&w, &e, w.mailbox, 3, theirs, SendOutcome::Sent, -10).await;
    send(&w, &e, second, 4, ours, SendOutcome::Sent, -10).await;
    send(&w, &e, w.mailbox, 5, ours, SendOutcome::Refused, -10).await;

    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    let s = t.outreach_sends();
    assert_eq!(
        s.count_domain_since(w.mailbox, ours, at(-60))
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        s.count_domain_since(w.mailbox, ours, at(-20))
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        s.count_domain_since(second, ours, at(-60)).await.unwrap(),
        1
    );
    assert_eq!(
        s.count_domain_since(w.mailbox, theirs, at(-60))
            .await
            .unwrap(),
        1
    );
    assert_eq!(s.count_mailbox_since(second, at(-60)).await.unwrap(), 1);
}

pub async fn report_groups_by_step(uow: Arc<dyn UnitOfWork>) {
    let w = world(uow).await;
    let (a, b) = (running(&w, 0).await, running(&w, 1).await);
    let e = enrollment(a.id, person(&w).await, 0);
    let f = enrollment(a.id, person(&w).await, 0);
    let g = enrollment(b.id, person(&w).await, 0);
    enroll(&w, &[e.clone(), f.clone(), g.clone()]).await;
    let domain = "ornek.example.invalid";
    let e1 = send(&w, &e, w.mailbox, 1, domain, SendOutcome::Sent, 0).await;
    let f1 = send(&w, &f, w.mailbox, 1, domain, SendOutcome::Bounced, 5).await;
    send(&w, &e, w.mailbox, 2, domain, SendOutcome::Refused, 10).await;
    send(&w, &g, w.mailbox, 1, domain, SendOutcome::Sent, 10).await;
    // Outside [at(0), at(20)): the end is open.
    send(&w, &f, w.mailbox, 2, domain, SendOutcome::Sent, 20).await;
    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    t.outreach_sends()
        .mark_replied(e1.id, true, at(3))
        .await
        .unwrap();
    t.outreach_sends().click(e1.id, false, at(2)).await.unwrap();
    t.outreach_sends().click(e1.id, true, at(2)).await.unwrap();
    t.outreach_sends().unsubscribed(f1.id, at(6)).await.unwrap();
    t.commit().await.unwrap();

    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    let rows = t
        .outreach_sends()
        .report(&ReportQuery {
            campaign_id: Some(a.id),
            from: at(0),
            to: at(20),
        })
        .await
        .unwrap();
    assert_eq!(rows.len(), 2, "{rows:?}");
    let (s1, s2) = (rows[0], rows[1]);
    assert_eq!((s1.campaign_id, s1.step, s2.step), (a.id, 1, 2));
    assert_eq!(
        (
            s1.sends,
            s1.sent,
            s1.bounced,
            s1.replied,
            s1.replied_threaded
        ),
        (2, 1, 1, 1, 1)
    );
    assert_eq!(
        (s1.unsubscribed, s1.clicked, s1.clicks, s1.automated_clicks),
        (1, 1, 1, 1)
    );
    assert_eq!((s2.sends, s2.refused, s2.sent), (1, 1, 0));
    let all = t
        .outreach_sends()
        .report(&ReportQuery {
            campaign_id: None,
            from: at(0),
            to: at(21),
        })
        .await
        .unwrap();
    let total: u32 = all.iter().map(|r| r.sends).sum();
    assert_eq!(total, 5);
    let mut campaigns: Vec<CampaignId> = all.iter().map(|r| r.campaign_id).collect();
    campaigns.dedup();
    let mut expected = vec![a.id, b.id];
    expected.sort();
    assert_eq!(campaigns, expected, "by campaign id, then step");
}

pub async fn rows_are_workspace_scoped(uow: Arc<dyn UnitOfWork>) {
    let w = world(uow).await;
    let tpl = template(&w, 0);
    let mut t = w.f.uow.tenant(w.f.ws).await.unwrap();
    t.outreach_templates().insert(&tpl).await.unwrap();
    t.commit().await.unwrap();
    let a = running(&w, 0).await;
    let p = person(&w).await;
    let e = enrollment(a.id, p, 0);
    enroll(&w, std::slice::from_ref(&e)).await;
    let s = send(
        &w,
        &e,
        w.mailbox,
        1,
        "ornek.example.invalid",
        SendOutcome::Sent,
        0,
    )
    .await;

    let mut o = w.f.uow.tenant(w.f.other).await.unwrap();
    assert_eq!(
        o.outreach_templates().get(tpl.template.id).await.unwrap(),
        None
    );
    assert!(
        o.outreach_templates()
            .list(&TemplateQuery {
                include_archived: true,
                limit: 10,
                before: None
            })
            .await
            .unwrap()
            .items
            .is_empty()
    );
    assert_eq!(o.outreach_campaigns().get(a.id).await.unwrap(), None);
    assert!(
        o.outreach_campaigns()
            .by_status(CampaignStatus::Running, 10)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(o.outreach_enrollments().get(e.id).await.unwrap(), None);
    assert_eq!(o.outreach_enrollments().active_for(p).await.unwrap(), None);
    assert!(
        o.outreach_enrollments()
            .due(a.id, at(60), 10)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        o.outreach_enrollments()
            .stop_all_for(p, &StopReason::Manual, at(1))
            .await
            .unwrap(),
        0
    );
    assert_eq!(o.outreach_sends().get(s.id).await.unwrap(), None);
    assert_eq!(
        o.outreach_sends().by_outbox(s.outbox_id).await.unwrap(),
        None
    );
    assert!(
        !o.outreach_sends()
            .set_outcome(s.id, SendOutcome::Bounced, at(1))
            .await
            .unwrap()
    );
    assert_eq!(
        o.outreach_sends()
            .count_mailbox_since(w.mailbox, at(-60))
            .await
            .unwrap(),
        0
    );
    assert!(
        o.outreach_sends()
            .person_send_times(p, at(-60))
            .await
            .unwrap()
            .is_empty()
    );
    o.commit().await.unwrap();
    // The other workspace's bundle wrote nothing.
    assert_eq!(
        get_enrollment(&w, e.id).await.status,
        EnrollmentStatus::Active
    );
}
