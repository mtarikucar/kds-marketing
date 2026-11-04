//! Promotion from the prospect pool into the inbox (spec
//! 2026-10-30-leads-pool-outreach-design.md §3.5, §3.6): one matching path, no consent, a
//! business recipient, the prospect linked; and a person's erasure reaching the pool. Every
//! value is invented.

mod support;

use jt_app::ctx::Ctx;
use jt_app::ports::UnitOfWork;
use jt_app::usecases::inbox::{erasure, journeys, people};
use jt_app::usecases::prospects::{
    self, DecideInput, DecideKind, PromoteInput, PromoteOutcome, SettingsInput,
};
use jt_inbox::{IdentityChannel, JourneyStatus, PersonId, RecipientKind, Source};
use jt_prospects::{
    ContactPerson, CreateInput, EntityKind, FieldInput, KeyKind, Prospect, ProspectId,
    ProspectStatus, SourceRefInput,
};
use jt_testkit::fakes::FIXED_NOW;
use serde_json::json;
use support::*;
use time::Duration;

const PHONE: &str = "+905000000001";
const EMAIL: &str = "info@ornek-kafe.example.invalid";

fn field(value: &str) -> Option<FieldInput<String>> {
    Some(FieldInput {
        value: value.into(),
        sources: vec![SourceRefInput::Url {
            url: "https://ornek-kafe.example.invalid/iletisim".into(),
            note: None,
        }],
        captured_at: FIXED_NOW - Duration::days(1),
    })
}

/// The Instagram handle a fixture business named `name` holds: its name folded to ASCII
/// lowercase letters and digits, so two differently named businesses never share the hard key
/// and "Örnek Kafe" stays `ornekkafe`.
fn handle(name: &str) -> String {
    name.chars()
        .flat_map(char::to_lowercase)
        .map(|c| match c {
            'ç' => 'c',
            'ğ' => 'g',
            'ı' => 'i',
            'ö' => 'o',
            'ş' => 's',
            'ü' => 'u',
            c => c,
        })
        .filter(char::is_ascii_alphanumeric)
        .collect()
}

fn input(name: &str, phone: Option<&str>, email: Option<&str>) -> CreateInput {
    CreateInput {
        business_name: name.into(),
        entity_kind: EntityKind::LegalEntity,
        sector: Some("kafe".into()),
        city: Some("İstanbul".into()),
        district: None,
        language: Some("tr".into()),
        segment_key: None,
        country: None,
        labels: vec![],
        phone: phone.and_then(field),
        email: email.and_then(field),
        website: None,
        instagram: field(&format!("https://www.instagram.com/{}", handle(name))),
        tiktok: None,
        address: None,
        contact_person: None,
        size: None,
        signals: vec![],
        notes: String::new(),
        research_task_id: None,
        discovered_at: vec![],
        distinct_from: vec![],
        request_key: None,
    }
}

async fn create(w: &World, i: CreateInput) -> Prospect {
    prospects::create(&w.deps, &w.owner_ctx, i)
        .await
        .unwrap()
        .prospect
}

async fn qualify(w: &World, p: &Prospect) -> Prospect {
    prospects::decide(
        &w.deps,
        &w.owner_ctx,
        p.id,
        DecideInput {
            decision: DecideKind::Qualify,
            reason: None,
            note: None,
            expected_revision: p.revision,
        },
    )
    .await
    .unwrap()
    .prospect
}

/// A qualified prospect named `name` with `phone` and `email`.
async fn qualified(w: &World, name: &str, phone: Option<&str>, email: Option<&str>) -> Prospect {
    let p = create(w, input(name, phone, email)).await;
    qualify(w, &p).await
}

async fn promote(w: &World, ctx: &Ctx, ids: &[ProspectId]) -> Vec<PromoteOutcome> {
    prospects::promote(
        &w.deps,
        ctx,
        PromoteInput {
            prospect_ids: ids.to_vec(),
            request_key: None,
        },
    )
    .await
    .unwrap()
    .items
}

async fn one(w: &World, ctx: &Ctx, id: ProspectId) -> PromoteOutcome {
    promote(w, ctx, &[id]).await.remove(0)
}

fn refused(o: &PromoteOutcome) -> &str {
    match o {
        PromoteOutcome::Refused { reason, .. } => reason,
        other => panic!("not refused: {other:?}"),
    }
}

fn promoted(o: &PromoteOutcome) -> (PersonId, jt_inbox::JourneyId, bool) {
    match o {
        PromoteOutcome::Promoted {
            person_id,
            journey_id,
            created_person,
            ..
        } => (*person_id, *journey_id, *created_person),
        other => panic!("not promoted: {other:?}"),
    }
}

async fn prospect(w: &World, id: ProspectId) -> Option<Prospect> {
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.prospects().get(id).await.unwrap()
}

/// A person who reached the inbox on their own with `phone`.
async fn inbound_person(w: &World, phone: &str) -> PersonId {
    people::create(
        &w.deps,
        &w.owner_ctx,
        serde_json::from_value(json!({
            "display_name": "Arayan",
            "identities": [{"channel": "phone", "value": phone, "capability_id": null}],
            "source": "form",
        }))
        .unwrap(),
    )
    .await
    .unwrap()
    .person
    .id
}

fn event(kind: &str, key: &str, payload: serde_json::Value) -> journeys::ReportInput {
    serde_json::from_value(json!({"kind": kind, "idempotency_key": key, "payload": payload}))
        .unwrap()
}

#[tokio::test]
async fn promote_creates_person_journey_and_links() {
    let w = world().await;
    let p = qualified(&w, "Örnek Kafe", Some(PHONE), Some(EMAIL)).await;
    let (person, journey, created) = promoted(&one(&w, &w.owner_ctx, p.id).await);
    assert!(created);

    let s = w.uow.snapshot();
    let row = s.inbox.journeys.iter().find(|j| j.id == journey).unwrap();
    assert_eq!(row.person_id, person);
    assert_eq!(row.status, JourneyStatus::New);
    assert_eq!(
        row.source,
        Source::Prospect {
            prospect_id: p.id.as_uuid(),
            origin: "manual".into(),
        }
    );
    let channels: Vec<IdentityChannel> = s
        .inbox
        .identities
        .iter()
        .filter(|i| i.person_id == person)
        .map(|i| i.channel)
        .collect();
    assert_eq!(channels.len(), 2);
    assert!(channels.contains(&IdentityChannel::Phone));
    assert!(channels.contains(&IdentityChannel::Email));

    let linked = prospect(&w, p.id).await.unwrap();
    assert_eq!(linked.status, ProspectStatus::Promoted);
    let promotion = linked.promoted.unwrap();
    assert_eq!(
        (promotion.person_id, promotion.journey_id),
        (person, journey)
    );
    assert_eq!(promotion.at, FIXED_NOW);

    let entry = payload(&w.entries("prospects.promoted")[0]);
    assert_eq!(entry["person_id"], json!(person));
    assert_eq!(entry["created_person"], true);
    assert_eq!(w.entries("inbox.person.created").len(), 1);

    // Promoted is terminal: a second call answers the link.
    match one(&w, &w.owner_ctx, p.id).await {
        PromoteOutcome::AlreadyPromoted {
            person_id,
            journey_id,
            ..
        } => assert_eq!((person_id, journey_id), (person, journey)),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn promoted_person_is_business_with_company() {
    let w = world().await;
    let mut i = input("Örnek Kafe", Some(PHONE), None);
    i.contact_person = Some(FieldInput {
        value: ContactPerson {
            name: "Ayşe Yılmaz".into(),
            role: "Kurucu".into(),
        },
        sources: vec![SourceRefInput::Url {
            url: "https://ornek-kafe.example.invalid/hakkimizda".into(),
            note: None,
        }],
        captured_at: FIXED_NOW - Duration::days(1),
    });
    let p = qualify(&w, &create(&w, i).await).await;
    let (person, _, _) = promoted(&one(&w, &w.owner_ctx, p.id).await);
    let s = w.uow.snapshot();
    let row = s.inbox.people.iter().find(|x| x.id == person).unwrap();
    assert_eq!(row.recipient_kind, RecipientKind::Business);
    assert_eq!(row.company, "Örnek Kafe");
    assert_eq!(row.display_name, "Ayşe Yılmaz");
}

#[tokio::test]
async fn no_consent_is_recorded() {
    let w = world().await;
    let p = qualified(&w, "Örnek Kafe", Some(PHONE), Some(EMAIL)).await;
    promoted(&one(&w, &w.owner_ctx, p.id).await);
    let s = w.uow.snapshot();
    assert!(s.inbox.consents.is_empty());
    assert!(s.inbox.suppressions.is_empty());
}

#[tokio::test]
async fn agent_cannot_promote_new() {
    let w = world().await;
    let agent = w.agent(&["prospects.work", "inbox.work"]).await;
    let p = create(&w, input("Örnek Kafe", Some(PHONE), None)).await;
    let o = one(&w, &agent, p.id).await;
    assert_eq!(refused(&o), "not_qualified");
    assert_eq!(
        prospect(&w, p.id).await.unwrap().status,
        ProspectStatus::New
    );
    assert!(w.uow.snapshot().inbox.people.is_empty());

    // The policy may let agents promote new prospects too.
    prospects::settings_set(
        &w.deps,
        &w.owner_ctx,
        serde_json::from_value::<SettingsInput>(json!({"agents_promote_qualified_only": false}))
            .unwrap(),
    )
    .await
    .unwrap();
    promoted(&one(&w, &agent, p.id).await);

    // Promotion needs both permissions.
    let pool_only = w.agent(&["prospects.work"]).await;
    let q = qualified(&w, "Başka Kafe", Some("+905000000002"), None).await;
    let e = err(prospects::promote(
        &w.deps,
        &pool_only,
        PromoteInput {
            prospect_ids: vec![q.id],
            request_key: None,
        },
    )
    .await);
    assert_forbidden(&e, "inbox.work");
}

#[tokio::test]
async fn human_can_promote_new() {
    let w = world().await;
    let p = create(&w, input("Örnek Kafe", Some(PHONE), None)).await;
    promoted(&one(&w, &w.owner_ctx, p.id).await);
}

#[tokio::test]
async fn existing_person_with_open_journey_is_reused() {
    let w = world().await;
    let person = inbound_person(&w, PHONE).await;
    let open = w.uow.snapshot().inbox.journeys[0].id;
    let p = holding_phone_of_existing(&w, PHONE, Some(EMAIL)).await;
    let (got, journey, created) = promoted(&one(&w, &w.owner_ctx, p.id).await);
    assert_eq!((got, journey, created), (person, open, false));
    let s = w.uow.snapshot();
    assert_eq!(s.inbox.people.len(), 1);
    assert_eq!(s.inbox.journeys.len(), 1);
    // The email became the person's identity too, and the person a business.
    assert_eq!(
        s.inbox
            .identities
            .iter()
            .filter(|i| i.person_id == person)
            .count(),
        2
    );
    assert_eq!(s.inbox.people[0].recipient_kind, RecipientKind::Business);
    // A company the person never gave is not written onto an existing person.
    assert_eq!(s.inbox.people[0].company, "");
}

#[tokio::test]
async fn an_individual_stays_an_individual() {
    let w = world().await;
    let person = inbound_person(&w, PHONE).await;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.people()
        .set_recipient_kind(person, RecipientKind::Individual, FIXED_NOW)
        .await
        .unwrap();
    r.commit().await.unwrap();
    let p = holding_phone_of_existing(&w, PHONE, None).await;
    promoted(&one(&w, &w.owner_ctx, p.id).await);
    assert_eq!(
        w.uow.snapshot().inbox.people[0].recipient_kind,
        RecipientKind::Individual
    );
}

fn prospect_evidence(p: &Prospect) -> jt_prospects::Evidence {
    p.contact
        .email
        .as_ref()
        .or(p.contact.instagram.as_ref())
        .unwrap()
        .evidence
        .clone()
}

/// A qualified prospect holding `phone` (and `email`) of a person already in the inbox,
/// written past the pool's `in_inbox` check: the person reached the inbox after the prospect was
/// recorded.
async fn holding_phone_of_existing(w: &World, phone: &str, email: Option<&str>) -> Prospect {
    let p = qualified(w, "Örnek Kafe", Some("+905000000009"), None).await;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let mut stored = r.prospects().get(p.id).await.unwrap().unwrap();
    stored.contact.phone = Some(jt_prospects::Field {
        value: phone.into(),
        evidence: prospect_evidence(&p),
        deliverable: true,
    });
    stored.contact.email = email.map(|e| jt_prospects::Field {
        value: e.into(),
        evidence: prospect_evidence(&p),
        deliverable: true,
    });
    let keys = jt_prospects::derive_keys(&stored);
    let rev = stored.revision;
    stored.revision += 1;
    r.prospects().update(&stored, &keys, rev).await.unwrap();
    r.commit().await.unwrap();
    stored
}

#[tokio::test]
async fn existing_lost_journey_refuses() {
    let w = world().await;
    let person = inbound_person(&w, PHONE).await;
    let journey = w.uow.snapshot().inbox.journeys[0].id;
    journeys::report(
        &w.deps,
        &w.owner_ctx,
        journey,
        event("lost", "lost-1", json!({"reason_key": "fiyat"})),
    )
    .await
    .unwrap();
    let p = holding_phone_of_existing(&w, PHONE, None).await;
    let o = one(&w, &w.owner_ctx, p.id).await;
    assert_eq!(refused(&o), "lost_journey_exists");
    let PromoteOutcome::Refused { details, .. } = &o else {
        unreachable!()
    };
    assert_eq!(details["person_id"], json!(person));
    assert_eq!(details["journey_id"], json!(journey));
    // Nothing changed: the prospect waits, the person has one journey.
    assert_eq!(
        prospect(&w, p.id).await.unwrap().status,
        ProspectStatus::Qualified
    );
    assert_eq!(w.uow.snapshot().inbox.journeys.len(), 1);
}

#[tokio::test]
async fn existing_won_opens_repeat() {
    let w = world().await;
    let person = inbound_person(&w, PHONE).await;
    let won = w.uow.snapshot().inbox.journeys[0].id;
    journeys::report(
        &w.deps,
        &w.owner_ctx,
        won,
        event(
            "won",
            "won-1",
            json!({"product": "Plan", "amount_minor": 100, "currency": "TRY"}),
        ),
    )
    .await
    .unwrap();
    let p = holding_phone_of_existing(&w, PHONE, None).await;
    let (got, journey, created) = promoted(&one(&w, &w.owner_ctx, p.id).await);
    assert_eq!(got, person);
    assert!(!created);
    assert_ne!(journey, won);
    let s = w.uow.snapshot();
    let row = s.inbox.journeys.iter().find(|j| j.id == journey).unwrap();
    assert_eq!(row.source, Source::Repeat);
    assert!(row.closed_at.is_none());
    assert_eq!(w.entries("inbox.journey.opened").len(), 1);
}

#[tokio::test]
async fn identity_split_commits_suggestion_and_refuses() {
    let w = world().await;
    let by_phone = inbound_person(&w, PHONE).await;
    let by_email = people::create(
        &w.deps,
        &w.owner_ctx,
        serde_json::from_value(json!({
            "display_name": "Yazan",
            "identities": [{"channel": "email", "value": EMAIL, "capability_id": null}],
            "source": "form",
        }))
        .unwrap(),
    )
    .await
    .unwrap()
    .person
    .id;
    let p = holding_phone_of_existing(&w, PHONE, Some(EMAIL)).await;
    let o = one(&w, &w.owner_ctx, p.id).await;
    assert_eq!(refused(&o), "identity_split");
    let s = w.uow.snapshot();
    assert_eq!(s.inbox.merges.len(), 1, "the merge suggestion is kept");
    assert_eq!(s.inbox.people.len(), 2);
    assert_ne!(by_phone, by_email);
    assert_eq!(
        prospect(&w, p.id).await.unwrap().status,
        ProspectStatus::Qualified
    );
}

#[tokio::test]
async fn undeliverable_email_is_not_an_identity() {
    let w = world().await;
    let p = qualified(&w, "Örnek Kafe", Some(PHONE), Some(EMAIL)).await;
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let mut stored = r.prospects().get(p.id).await.unwrap().unwrap();
    stored.contact.email.as_mut().unwrap().deliverable = false;
    let keys = jt_prospects::derive_keys(&stored);
    let rev = stored.revision;
    stored.revision += 1;
    r.prospects().update(&stored, &keys, rev).await.unwrap();
    r.commit().await.unwrap();

    let (person, _, _) = promoted(&one(&w, &w.owner_ctx, p.id).await);
    let s = w.uow.snapshot();
    let channels: Vec<IdentityChannel> = s
        .inbox
        .identities
        .iter()
        .filter(|i| i.person_id == person)
        .map(|i| i.channel)
        .collect();
    assert_eq!(channels, [IdentityChannel::Phone]);
}

#[tokio::test]
async fn no_identity_refuses() {
    let w = world().await;
    // A 444 number is evidence, never an identity; a handle is no identity either.
    let p = qualified(&w, "Örnek Kafe", Some("444 0 000"), None).await;
    assert_eq!(
        refused(&one(&w, &w.owner_ctx, p.id).await),
        "no_contact_identity"
    );
    assert!(w.uow.snapshot().inbox.people.is_empty());
}

#[tokio::test]
async fn promotion_cap_per_local_day() {
    let w = world().await;
    prospects::settings_set(
        &w.deps,
        &w.owner_ctx,
        serde_json::from_value::<SettingsInput>(
            json!({"max_promotions_per_day": 1, "timezone": "America/New_York"}),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    let a = qualified(&w, "Bir Kafe", Some("+905000000011"), None).await;
    let b = qualified(&w, "İki Kafe", Some("+905000000012"), None).await;
    promoted(&one(&w, &w.owner_ctx, a.id).await);
    let o = one(&w, &w.owner_ctx, b.id).await;
    assert_eq!(refused(&o), "daily_cap");
    // The next local day in New York (not the server's, not Istanbul's) takes one more.
    let (_, end) = jt_app::usecases::hours::local_day("America/New_York", FIXED_NOW).unwrap();
    let next_day = at(&w.owner_ctx, end + Duration::minutes(1));
    promoted(&one(&w, &next_day, b.id).await);
}

#[tokio::test]
async fn batch_reports_per_item_outcomes() {
    let w = world().await;
    let good = qualified(&w, "Örnek Kafe", Some(PHONE), None).await;
    let none = qualified(&w, "Sessiz Kafe", Some("444 0 001"), None).await;
    let missing = ProspectId::new_v7();
    let items = promote(&w, &w.owner_ctx, &[good.id, none.id, missing, good.id]).await;
    assert_eq!(items.len(), 3, "a repeated id is promoted once");
    promoted(&items[0]);
    assert_eq!(refused(&items[1]), "no_contact_identity");
    assert_eq!(refused(&items[2]), "not_found");
    let e = err(prospects::promote(
        &w.deps,
        &w.owner_ctx,
        PromoteInput {
            prospect_ids: vec![],
            request_key: None,
        },
    )
    .await);
    assert_invalid(&e, "prospect_ids");
}

#[tokio::test]
async fn request_key_replays_the_promotion() {
    let w = world().await;
    let p = qualified(&w, "Örnek Kafe", Some(PHONE), None).await;
    let call = || {
        prospects::promote(
            &w.deps,
            &w.owner_ctx,
            PromoteInput {
                prospect_ids: vec![p.id],
                request_key: Some("promote-1".into()),
            },
        )
    };
    let first = call().await.unwrap().items;
    let again = call().await.unwrap().items;
    assert_eq!(
        first, again,
        "a replay answers promoted again, not already_promoted"
    );
    let stored = w.uow.snapshot().inbox.request_keys;
    let held: Vec<String> = stored.iter().map(|k| k.response.to_string()).collect();
    assert!(
        held.iter().all(|r| !r.contains(PHONE)),
        "ids only: {held:?}"
    );
}

#[tokio::test]
async fn blocklisted_since_creation_refuses() {
    let w = world().await;
    let p = qualified(&w, "Örnek Kafe", Some(PHONE), None).await;
    // An objection that reached a rep by phone, recorded by raw key after the prospect.
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    let key = jt_prospects::Key {
        kind: KeyKind::Instagram,
        value: "ornekkafe".into(),
    };
    let hash = blocklist_hash(&w, &key);
    r.prospect_blocklist()
        .insert(
            key.kind,
            &hash,
            jt_app::ports::prospects::BlockReason::DoNotContact,
            FIXED_NOW,
            None,
            &"0".repeat(16),
        )
        .await
        .unwrap();
    r.commit().await.unwrap();
    assert_eq!(
        refused(&one(&w, &w.owner_ctx, p.id).await),
        "do_not_contact"
    );
    assert!(w.uow.snapshot().inbox.people.is_empty());
}

/// The blocklist hash of `key` in `w`'s workspace, as the pool computes it.
fn blocklist_hash(w: &World, key: &jt_prospects::Key) -> String {
    use hmac::{Hmac, KeyInit, Mac};
    let secret = w
        .deps
        .seal
        .hmac_key(w.ws, jt_app::usecases::prospects::BLOCKLIST_PURPOSE)
        .unwrap();
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(secret.as_ref()).unwrap();
    mac.update(&jt_prospects::blocklist_material(key.kind, &key.value));
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[tokio::test]
async fn context_shows_prospect_facts() {
    let w = world().await;
    let p = qualified(&w, "Örnek Kafe", Some(PHONE), Some(EMAIL)).await;
    let (person, _, _) = promoted(&one(&w, &w.owner_ctx, p.id).await);
    let out = people::get(&w.deps, &w.owner_ctx, person).await.unwrap();
    let summary = out.prospect.expect("the prospect is shown");
    assert_eq!(summary.prospect_id, p.id);
    assert_eq!(summary.business_name, "Örnek Kafe");
    assert_eq!(summary.city.as_deref(), Some("İstanbul"));
    let fields: Vec<&str> = summary.evidence.iter().map(|e| e.field).collect();
    assert!(fields.contains(&"phone") && fields.contains(&"email"));
    // Evidence names its sources, never the value.
    let wire = serde_json::to_string(&summary).unwrap();
    assert!(!wire.contains(PHONE) && !wire.contains(EMAIL), "{wire}");
    assert!(wire.contains("ornek-kafe.example.invalid/iletisim"));

    // A person who was never a prospect shows none.
    let unlinked = inbound_person(&w, "+905000000099").await;
    let out = people::get(&w.deps, &w.owner_ctx, unlinked).await.unwrap();
    assert!(out.prospect.is_none());
}

#[tokio::test]
async fn erasing_the_person_scrubs_the_prospect_and_blocks_its_handles() {
    let w = world().await;
    let p = qualified(&w, "Örnek Kafe", Some(PHONE), Some(EMAIL)).await;
    let (person, _, _) = promoted(&one(&w, &w.owner_ctx, p.id).await);
    erasure::erase(
        &w.deps,
        &w.owner_ctx,
        person,
        serde_json::from_value(json!({"confirm": true})).unwrap(),
    )
    .await
    .unwrap();
    let scrubbed = prospect(&w, p.id).await.unwrap();
    assert_eq!(scrubbed.status, ProspectStatus::Promoted, "ids kept");
    assert!(scrubbed.contact.phone.is_none() && scrubbed.contact.instagram.is_none());
    assert_eq!(scrubbed.business_name, "—");
    let s = w.uow.snapshot();
    assert!(
        s.prospects.keys.iter().all(|(_, id, _)| *id != p.id),
        "no key values left"
    );
    let kinds: Vec<KeyKind> = s.prospects.blocklist.iter().map(|b| b.kind).collect();
    assert!(kinds.contains(&KeyKind::Instagram));
    assert!(
        s.prospects
            .blocklist
            .iter()
            .all(|b| b.reason == jt_app::ports::prospects::BlockReason::Erased)
    );
    // The business cannot be recorded again by its handle.
    let mut again = input("Örnek Kafe", None, None);
    again.phone = field("+905000000077");
    let e = err(prospects::create(&w.deps, &w.owner_ctx, again).await);
    assert_eq!(e.details["reason"], "do_not_contact");
    let entry = payload(w.entries("prospects.erased").last().unwrap());
    assert_eq!(entry["via"], "person");
    assert!(!entry.to_string().contains("ornekkafe"));
}

#[tokio::test]
async fn erasing_a_person_deletes_unlinked_prospects_holding_its_phone() {
    let w = world().await;
    let p = holding_phone_of_existing(&w, PHONE, None).await;
    let person = inbound_person(&w, PHONE).await;
    erasure::erase(
        &w.deps,
        &w.owner_ctx,
        person,
        serde_json::from_value(json!({"confirm": true})).unwrap(),
    )
    .await
    .unwrap();
    assert!(prospect(&w, p.id).await.is_none());
    assert!(!w.uow.snapshot().prospects.blocklist.is_empty());
}

#[tokio::test]
async fn promotion_takes_inbox_then_pool_lock() {
    let w = world().await;
    let p = qualified(&w, "Örnek Kafe", Some(PHONE), None).await;
    let before = w.uow.lock_journal().len();
    promoted(&one(&w, &w.owner_ctx, p.id).await);
    let journal = w.uow.lock_journal()[before..].to_vec();
    let pool = journal
        .iter()
        .position(|(_, l)| *l == "pool")
        .expect("the pool lock is taken");
    let (bundle, _) = journal[pool];
    assert!(
        journal[..pool]
            .iter()
            .any(|(b, l)| *b == bundle && *l == "inbox"),
        "inbox before pool in the same bundle: {journal:?}"
    );
}

#[tokio::test]
async fn set_kind_records_note_in_ledger_without_value() {
    let w = world().await;
    let person = inbound_person(&w, PHONE).await;
    let out = people::set_kind(
        &w.deps,
        &w.owner_ctx,
        person,
        people::SetKindInput {
            kind: RecipientKind::Business,
            note: Some("faturada şirket unvanı var".into()),
        },
    )
    .await
    .unwrap();
    assert_eq!(out.recipient_kind, RecipientKind::Business);
    let notes = w.uow.snapshot().inbox.notes;
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].text, "faturada şirket unvanı var");
    // The same kind again changes nothing and records nothing.
    people::set_kind(
        &w.deps,
        &w.owner_ctx,
        person,
        people::SetKindInput {
            kind: RecipientKind::Business,
            note: None,
        },
    )
    .await
    .unwrap();
    let entries = w.entries("inbox.person.kind_set");
    assert_eq!(entries.len(), 1);
    let entry = payload(&entries[0]);
    assert_eq!(entry["from"], "unknown");
    assert_eq!(entry["to"], "business");
    assert_eq!(entry["note"], true);
    assert!(!entry.to_string().contains("unvan"));
    assert!(!entry.to_string().contains(PHONE));
    assert!(!entry.to_string().contains("Arayan"));
    // A person without inbox.work cannot.
    let pool_only = w.agent(&["prospects.work"]).await;
    let e = err(people::set_kind(
        &w.deps,
        &pool_only,
        person,
        people::SetKindInput {
            kind: RecipientKind::Individual,
            note: None,
        },
    )
    .await);
    assert_forbidden(&e, "inbox.work");
}
