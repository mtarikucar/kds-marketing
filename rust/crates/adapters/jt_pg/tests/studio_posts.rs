//! Olay-driven publishing on PostgreSQL (migration `0022_studio_posts`): the repo answers as the
//! in-memory fake does, the checks and the trigger hold, row-level security isolates the three
//! tables, and the down refuses while a planned post or a package request is stored.
use jt_app::{
    error::ErrorCode,
    ports::{UnitOfWork, posts::*},
};
use jt_pg::{PgUnitOfWork, TenantTx};
use jt_studio::{Material, OlayId, RetirementReason, Slot, SlotId, Subject};
use jt_tenancy::WorkspaceId;
use jt_testkit::{
    TestDb,
    fakes::FIXED_NOW,
    studio_contract::{Fixture, ready, seed_material},
};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};

/// The three tables of `0022_studio_posts`.
const TABLES: [&str; 3] = [
    "studio_package_requests",
    "studio_posts",
    "studio_posting_policy",
];

/// An open olay request keyed `key`, created at `at`, listing `material`.
fn olay_request(
    ws: WorkspaceId,
    material: &Material,
    key: &str,
    at: OffsetDateTime,
) -> PackageRequest {
    PackageRequest {
        id: PackageRequestId::new_v7(),
        workspace_id: ws,
        key: key.into(),
        trigger: PackageTrigger::Olay,
        status: PackageStatus::Open,
        olay_id: material.olay_id(),
        occasion: None,
        year: None,
        capability_id: None,
        material_ids: vec![material.id],
        best_formats: vec![],
        hints: PackageHints::default(),
        created_at: at,
        answered_at: None,
        closed_at: None,
    }
}

/// A live feed post of `f`'s channel and hypothesis for `slot`, about `material`'s olay, answering
/// `request`, published at `publish_at`.
fn planned_post(
    f: &Fixture,
    slot: SlotId,
    material: &Material,
    request: PackageRequestId,
    publish_at: OffsetDateTime,
) -> PlannedPost {
    let olay_id = material.olay_id().expect("a bound material");
    PlannedPost {
        slot_id: slot,
        workspace_id: f.ws,
        format: PostFormat::FeedPost,
        capability_id: f.slot.capability_id,
        publish_at,
        prep_start_at: publish_at - Duration::hours(24),
        grace_until: publish_at + Duration::hours(6),
        olay_id: Some(olay_id),
        package_request_id: request,
        material_ids: vec![material.id],
        subject: Subject::Olay { olay_id },
        hypothesis_id: f.slot.chain.hypothesis_id,
        content_type: "text".into(),
        retired: None,
        created_at: FIXED_NOW,
    }
}

/// Stores another planned slot of `f`'s chain, scheduled at `at`.
async fn another_slot(uow: &dyn UnitOfWork, f: &Fixture, at: OffsetDateTime) -> SlotId {
    let slot = Slot {
        id: SlotId::new_v7(),
        scheduled_at: at,
        ..f.slot.clone()
    };
    let mut tx = uow.tenant(f.ws).await.unwrap();
    tx.studio()
        .insert_slots(&format!("posts/{}", slot.id.0), vec![slot.clone()])
        .await
        .unwrap();
    tx.commit().await.unwrap();
    slot.id
}

/// The columns a raw insert of a post sets beside its stored references.
struct RawPost {
    prep: Duration,
    grace: Duration,
    retired_reason: Option<&'static str>,
    retired_at: Option<OffsetDateTime>,
}

/// The name of the constraint a raw insert of a post for `slot` breaks, its prep start and grace
/// `raw.prep` and `raw.grace` from its publish time.
async fn refused_post(
    pool: &PgPool,
    f: &Fixture,
    slot: SlotId,
    request: PackageRequestId,
    raw: RawPost,
) -> String {
    let publish_at = FIXED_NOW + Duration::days(5);
    let mut tx = TenantTx::begin(pool, f.ws).await.unwrap();
    let err = sqlx::query(
        "insert into studio_posts(workspace_id,slot_id,data,format,capability_id,publish_at,\
         prep_start_at,grace_until,olay_id,package_request_id,retired_reason,retired_at,created_at) \
         values($1,$2,'{}','feed_post',$3,$4,$5,$6,null,$7,$8,$9,$4)",
    )
    .bind(f.ws.0)
    .bind(slot.0)
    .bind(f.slot.capability_id.0)
    .bind(publish_at)
    .bind(publish_at + raw.prep)
    .bind(publish_at + raw.grace)
    .bind(request.0)
    .bind(raw.retired_reason)
    .bind(raw.retired_at)
    .execute(tx.conn())
    .await
    .unwrap_err();
    tx.rollback().await.unwrap();
    let db = err.as_database_error().expect("a database error");
    assert_eq!(db.code().as_deref(), Some("23514"), "{err}");
    db.constraint().unwrap().to_owned()
}

#[tokio::test]
async fn a_post_round_trips_lists_by_publish_time_and_retires_once() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let f = ready(&uow).await;
    let material = seed_material(&uow, f.ws).await;
    let request = olay_request(f.ws, &material, "olay:round-trip:1", FIXED_NOW);
    let second = another_slot(&uow, &f, FIXED_NOW + Duration::days(2)).await;
    let later = planned_post(
        &f,
        f.slot.id,
        &material,
        request.id,
        FIXED_NOW + Duration::days(3),
    );
    let earlier = planned_post(
        &f,
        second,
        &material,
        request.id,
        FIXED_NOW + Duration::days(2),
    );
    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert!(
        tx.studio_posts()
            .insert_package_request(request.clone())
            .await
            .unwrap()
    );
    tx.studio_posts().insert_post(later.clone()).await.unwrap();
    tx.studio_posts()
        .insert_post(earlier.clone())
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        tx.studio_posts().get_post(f.slot.id).await.unwrap(),
        Some(later.clone())
    );
    assert_eq!(
        tx.studio_posts().get_post(SlotId::new_v7()).await.unwrap(),
        None
    );
    // By publish time, not by insertion.
    assert_eq!(
        tx.studio_posts().list_posts().await.unwrap(),
        [earlier.clone(), later.clone()]
    );
    let retirement = PostRetirement {
        reason: RetirementReason::MissedGrace,
        at: FIXED_NOW + Duration::days(4),
    };
    assert!(
        tx.studio_posts()
            .retire_post(f.slot.id, retirement)
            .await
            .unwrap()
    );
    // Once: a second retirement writes nothing.
    let again = PostRetirement {
        reason: RetirementReason::Cancelled,
        at: FIXED_NOW + Duration::days(5),
    };
    assert!(
        !tx.studio_posts()
            .retire_post(f.slot.id, again)
            .await
            .unwrap()
    );
    assert_eq!(
        tx.studio_posts()
            .retire_post(SlotId::new_v7(), again)
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    tx.commit().await.unwrap();

    let mut tx = uow.tenant(f.ws).await.unwrap();
    let mut retired = later.clone();
    retired.retired = Some(retirement);
    assert_eq!(
        tx.studio_posts().get_post(f.slot.id).await.unwrap(),
        Some(retired.clone())
    );
    assert_eq!(
        tx.studio_posts().list_posts().await.unwrap(),
        [earlier, retired]
    );
    drop(tx);
    // The columns follow the record.
    let mut raw = TenantTx::begin(&db.pool, f.ws).await.unwrap();
    let columns: (Option<String>, Option<OffsetDateTime>) = sqlx::query_as(
        "select retired_reason, retired_at from studio_posts where workspace_id=$1 and slot_id=$2",
    )
    .bind(f.ws.0)
    .bind(f.slot.id.0)
    .fetch_one(raw.conn())
    .await
    .unwrap();
    assert_eq!(
        columns,
        (Some(String::from("missed_grace")), Some(retirement.at))
    );
    raw.rollback().await.unwrap();
}

#[tokio::test]
async fn a_key_is_requested_once_and_only_an_open_request_changes() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let f = ready(&uow).await;
    let material = seed_material(&uow, f.ws).await;
    let request = olay_request(f.ws, &material, "olay:keyed:1", FIXED_NOW);
    let newer = olay_request(
        f.ws,
        &material,
        "olay:keyed:2",
        FIXED_NOW + Duration::hours(1),
    );
    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert!(
        tx.studio_posts()
            .insert_package_request(request.clone())
            .await
            .unwrap()
    );
    // The same key again writes nothing and leaves the transaction usable.
    let same_key = olay_request(
        f.ws,
        &material,
        "olay:keyed:1",
        FIXED_NOW + Duration::minutes(1),
    );
    assert!(
        !tx.studio_posts()
            .insert_package_request(same_key.clone())
            .await
            .unwrap()
    );
    assert_eq!(
        tx.studio_posts()
            .get_package_request(same_key.id)
            .await
            .unwrap(),
        None
    );
    assert!(
        tx.studio_posts()
            .insert_package_request(newer.clone())
            .await
            .unwrap()
    );
    // A taken id under a new key is a conflict, still without spoiling the transaction.
    let mut same_id = newer.clone();
    same_id.key = "olay:keyed:9".into();
    assert_eq!(
        tx.studio_posts()
            .insert_package_request(same_id)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    tx.commit().await.unwrap();

    let mut tx = uow.tenant(f.ws).await.unwrap();
    // Newest first.
    assert_eq!(
        tx.studio_posts().list_package_requests().await.unwrap(),
        [newer.clone(), request.clone()]
    );
    // Open → answered.
    let mut answered = request.clone();
    answered.status = PackageStatus::Answered;
    answered.answered_at = Some(FIXED_NOW + Duration::hours(2));
    tx.studio_posts()
        .update_package_request(answered.clone())
        .await
        .unwrap();
    assert_eq!(
        tx.studio_posts()
            .get_package_request(request.id)
            .await
            .unwrap(),
        Some(answered.clone())
    );
    // A closed request changes no more.
    let mut expired = answered.clone();
    expired.status = PackageStatus::Expired;
    expired.answered_at = None;
    expired.closed_at = Some(FIXED_NOW + Duration::days(7));
    assert_eq!(
        tx.studio_posts()
            .update_package_request(expired)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Conflict
    );
    // Its key, trigger and creation never change.
    let mut rekeyed = newer.clone();
    rekeyed.key = "olay:keyed:3".into();
    let mut recreated = newer.clone();
    recreated.created_at += Duration::seconds(1);
    let mut retriggered = newer.clone();
    retriggered.trigger = PackageTrigger::Calendar;
    retriggered.occasion = Some("yilbasi".into());
    retriggered.year = Some(2026);
    for changed in [rekeyed, recreated, retriggered] {
        assert_eq!(
            tx.studio_posts()
                .update_package_request(changed)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Internal
        );
    }
    // A request that is not stored.
    let missing = olay_request(f.ws, &material, "olay:keyed:4", FIXED_NOW);
    assert_eq!(
        tx.studio_posts()
            .update_package_request(missing)
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    tx.commit().await.unwrap();

    // Only the answer stayed.
    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        tx.studio_posts().list_package_requests().await.unwrap(),
        [newer, answered]
    );
    drop(tx);
    let mut raw = TenantTx::begin(&db.pool, f.ws).await.unwrap();
    let columns: (String, Option<OffsetDateTime>, Option<OffsetDateTime>) = sqlx::query_as(
        "select status, answered_at, closed_at from studio_package_requests \
         where workspace_id=$1 and id=$2",
    )
    .bind(f.ws.0)
    .bind(request.id.0)
    .fetch_one(raw.conn())
    .await
    .unwrap();
    assert_eq!(
        columns,
        (
            String::from("answered"),
            Some(FIXED_NOW + Duration::hours(2)),
            None
        )
    );
    raw.rollback().await.unwrap();
}

#[tokio::test]
async fn posting_settings_are_the_defaults_until_saved_then_replaced() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let (ws, _) = db.seed_workspace("posting-policy").await;
    let mut tx = uow.tenant(ws).await.unwrap();
    assert_eq!(
        tx.studio_posts().posting_settings().await.unwrap(),
        PostingSettings::default()
    );
    assert_eq!(PostingSettings::default().tz, DEFAULT_POSTING_TZ);
    let saved = PostingSettings {
        policy: PostingPolicy {
            floor_days: 6,
            debounce_minutes: 45,
            horizon_days: 14,
            quiet_start_hour: 23,
            quiet_end_hour: 7,
            ..PostingPolicy::default()
        },
        tz: "Europe/Berlin".into(),
    };
    tx.studio_posts()
        .save_posting_settings(saved.clone())
        .await
        .unwrap();
    assert_eq!(tx.studio_posts().posting_settings().await.unwrap(), saved);
    let replaced = PostingSettings {
        policy: PostingPolicy::default(),
        tz: "UTC".into(),
    };
    tx.studio_posts()
        .save_posting_settings(replaced.clone())
        .await
        .unwrap();
    assert_eq!(
        tx.studio_posts().posting_settings().await.unwrap(),
        replaced
    );
    // An invalid policy or time zone is refused before the database.
    let floorless = PostingSettings {
        policy: PostingPolicy {
            floor_days: 0,
            ..PostingPolicy::default()
        },
        tz: "UTC".into(),
    };
    let zoneless = PostingSettings {
        policy: PostingPolicy::default(),
        tz: String::new(),
    };
    let long_zone = PostingSettings {
        policy: PostingPolicy::default(),
        tz: "x".repeat(65),
    };
    for invalid in [floorless, zoneless, long_zone] {
        assert_eq!(
            tx.studio_posts()
                .save_posting_settings(invalid)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Internal
        );
    }
    tx.commit().await.unwrap();
    // One row, its columns mirroring the policy.
    let mut raw = TenantTx::begin(&db.pool, ws).await.unwrap();
    let rows: Vec<(String, i32, i32, i32, i32, i32)> = sqlx::query_as(
        "select tz, floor_days, debounce_minutes, horizon_days, quiet_start_hour, quiet_end_hour \
         from studio_posting_policy where workspace_id=$1",
    )
    .bind(ws.0)
    .fetch_all(raw.conn())
    .await
    .unwrap();
    assert_eq!(rows, [(String::from("UTC"), 4, 30, 30, 0, 8)]);
    raw.rollback().await.unwrap();
}

#[tokio::test]
async fn one_post_per_slot_naming_stored_rows_and_only_its_retirement_changes() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let f = ready(&uow).await;
    let material = seed_material(&uow, f.ws).await;
    let request = olay_request(f.ws, &material, "olay:rules:1", FIXED_NOW);
    let post = planned_post(
        &f,
        f.slot.id,
        &material,
        request.id,
        FIXED_NOW + Duration::days(3),
    );
    let free = another_slot(&uow, &f, FIXED_NOW + Duration::days(4)).await;
    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert!(
        tx.studio_posts()
            .insert_package_request(request.clone())
            .await
            .unwrap()
    );
    tx.studio_posts().insert_post(post.clone()).await.unwrap();
    // A second post for the slot conflicts, without spoiling the transaction.
    let twice = planned_post(
        &f,
        f.slot.id,
        &material,
        request.id,
        FIXED_NOW + Duration::days(4),
    );
    assert_eq!(
        tx.studio_posts().insert_post(twice).await.unwrap_err().code,
        ErrorCode::Conflict
    );
    // A slot, a request or an olay the workspace does not have.
    let at = FIXED_NOW + Duration::days(4);
    let no_slot = planned_post(&f, SlotId::new_v7(), &material, request.id, at);
    let no_request = planned_post(&f, free, &material, PackageRequestId::new_v7(), at);
    let ghost = OlayId::new_v7();
    let mut no_olay = planned_post(&f, free, &material, request.id, at);
    no_olay.olay_id = Some(ghost);
    no_olay.subject = Subject::Olay { olay_id: ghost };
    for missing in [no_slot, no_request, no_olay] {
        assert_eq!(
            tx.studio_posts()
                .insert_post(missing)
                .await
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
    }
    // A post is stored live, its record valid.
    let mut retired = planned_post(&f, free, &material, request.id, at);
    retired.retired = Some(PostRetirement {
        reason: RetirementReason::Cancelled,
        at,
    });
    let mut backwards = planned_post(&f, free, &material, request.id, at);
    backwards.prep_start_at = at + Duration::minutes(1);
    for invalid in [retired, backwards] {
        assert_eq!(
            tx.studio_posts()
                .insert_post(invalid)
                .await
                .unwrap_err()
                .code,
            ErrorCode::Internal
        );
    }
    // A generic post names no olay.
    let mut generic = planned_post(&f, free, &material, request.id, at);
    generic.olay_id = None;
    generic.subject = Subject::Generic;
    tx.studio_posts()
        .insert_post(generic.clone())
        .await
        .unwrap();
    tx.commit().await.unwrap();

    // The trigger: a post is never deleted, nothing but its record and its retirement changes, and
    // the retirement is recorded once.
    let attempt = |sql: &'static str| {
        let pool = db.pool.clone();
        let ws = f.ws;
        let slot = f.slot.id.0;
        async move {
            let mut tx = TenantTx::begin(&pool, ws).await.unwrap();
            let r = sqlx::query(sql)
                .bind(ws.0)
                .bind(slot)
                .execute(tx.conn())
                .await;
            tx.rollback().await.unwrap();
            r.map(|_| ()).map_err(|e| e.to_string())
        }
    };
    let e = attempt("delete from studio_posts where workspace_id=$1 and slot_id=$2")
        .await
        .unwrap_err();
    assert!(e.contains("never deleted"), "{e}");
    for sql in [
        "update studio_posts set format='reel' where workspace_id=$1 and slot_id=$2",
        "update studio_posts set publish_at=publish_at + interval '1 hour', \
         grace_until=grace_until + interval '1 hour' where workspace_id=$1 and slot_id=$2",
        "update studio_posts set olay_id=null where workspace_id=$1 and slot_id=$2",
        "update studio_posts set created_at=created_at + interval '1 second' \
         where workspace_id=$1 and slot_id=$2",
    ] {
        let e = attempt(sql).await.unwrap_err();
        assert!(e.contains("only a post's retirement changes"), "{sql}: {e}");
    }
    attempt("update studio_posts set data=data where workspace_id=$1 and slot_id=$2")
        .await
        .unwrap();
    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert!(
        tx.studio_posts()
            .retire_post(
                f.slot.id,
                PostRetirement {
                    reason: RetirementReason::Cancelled,
                    at: FIXED_NOW + Duration::days(1),
                },
            )
            .await
            .unwrap()
    );
    tx.commit().await.unwrap();
    for sql in [
        "update studio_posts set retired_reason='replanned' where workspace_id=$1 and slot_id=$2",
        "update studio_posts set retired_at=retired_at + interval '1 hour' \
         where workspace_id=$1 and slot_id=$2",
        "update studio_posts set retired_reason=null, retired_at=null \
         where workspace_id=$1 and slot_id=$2",
    ] {
        let e = attempt(sql).await.unwrap_err();
        assert!(e.contains("recorded once"), "{sql}: {e}");
    }

    // The table checks, under their own names.
    let checks_slot = another_slot(&uow, &f, FIXED_NOW + Duration::days(5)).await;
    let ordered = |prep: i64, grace: i64| RawPost {
        prep: Duration::minutes(prep),
        grace: Duration::minutes(grace),
        retired_reason: None,
        retired_at: None,
    };
    assert_eq!(
        refused_post(&db.pool, &f, checks_slot, request.id, ordered(1, 60)).await,
        "studio_posts_prep_rule"
    );
    assert_eq!(
        refused_post(&db.pool, &f, checks_slot, request.id, ordered(-60, -1)).await,
        "studio_posts_grace_rule"
    );
    let half_retired = RawPost {
        retired_reason: Some("cancelled"),
        ..ordered(-60, 60)
    };
    assert_eq!(
        refused_post(&db.pool, &f, checks_slot, request.id, half_retired).await,
        "studio_posts_retired_rule"
    );
    let mut raw = TenantTx::begin(&db.pool, f.ws).await.unwrap();
    let err = sqlx::query(
        "insert into studio_package_requests(workspace_id,id,key,trigger,status,data,created_at,\
         answered_at,closed_at) values($1,$2,'olay:rules:2','olay','open','{}',$3,$3,null)",
    )
    .bind(f.ws.0)
    .bind(PackageRequestId::new_v7().0)
    .bind(FIXED_NOW)
    .execute(raw.conn())
    .await
    .unwrap_err();
    raw.rollback().await.unwrap();
    assert_eq!(
        err.as_database_error().unwrap().constraint(),
        Some("studio_package_requests_status_rule")
    );
}

#[tokio::test]
async fn another_workspace_sees_and_names_none_of_it() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let a = ready(&uow).await;
    let b = ready(&uow).await;
    let material_a = seed_material(&uow, a.ws).await;
    let material_b = seed_material(&uow, b.ws).await;
    let request_a = olay_request(a.ws, &material_a, "olay:isolated:1", FIXED_NOW);
    let request_b = olay_request(b.ws, &material_b, "olay:isolated:1", FIXED_NOW);
    let at = FIXED_NOW + Duration::days(3);
    let post_a = planned_post(&a, a.slot.id, &material_a, request_a.id, at);
    let mut tx = uow.tenant(a.ws).await.unwrap();
    assert!(
        tx.studio_posts()
            .insert_package_request(request_a.clone())
            .await
            .unwrap()
    );
    tx.studio_posts().insert_post(post_a).await.unwrap();
    tx.studio_posts()
        .save_posting_settings(PostingSettings {
            policy: PostingPolicy::default(),
            tz: "UTC".into(),
        })
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let mut tx = uow.tenant(b.ws).await.unwrap();
    assert_eq!(tx.studio_posts().get_post(a.slot.id).await.unwrap(), None);
    assert!(tx.studio_posts().list_posts().await.unwrap().is_empty());
    assert_eq!(
        tx.studio_posts()
            .get_package_request(request_a.id)
            .await
            .unwrap(),
        None
    );
    assert!(
        tx.studio_posts()
            .list_package_requests()
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        tx.studio_posts().posting_settings().await.unwrap(),
        PostingSettings::default()
    );
    // The same key is the other workspace's own.
    assert!(
        tx.studio_posts()
            .insert_package_request(request_b.clone())
            .await
            .unwrap()
    );
    // B cannot plan on A's slot, A's request or A's olay.
    for foreign in [
        planned_post(&b, a.slot.id, &material_b, request_b.id, at),
        planned_post(&b, b.slot.id, &material_b, request_a.id, at),
        planned_post(&b, b.slot.id, &material_a, request_b.id, at),
    ] {
        assert_eq!(
            tx.studio_posts()
                .insert_post(foreign)
                .await
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
    }
    tx.commit().await.unwrap();

    // Raw rows: every table forces row-level security, which hides A's rows from B.
    for table in TABLES {
        let forced: bool = sqlx::query_scalar(
            "select relrowsecurity and relforcerowsecurity from pg_class where relname=$1",
        )
        .bind(table)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert!(forced, "{table}");
        let unscoped: i64 = sqlx::query_scalar(&format!("select count(*) from {table}"))
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(unscoped, 0, "unscoped {table}");
        for (ws, seen) in [(a.ws, 1), (b.ws, 0)] {
            let mut raw = TenantTx::begin(&db.pool, ws).await.unwrap();
            let count: i64 = sqlx::query_scalar(&format!(
                "select count(*) from {table} where workspace_id=$1"
            ))
            .bind(a.ws.0)
            .fetch_one(raw.conn())
            .await
            .unwrap();
            raw.rollback().await.unwrap();
            assert_eq!(count, seen, "{table} seen from {ws}");
        }
    }
    // Nor can B write a row of A's.
    let mut raw = TenantTx::begin(&db.pool, b.ws).await.unwrap();
    let err = sqlx::query(
        "insert into studio_posting_policy(workspace_id,data,tz,floor_days,debounce_minutes,\
         horizon_days,quiet_start_hour,quiet_end_hour) values($1,'{}','UTC',4,30,30,0,8)",
    )
    .bind(a.ws.0)
    .execute(raw.conn())
    .await
    .unwrap_err();
    raw.rollback().await.unwrap();
    assert_eq!(
        err.as_database_error().unwrap().code().as_deref(),
        Some("42501")
    );
}

/// Whether each of the three tables, and the trigger function, exist.
async fn schema(pool: &PgPool) -> (Vec<bool>, bool) {
    let mut tables = Vec::new();
    for table in TABLES {
        tables.push(
            sqlx::query_scalar::<_, bool>("select to_regclass($1) is not null")
                .bind(format!("public.{table}"))
                .fetch_one(pool)
                .await
                .unwrap(),
        );
    }
    let function: bool = sqlx::query_scalar(
        "select exists(select 1 from pg_proc where proname='studio_posts_fixed')",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    (tables, function)
}

#[tokio::test]
async fn the_down_refuses_while_a_post_or_a_request_is_stored_and_both_repeat() {
    let db = TestDb::new().await;
    let uow = PgUnitOfWork::new(db.pool.clone());
    let f = ready(&uow).await;
    let material = seed_material(&uow, f.ws).await;
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../migrations");
    let up = std::fs::read_to_string(dir.join("0022_studio_posts.up.sql")).unwrap();
    let down = std::fs::read_to_string(dir.join("0022_studio_posts.down.sql")).unwrap();
    let run = |sql: String| {
        let pool = db.pool.clone();
        async move { sqlx::raw_sql(&sql).execute(&pool).await.map(|_| ()) }
    };
    // Empty: down and up again, each twice.
    for _ in 0..2 {
        run(down.clone()).await.unwrap();
        assert_eq!(schema(&db.pool).await, (vec![false; 3], false));
    }
    for _ in 0..2 {
        run(up.clone()).await.unwrap();
        assert_eq!(schema(&db.pool).await, (vec![true; 3], true));
    }
    let trigger: bool = sqlx::query_scalar(
        "select exists(select 1 from pg_trigger where tgname='studio_posts_fixed' and not tgisinternal)",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(trigger);

    // A posting policy alone does not hold the down back.
    let mut tx = uow.tenant(f.ws).await.unwrap();
    tx.studio_posts()
        .save_posting_settings(PostingSettings {
            policy: PostingPolicy::default(),
            tz: "UTC".into(),
        })
        .await
        .unwrap();
    tx.commit().await.unwrap();
    run(down.clone()).await.unwrap();
    run(up.clone()).await.unwrap();

    // A package request does.
    let request = olay_request(f.ws, &material, "olay:down:1", FIXED_NOW);
    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert_eq!(
        tx.studio_posts().posting_settings().await.unwrap(),
        PostingSettings::default()
    );
    assert!(
        tx.studio_posts()
            .insert_package_request(request.clone())
            .await
            .unwrap()
    );
    tx.commit().await.unwrap();
    let refused = run(down.clone()).await.unwrap_err().to_string();
    assert!(
        refused.contains("0022_studio_posts down refused: package requests are stored"),
        "{refused}"
    );
    // A planned post too, named first.
    let mut tx = uow.tenant(f.ws).await.unwrap();
    tx.studio_posts()
        .insert_post(planned_post(
            &f,
            f.slot.id,
            &material,
            request.id,
            FIXED_NOW + Duration::days(3),
        ))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let refused = run(down.clone()).await.unwrap_err().to_string();
    assert!(
        refused.contains("0022_studio_posts down refused: planned posts are stored"),
        "{refused}"
    );
    // Nothing was dropped, and `up` over the stored rows changes nothing.
    run(up).await.unwrap();
    assert_eq!(schema(&db.pool).await, (vec![true; 3], true));
    let mut tx = uow.tenant(f.ws).await.unwrap();
    assert_eq!(tx.studio_posts().list_posts().await.unwrap().len(), 1);
    assert_eq!(
        tx.studio_posts().list_package_requests().await.unwrap(),
        [request]
    );
}
