//! Lead distribution's repository contracts (`jt_app::ports::distribution`) and the person's
//! recipient kind, exercised by both adapters: the in-memory fake
//! (`tests/distribution_fakes.rs`) and PostgreSQL (`jt_pg/tests/distribution_repos.rs`). What
//! only PostgreSQL can show (the log's trigger, races) is PostgreSQL's own tests.

use std::sync::Arc;

use jt_app::error::ErrorCode;
use jt_app::ports::distribution::{AssignmentQuery, AssignmentRow, Ownerless, OwnerlessScope};
use jt_app::ports::{UnitOfWork, UserRow};
use jt_inbox::{
    AssignmentId, Cause, JourneyEventKind, JourneyId, Match, MemberPool, Method, RecipientKind,
    ReducePolicy, RepProfile, Rule, RuleId, SourceKind, reduce,
};
use jt_ledger::Actor;
use jt_tenancy::{Email, UserId};
use time::{Duration, OffsetDateTime};

use crate::fakes::FIXED_NOW;
use crate::inbox_contract::Fixture;

/// `FIXED_NOW` plus `m` minutes.
pub fn at(m: i64) -> OffsetDateTime {
    FIXED_NOW + Duration::minutes(m)
}

fn system() -> Actor {
    Actor::System {
        component: "lead_distribution".into(),
    }
}

/// A decision of `cause` about `journey`, live, assigned at `at(minute)`.
pub fn decision(
    journey: JourneyId,
    user: Option<UserId>,
    cause: Cause,
    minute: i64,
) -> AssignmentRow {
    AssignmentRow {
        id: AssignmentId::new_v7(),
        journey_id: journey,
        user_id: user,
        cause,
        rule_id: None,
        assigned_at: at(minute),
        sla_due_at: None,
        acted_at: None,
        superseded_at: None,
        by: system(),
    }
}

/// A user of the platform (not necessarily a member).
pub async fn user(uow: &Arc<dyn UnitOfWork>) -> UserId {
    let id = UserId::new_v7();
    let mut t = uow.user().await.unwrap();
    t.users()
        .insert(UserRow {
            id,
            email: Email::parse(&format!("{}@example.invalid", id.as_uuid())).unwrap(),
            password_hash: "plain:test".into(),
            display_name: "Rep".into(),
            created_at: FIXED_NOW,
        })
        .await
        .unwrap();
    t.commit().await.unwrap();
    id
}

/// An open journey of a new person, owned by `owner`.
pub async fn journey(f: &Fixture, owner: Option<UserId>) -> JourneyId {
    let p = f.insert_person("Ornek").await;
    let mut j = f.journey(p.id);
    j.owner = owner;
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    f.insert_journey(t.as_mut(), &j).await.unwrap();
    t.commit().await.unwrap();
    j.id
}

/// Closes the journey (lost).
async fn close(f: &Fixture, id: JourneyId) {
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    let current = t.journeys().lock(id).await.unwrap().unwrap();
    let lost = f.event(
        id,
        &format!("lost-{id}"),
        JourneyEventKind::Lost {
            reason_key: "fiyat".into(),
        },
    );
    let transition = reduce(&current, &lost, &ReducePolicy::default()).unwrap();
    t.journeys()
        .apply_transition(id, transition, lost)
        .await
        .unwrap();
    t.commit().await.unwrap();
}

async fn insert(f: &Fixture, row: &AssignmentRow) {
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    t.assignments().insert(row).await.unwrap();
    t.commit().await.unwrap();
}

/// Supersedes the journey's live decision and appends `row`, in one bundle.
async fn replace(f: &Fixture, row: &AssignmentRow) {
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    t.assignments()
        .supersede(row.journey_id, row.assigned_at)
        .await
        .unwrap();
    t.assignments().insert(row).await.unwrap();
    t.commit().await.unwrap();
}

pub async fn one_live_assignment_per_journey(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow).await;
    let j = journey(&f, None).await;
    let first = decision(j, Some(f.user), Cause::Default, 0);
    insert(&f, &first).await;

    let mut t = f.uow.tenant(f.ws).await.unwrap();
    let second = decision(j, Some(f.user), Cause::Manual, 1);
    let err = t.assignments().insert(&second).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    drop(t);

    let mut t = f.uow.tenant(f.ws).await.unwrap();
    assert_eq!(t.assignments().live(j).await.unwrap(), Some(first.clone()));
    // A decision about no journey of this workspace, and one breaking its cause's rule.
    let err = t
        .assignments()
        .insert(&decision(JourneyId::new_v7(), None, Cause::NoEligible, 1))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    drop(t);
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    t.assignments().supersede(j, at(1)).await.unwrap();
    let err = t
        .assignments()
        .insert(&decision(j, None, Cause::Rule, 1))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Internal);
    drop(t);
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    t.assignments().supersede(j, at(1)).await.unwrap();
    let mut due_without_member = decision(j, None, Cause::Manual, 1);
    due_without_member.sla_due_at = Some(at(30));
    let err = t
        .assignments()
        .insert(&due_without_member)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Internal);
    drop(t);

    // Another workspace sees none of it.
    let mut t = f.uow.tenant(f.other).await.unwrap();
    assert_eq!(t.assignments().live(j).await.unwrap(), None);
    assert!(
        t.assignments()
            .previous_assignees(j)
            .await
            .unwrap()
            .is_empty()
    );
}

pub async fn supersede_then_insert_in_one_bundle(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow).await;
    let rep = user(&f.uow).await;
    let j = journey(&f, None).await;
    let first = decision(j, Some(f.user), Cause::Default, 0);
    insert(&f, &first).await;
    let mut second = decision(j, Some(rep), Cause::SlaReassign, 5);
    second.rule_id = Some(RuleId::new_v7());
    second.sla_due_at = Some(at(35));
    replace(&f, &second).await;

    let mut t = f.uow.tenant(f.ws).await.unwrap();
    assert_eq!(t.assignments().live(j).await.unwrap(), Some(second.clone()));
    let mut users = vec![f.user, rep];
    users.sort();
    assert_eq!(t.assignments().previous_assignees(j).await.unwrap(), users);
    assert_eq!(t.assignments().reassignments(j).await.unwrap(), 1);
    assert!(
        !t.assignments()
            .supersede(JourneyId::new_v7(), at(6))
            .await
            .unwrap()
    );

    // The log, newest first, with the superseded decision's time.
    let page = t
        .assignments()
        .list(&AssignmentQuery {
            journey_id: Some(j),
            limit: 1,
            ..AssignmentQuery::default()
        })
        .await
        .unwrap();
    assert_eq!(page.items, [second.clone()]);
    let rest = t
        .assignments()
        .list(&AssignmentQuery {
            journey_id: Some(j),
            limit: 10,
            before: page.next,
            ..AssignmentQuery::default()
        })
        .await
        .unwrap();
    assert_eq!(rest.items.len(), 1);
    assert_eq!(rest.items[0].id, first.id);
    assert_eq!(rest.items[0].superseded_at, Some(at(5)));
    assert_eq!(rest.next, None);
    let by_user = t
        .assignments()
        .list(&AssignmentQuery {
            user_id: Some(rep),
            limit: 10,
            ..AssignmentQuery::default()
        })
        .await
        .unwrap();
    assert_eq!(by_user.items, [second]);

    // The default rule continues after the member the latest default decision named.
    assert_eq!(
        t.assignments().default_cursor().await.unwrap(),
        Some(f.user)
    );
}

pub async fn touch_marks_only_the_owner_once(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow).await;
    let rep = user(&f.uow).await;
    let j = journey(&f, None).await;
    let mut row = decision(j, Some(rep), Cause::Rule, 0);
    row.sla_due_at = Some(at(30));
    insert(&f, &row).await;

    let mut t = f.uow.tenant(f.ws).await.unwrap();
    assert!(!t.assignments().touch(j, f.user, at(1)).await.unwrap());
    assert!(t.assignments().touch(j, rep, at(2)).await.unwrap());
    assert!(!t.assignments().touch(j, rep, at(3)).await.unwrap());
    assert!(
        !t.assignments()
            .touch(JourneyId::new_v7(), rep, at(3))
            .await
            .unwrap()
    );
    t.commit().await.unwrap();

    let mut t = f.uow.tenant(f.ws).await.unwrap();
    let live = t.assignments().live(j).await.unwrap().unwrap();
    assert_eq!(live.acted_at, Some(at(2)));
    // An acted assignment is never due.
    assert!(
        t.assignments()
            .due_sla(at(60), 2, 10)
            .await
            .unwrap()
            .is_empty()
    );
}

pub async fn due_sla_lists_unacted_past_due(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow).await;
    let rep = user(&f.uow).await;
    let mut journeys = Vec::new();
    for due in [40, 20, 90] {
        let j = journey(&f, Some(rep)).await;
        let mut row = decision(j, Some(rep), Cause::Rule, 0);
        row.sla_due_at = Some(at(due));
        insert(&f, &row).await;
        journeys.push((j, row));
    }
    // A closed journey's assignment is never due.
    let closed = journey(&f, Some(rep)).await;
    let mut row = decision(closed, Some(rep), Cause::Rule, 0);
    row.sla_due_at = Some(at(10));
    insert(&f, &row).await;
    close(&f, closed).await;

    let mut t = f.uow.tenant(f.ws).await.unwrap();
    let due = t.assignments().due_sla(at(45), 2, 10).await.unwrap();
    let ids: Vec<JourneyId> = due.iter().map(|r| r.journey_id).collect();
    assert_eq!(ids, [journeys[1].0, journeys[0].0], "oldest due first");
    assert_eq!(
        t.assignments().due_sla(at(45), 2, 1).await.unwrap().len(),
        1
    );
    assert!(
        t.assignments()
            .due_sla(at(19), 2, 10)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(t.assignments().count_stalled(at(45), 2).await.unwrap(), 0);
    drop(t);

    // Two SLA reassignments later, the journey is stalled: no longer due, counted instead.
    let stalled = journeys[1].0;
    for minute in [21, 22] {
        let mut row = decision(stalled, Some(f.user), Cause::SlaReassign, minute);
        row.sla_due_at = Some(at(23));
        replace(&f, &row).await;
    }
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    let ids: Vec<JourneyId> = t
        .assignments()
        .due_sla(at(45), 2, 10)
        .await
        .unwrap()
        .iter()
        .map(|r| r.journey_id)
        .collect();
    assert_eq!(ids, [journeys[0].0]);
    assert_eq!(t.assignments().count_stalled(at(45), 2).await.unwrap(), 1);
    // A higher limit makes it due again.
    assert_eq!(
        t.assignments().due_sla(at(45), 3, 10).await.unwrap().len(),
        2
    );
    assert_eq!(t.assignments().count_stalled(at(45), 3).await.unwrap(), 0);
}

pub async fn ownerless_open_excludes_closed_and_owned(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow).await;
    let rep = user(&f.uow).await;
    let owned = journey(&f, Some(rep)).await;
    let undecided = journey(&f, None).await;
    let nobody = journey(&f, None).await;
    insert(&f, &decision(nobody, None, Cause::NoEligible, 0)).await;
    let departed = journey(&f, None).await;
    insert(&f, &decision(departed, None, Cause::MemberLeft, 0)).await;
    let imported = journey(&f, None).await;
    insert(&f, &decision(imported, None, Cause::Import, 0)).await;
    let closed = journey(&f, None).await;
    close(&f, closed).await;

    let mut t = f.uow.tenant(f.ws).await.unwrap();
    let undecided_now = t
        .assignments()
        .ownerless_open(OwnerlessScope::Undecided, 10)
        .await
        .unwrap();
    assert_eq!(undecided_now, [undecided, departed]);
    let all = t
        .assignments()
        .ownerless_open(OwnerlessScope::All, 10)
        .await
        .unwrap();
    assert_eq!(all, [undecided, nobody, departed, imported]);
    assert_eq!(
        t.assignments()
            .ownerless_open(OwnerlessScope::All, 2)
            .await
            .unwrap(),
        [undecided, nobody]
    );
    assert_eq!(
        t.assignments().count_ownerless().await.unwrap(),
        Ownerless {
            count: 4,
            oldest_journey_id: Some(undecided),
        }
    );
    // Only the owned journey counts towards its owner's load.
    assert_eq!(t.assignments().open_owned().await.unwrap(), [(rep, 1)]);
    assert!(!all.contains(&owned));
    drop(t);

    let mut t = f.uow.tenant(f.other).await.unwrap();
    assert_eq!(
        t.assignments().count_ownerless().await.unwrap(),
        Ownerless::default()
    );
}

pub async fn rules_replace_all_keeps_positions_unique(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow).await;
    let rep = user(&f.uow).await;
    let rule = |name: &str| Rule {
        id: RuleId::new_v7(),
        name: name.into(),
        enabled: true,
        when: Match {
            sources: vec![SourceKind::Prospect],
            cities: vec!["İstanbul".into()],
            min_score: Some(50),
            ..Match::default()
        },
        to: MemberPool::Members {
            user_ids: vec![rep, f.user],
        },
        method: Method::LeastLoaded,
        sla_minutes: Some(60),
        cursor: None,
    };
    let (a, b, c) = (rule("a"), rule("b"), rule("c"));
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    t.distribution_rules()
        .replace_all(&[a.clone(), b.clone()], at(0))
        .await
        .unwrap();
    t.commit().await.unwrap();

    // Replaced whole, in the new order; positions follow it.
    let mut b2 = b.clone();
    b2.enabled = false;
    b2.to = MemberPool::AllEligible;
    b2.method = Method::RoundRobin;
    b2.sla_minutes = None;
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    t.distribution_rules()
        .replace_all(&[c.clone(), b2.clone()], at(1))
        .await
        .unwrap();
    assert!(t.distribution_rules().set_cursor(c.id, rep).await.unwrap());
    assert!(!t.distribution_rules().set_cursor(a.id, rep).await.unwrap());
    t.commit().await.unwrap();

    let mut t = f.uow.tenant(f.ws).await.unwrap();
    let mut c_cursor = c.clone();
    c_cursor.cursor = Some(rep);
    assert_eq!(t.distribution_rules().list().await.unwrap(), [c_cursor, b2]);
    // A repeated id refuses the whole set.
    let err = t
        .distribution_rules()
        .replace_all(&[a.clone(), a.clone()], at(2))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    drop(t);

    let mut t = f.uow.tenant(f.other).await.unwrap();
    assert!(t.distribution_rules().list().await.unwrap().is_empty());
    t.distribution_rules()
        .replace_all(&[], at(3))
        .await
        .unwrap();
    t.commit().await.unwrap();
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    assert_eq!(t.distribution_rules().list().await.unwrap().len(), 2);
}

pub async fn rep_profile_default_when_absent(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow).await;
    let rep = user(&f.uow).await;
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        t.rep_profiles().get(rep).await.unwrap(),
        RepProfile::default_for(rep)
    );
    assert!(t.rep_profiles().list().await.unwrap().is_empty());
    let profile = RepProfile {
        user_id: rep,
        accepting: false,
        max_open: Some(25),
        languages: vec!["tr".into(), "en".into()],
        cities: vec!["İzmir".into()],
        sectors: vec!["kafe".into()],
        hours: Some(jt_capability::Hours {
            tz: "Europe/Istanbul".into(),
            from: 9,
            to: 18,
            days: vec![1, 2, 3, 4, 5],
        }),
        away_until: Some(at(600)),
        updated_at: at(0),
    };
    t.rep_profiles().set(&profile).await.unwrap();
    t.commit().await.unwrap();

    let mut t = f.uow.tenant(f.ws).await.unwrap();
    assert_eq!(t.rep_profiles().get(rep).await.unwrap(), profile);
    let mut back = profile.clone();
    back.accepting = true;
    back.hours = None;
    back.away_until = None;
    back.updated_at = at(5);
    t.rep_profiles().set(&back).await.unwrap();
    assert_eq!(t.rep_profiles().list().await.unwrap(), [back]);
    // A user who does not exist.
    let err = t
        .rep_profiles()
        .set(&RepProfile::default_for(UserId::new_v7()))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    drop(t);

    let mut t = f.uow.tenant(f.other).await.unwrap();
    assert_eq!(
        t.rep_profiles().get(rep).await.unwrap(),
        RepProfile::default_for(rep)
    );
}

pub async fn recipient_kind_round_trips(uow: Arc<dyn UnitOfWork>) {
    let f = Fixture::new(uow).await;
    let mut business = f.person("Ornek Kafe");
    business.recipient_kind = RecipientKind::Business;
    let plain = f.insert_person("Kisi").await;
    let mut t = f.uow.tenant(f.ws).await.unwrap();
    t.people().insert(business.clone()).await.unwrap();
    t.commit().await.unwrap();

    let mut t = f.uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        t.people()
            .get(business.id)
            .await
            .unwrap()
            .unwrap()
            .recipient_kind,
        RecipientKind::Business
    );
    assert_eq!(
        t.people()
            .get(plain.id)
            .await
            .unwrap()
            .unwrap()
            .recipient_kind,
        RecipientKind::Unknown
    );
    t.people()
        .set_recipient_kind(plain.id, RecipientKind::Individual, at(1))
        .await
        .unwrap();
    t.commit().await.unwrap();

    let mut t = f.uow.tenant(f.ws).await.unwrap();
    let read = t.people().get(plain.id).await.unwrap().unwrap();
    assert_eq!(read.recipient_kind, RecipientKind::Individual);
    assert!(read.updated_at > plain.updated_at);
    drop(t);
    let mut t = f.uow.tenant(f.other).await.unwrap();
    let err = t
        .people()
        .set_recipient_kind(plain.id, RecipientKind::Business, at(2))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
}
