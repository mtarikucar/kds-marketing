//! The pre-publish truth check (spec 2026-11-03 §5.5, §5.6, §7, D19): a caption that names what
//! its materials' olays do not back is submitted, shown in `studio.slot_get` as the slot's
//! `material_check`, and held at publish until an owner or manager releases those exact findings
//! for that revision. A hard finding (an eligibility refusal) is never releasable.
#[path = "support/studio_acceptance.rs"]
mod acceptance;
use acceptance::{publishing_world, receipt, sends, world::World};
use jt_app::{
    ctx::Ctx,
    error::{AppError, ErrorCode},
    ports::UnitOfWork,
    usecases::{
        inbox::people,
        studio::{
            materials::{MaterialCheckReleaseInput, material_check_release},
            pieces::{PieceInput, piece_submit},
            publish, work,
        },
    },
};
use jt_ledger::Actor;
use jt_studio::{Olay, OlayClient, SharePermission, Subject};
use jt_tenancy::AgentConnectionId;
use jt_testkit::studio_contract::confirmed_olay;
use serde_json::{Value, json};

fn reason(e: &AppError) -> &str {
    e.details["reason"].as_str().unwrap_or_default()
}

/// Stores a confirmed olay of the workspace titled `title` at `place`: another olay than the
/// pieces' subject.
async fn other_olay(w: &World, title: &str, place: Option<&str>) -> Olay {
    let o = Olay {
        title: title.into(),
        place: place.map(Into::into),
        ..confirmed_olay(w.f.ws)
    };
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio_materials().insert_olay(o.clone()).await.unwrap();
    r.commit().await.unwrap();
    o
}

/// The fixture slot's next piece (at `revision`, revision + 1 once saved) showing `material`
/// about `subject`, with `text`.
fn piece(
    w: &World,
    key: &str,
    revision: u64,
    material: &jt_studio::Material,
    subject: Subject,
    text: &str,
) -> PieceInput {
    serde_json::from_value(json!({
        "slot_id": w.f.slot.id, "expected_revision": revision, "request_key": key, "text": text,
        "media": [{"kind":"file","id":material.file_id}], "adaptations": {},
        "subject": subject,
    }))
    .unwrap()
}

fn release(w: &World, revision: u64, digest: &str) -> MaterialCheckReleaseInput {
    serde_json::from_value(json!({
        "slot_id": w.f.slot.id, "expected_revision": revision, "digest": digest,
    }))
    .unwrap()
}

/// The owner's key used by an agent through its connection.
fn agent(w: &World) -> Ctx {
    let Actor::Human { user_id } = w.ctx.actor else {
        unreachable!("the world's caller is its owner")
    };
    let connection_id = AgentConnectionId::new_v7();
    Ctx {
        actor: Actor::Agent {
            connection_id,
            user_id,
        },
        agent_connection_id: Some(connection_id),
        ..w.ctx.clone()
    }
}

/// The material hold `studio.pending` lists for the fixture slot, if any.
async fn hold(w: &World) -> Option<work::Blocker> {
    work::pending(&w.d, &w.ctx)
        .await
        .unwrap()
        .blockers
        .into_iter()
        .find(|b| b.reason == "material_check_hold")
}

#[tokio::test]
async fn a_caption_naming_another_olays_place_is_submitted_and_held_until_a_human_releases_it() {
    let (w, x) = publishing_world().await;
    let (m, subject) = w.stored().await;
    let moda = other_olay(&w, "Moda buluşması", Some("Moda Sahnesi, Kadıköy")).await;
    let out = piece_submit(
        &w.d,
        &w.ctx,
        piece(
            &w,
            "p",
            1,
            &m,
            subject,
            "Bu hafta Moda Sahnesi'nde boyuyoruz",
        ),
    )
    .await
    .expect("caption findings never refuse a submission");
    let check = out.material_check.expect("the piece shows materials");
    assert_eq!(check.revision, 2);
    assert!(check.hard.is_empty());
    assert!(!check.released);
    assert!(check.holds);
    assert_eq!(check.findings.len(), 1);
    let f = &check.findings[0];
    assert_eq!(f.code.code(), "names_other_olay");
    assert_eq!(f.olay_id, Some(moda.id));
    assert_eq!(f.matched, "moda sahnesi");
    assert_eq!(check.digest.len(), 64);
    assert!(
        check
            .digest
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
    );
    // `studio.slot_get` shows the same check.
    let got = work::slot_get(&w.d, &w.ctx, w.f.slot.id).await.unwrap();
    let shown = serde_json::to_value(&got).unwrap()["material_check"].clone();
    assert_eq!(shown["digest"], json!(check.digest));
    assert_eq!(shown["findings"][0]["code"], "names_other_olay");
    assert_eq!(shown["released"], false);

    // Held at publish: nothing sent, no attempt, no failed run; pending says why.
    x.push_publish(Ok(receipt()));
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 0);
    assert_eq!(sends(&x), 0);
    assert!(w.uow.snapshot().studio.attempts.is_empty());
    let b = hold(&w).await.expect("a material hold");
    assert_eq!(b.next_action.as_deref(), Some("fix_piece_or_release"));
    let findings = b.details.unwrap();
    assert_eq!(findings.as_array().unwrap().len(), 1);
    assert_eq!(
        (
            findings[0]["kind"].clone(),
            findings[0]["code"].clone(),
            findings[0]["olay_id"].clone()
        ),
        (json!("caption"), json!("names_other_olay"), json!(moda.id))
    );

    // Not an agent, not a stale revision, not another digest.
    let e = material_check_release(&w.d, &agent(&w), release(&w, 2, &check.digest))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden);
    let e = material_check_release(&w.d, &w.ctx, release(&w, 1, &check.digest))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    let e = material_check_release(&w.d, &w.ctx, release(&w, 2, &"0".repeat(64)))
        .await
        .unwrap_err();
    assert_eq!(
        (e.code, reason(&e)),
        (ErrorCode::Conflict, "findings_changed")
    );
    let e = material_check_release(&w.d, &w.ctx, release(&w, 2, "not-a-digest"))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Validation);
    assert!(
        w.uow.snapshot().materials.releases.is_empty(),
        "nothing released"
    );

    // The owner releases the findings as shown.
    let before = w.uow.snapshot().ledger.len();
    let out = material_check_release(&w.d, &w.ctx, release(&w, 2, &check.digest))
        .await
        .unwrap();
    let after = out.material_check.unwrap();
    assert!(after.released && !after.holds);
    let state = w.uow.snapshot();
    assert_eq!(state.ledger.len(), before + 1);
    let entry = &state.ledger.last().unwrap().entry;
    assert_eq!(entry.action.as_str(), "studio.material.check_released");
    assert_eq!(
        entry.payload,
        json!({"slot_id":w.f.slot.id,"revision":2,"digest":check.digest,
            "codes":["names_other_olay"]})
    );
    let text = state
        .ledger
        .iter()
        .map(|row| row.entry.payload.to_string())
        .collect::<String>()
        .to_lowercase();
    assert!(!text.contains("moda") && !text.contains("boyuyoruz"));
    // Releasing again changes nothing.
    material_check_release(&w.d, &w.ctx, release(&w, 2, &check.digest))
        .await
        .unwrap();
    assert_eq!(w.uow.snapshot().ledger.len(), before + 1);

    assert!(hold(&w).await.is_none());
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 1);
    assert_eq!(sends(&x), 1);
}

#[tokio::test]
async fn a_new_revision_or_a_changed_finding_needs_a_new_release() {
    let (w, x) = publishing_world().await;
    let (m, subject) = w.stored().await;
    let moda = other_olay(&w, "Moda buluşması", Some("Moda Sahnesi")).await;
    let text = "Moda Sahnesi'nde boyuyoruz";
    let first = piece_submit(&w.d, &w.ctx, piece(&w, "p1", 1, &m, subject, text))
        .await
        .unwrap()
        .material_check
        .unwrap();
    material_check_release(&w.d, &w.ctx, release(&w, 2, &first.digest))
        .await
        .unwrap();
    // The same caption again is another revision: the release was for revision 2.
    let second = piece_submit(&w.d, &w.ctx, piece(&w, "p2", 2, &m, subject, text))
        .await
        .unwrap()
        .material_check
        .unwrap();
    assert_eq!((second.revision, second.released), (3, false));
    assert_eq!(second.digest, first.digest, "the same findings");
    x.push_publish(Ok(receipt()));
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 0);
    material_check_release(&w.d, &w.ctx, release(&w, 3, &second.digest))
        .await
        .unwrap();
    // A finding that changes after the release (the other olay's place renamed, so the caption
    // now names another part of it) holds again: the release named other findings.
    w.uow.edit(|s| {
        for o in s.materials.olays.iter_mut() {
            if o.id == moda.id {
                o.place = Some("Moda Sahnesi, Boyuyoruz Salonu".into());
                o.title = "Boyuyoruz".into();
            }
        }
    });
    let changed = work::slot_get(&w.d, &w.ctx, w.f.slot.id)
        .await
        .unwrap()
        .material_check
        .unwrap();
    assert_ne!(changed.digest, second.digest);
    assert!(!changed.released && changed.holds);
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 0);
    let e = material_check_release(&w.d, &w.ctx, release(&w, 3, &second.digest))
        .await
        .unwrap_err();
    assert_eq!(reason(&e), "findings_changed");
    material_check_release(&w.d, &w.ctx, release(&w, 3, &changed.digest))
        .await
        .unwrap();
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 1);
    assert_eq!(sends(&x), 1);
}

#[tokio::test]
async fn a_hard_finding_is_never_releasable_even_beside_a_released_caption() {
    let (w, x) = publishing_world().await;
    let (m, subject) = w.stored().await;
    other_olay(&w, "Moda buluşması", Some("Moda Sahnesi")).await;
    let check = piece_submit(
        &w.d,
        &w.ctx,
        piece(&w, "p", 1, &m, subject, "Moda Sahnesi'nde boyuyoruz"),
    )
    .await
    .unwrap()
    .material_check
    .unwrap();
    material_check_release(&w.d, &w.ctx, release(&w, 2, &check.digest))
        .await
        .unwrap();
    // The material's permission revoked after the release.
    w.uow.edit(|s| {
        for mm in s.materials.materials.iter_mut() {
            if mm.id == m.id {
                mm.share.as_mut().unwrap().permission = SharePermission::NotShareable;
            }
        }
    });
    x.push_publish(Ok(receipt()));
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 0);
    assert_eq!(sends(&x), 0);
    let b = hold(&w).await.unwrap();
    assert_eq!(b.next_action.as_deref(), Some("fix_piece"));
    let findings = b.details.unwrap();
    assert_eq!(
        (findings[0]["kind"].clone(), findings[0]["code"].clone()),
        (json!("hard"), json!("not_shareable"))
    );
    assert_eq!(
        findings.as_array().unwrap().len(),
        1,
        "the released caption finding is not listed"
    );
    let shown = work::slot_get(&w.d, &w.ctx, w.f.slot.id)
        .await
        .unwrap()
        .material_check
        .unwrap();
    assert_eq!(shown.hard.len(), 1);
    assert_eq!(shown.hard[0].code, "not_shareable");
    assert!(shown.released && shown.holds);
    let e = material_check_release(&w.d, &w.ctx, release(&w, 2, &check.digest))
        .await
        .unwrap_err();
    assert_eq!(
        (e.code, reason(&e)),
        (ErrorCode::Conflict, "hard_findings_not_releasable")
    );
}

#[tokio::test]
async fn a_caption_without_findings_publishes_and_has_nothing_to_release() {
    let (w, x) = publishing_world().await;
    let (m, subject) = w.stored().await;
    other_olay(&w, "Moda buluşması", Some("Moda Sahnesi")).await;
    let check = piece_submit(
        &w.d,
        &w.ctx,
        piece(&w, "p", 1, &m, subject, "Atölyemizden bir an"),
    )
    .await
    .unwrap()
    .material_check
    .unwrap();
    assert!(check.findings.is_empty() && check.hard.is_empty() && !check.holds);
    let e = material_check_release(&w.d, &w.ctx, release(&w, 2, &check.digest))
        .await
        .unwrap_err();
    assert_eq!(
        (e.code, reason(&e)),
        (ErrorCode::Conflict, "no_caption_findings")
    );
    x.push_publish(Ok(receipt()));
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 1);
}

#[tokio::test]
async fn an_adaptations_text_is_checked_too() {
    let (w, x) = publishing_world().await;
    let (m, subject) = w.stored().await;
    other_olay(&w, "Moda buluşması", Some("Moda Sahnesi")).await;
    let mut i = piece(&w, "p", 1, &m, subject, "Atölyemizden bir an");
    let account = {
        let mut r = w.uow.tenant(w.f.ws).await.unwrap();
        r.capabilities()
            .find(w.f.slot.capability_id)
            .await
            .unwrap()
            .unwrap()
            .external_id
            .unwrap()
    };
    i.adaptations.insert(
        account,
        jt_studio::ChannelContent {
            text: "Moda Sahnesi'nde".into(),
            media: vec![jt_studio::MediaAsset::File { id: m.file_id }],
            link: None,
            privacy: None,
        },
    );
    let check = piece_submit(&w.d, &w.ctx, i)
        .await
        .unwrap()
        .material_check
        .unwrap();
    assert_eq!(check.findings[0].code.code(), "names_other_olay");
    x.push_publish(Ok(receipt()));
    assert_eq!(publish::publish_due(&w.d, w.f.ws).await.unwrap(), 0);
}

/// A `product_only` material's client is named by the person's current name in the inbox; an
/// erased person has none to name.
#[tokio::test]
async fn a_product_only_materials_client_is_named_by_their_current_name() {
    let (w, _) = publishing_world().await;
    let (m, subject) = w.stored().await;
    let ayse = people::create(
        &w.d,
        &w.ctx,
        serde_json::from_value(json!({"display_name":"Ayşe Yılmaz","source":"form",
            "identities":[{"channel":"email","value":"ayse@example.com"}]}))
        .unwrap(),
    )
    .await
    .unwrap()
    .person
    .id;
    w.uow.edit(|s| {
        for o in s.materials.olays.iter_mut() {
            if Some(o.id) == m.olay_id() {
                o.client = Some(OlayClient {
                    person_id: Some(ayse.0),
                    organization: None,
                });
            }
        }
        for mm in s.materials.materials.iter_mut() {
            if mm.id == m.id {
                mm.share.as_mut().unwrap().permission = SharePermission::ProductOnly;
            }
        }
    });
    let check = piece_submit(
        &w.d,
        &w.ctx,
        piece(&w, "p", 1, &m, subject, "Ayşe Hanım'ın figürü hazır"),
    )
    .await
    .unwrap()
    .material_check
    .unwrap();
    assert_eq!(check.findings.len(), 1);
    assert_eq!(check.findings[0].code.code(), "client_named_product_only");
    assert_eq!(check.findings[0].matched, "ayse");
    w.uow.edit(|s| {
        for p in s.inbox.people.iter_mut() {
            if p.id == ayse {
                p.erased_at = Some(jt_testkit::fakes::FIXED_NOW);
            }
        }
    });
    let check = work::slot_get(&w.d, &w.ctx, w.f.slot.id)
        .await
        .unwrap()
        .material_check
        .unwrap();
    assert!(check.findings.is_empty(), "{:?}", check.findings);
}

/// A submission's request key keeps neither the piece nor its material check, which hold the
/// caption and what it matched (a client's name): a replay reads both as they are now, so after
/// the person's erasure it names no one (spec D40).
#[tokio::test]
async fn a_submissions_replay_reads_its_piece_and_check_as_they_are_now() {
    let (w, _) = publishing_world().await;
    let (m, subject) = w.stored().await;
    let ayse = people::create(
        &w.d,
        &w.ctx,
        serde_json::from_value(json!({"display_name":"Ayşe Yılmaz","source":"form",
            "identities":[{"channel":"email","value":"ayse@example.com"}]}))
        .unwrap(),
    )
    .await
    .unwrap()
    .person
    .id;
    w.uow.edit(|s| {
        for o in s.materials.olays.iter_mut() {
            if Some(o.id) == m.olay_id() {
                o.client = Some(OlayClient {
                    person_id: Some(ayse.0),
                    organization: None,
                });
            }
        }
        for mm in s.materials.materials.iter_mut() {
            if mm.id == m.id {
                mm.share.as_mut().unwrap().permission = SharePermission::ProductOnly;
            }
        }
    });
    let i = piece(&w, "p", 1, &m, subject, "Ayşe Hanım'ın figürü hazır");
    let first = piece_submit(&w.d, &w.ctx, i.clone()).await.unwrap();
    assert_eq!(
        first.material_check.as_ref().unwrap().findings[0].matched,
        "ayse"
    );
    let receipts: Vec<String> = w
        .uow
        .snapshot()
        .studio
        .receipts
        .iter()
        .filter(|(_, action, ..)| action == "studio.piece_submit")
        .map(|(.., v)| v.to_string())
        .collect();
    assert_eq!(receipts.len(), 1);
    for kept in &receipts {
        assert!(
            !kept.contains("ayse") && !kept.contains("Ayşe"),
            "{kept}"
        );
    }
    w.uow.edit(|s| {
        for p in s.inbox.people.iter_mut() {
            if p.id == ayse {
                p.erased_at = Some(jt_testkit::fakes::FIXED_NOW);
            }
        }
    });
    let again = piece_submit(&w.d, &w.ctx, i).await.unwrap();
    assert_eq!(again.slot.id, first.slot.id);
    assert_eq!(again.slot.revision, first.slot.revision);
    assert_eq!(
        again.piece.as_ref().map(|p| (p.id, p.revision)),
        first.piece.as_ref().map(|p| (p.id, p.revision))
    );
    let check = again.material_check.unwrap();
    assert!(check.findings.is_empty(), "{:?}", check.findings);
}

#[tokio::test]
async fn a_piece_with_no_recorded_materials_shows_no_material_check() {
    let (w, _) = publishing_world().await;
    let shown = work::slot_get(&w.d, &w.ctx, w.f.slot.id).await.unwrap();
    assert!(
        shown.material_check.is_some(),
        "the fixture piece's material"
    );
    w.uow.edit(|s| s.materials.piece_uses.clear());
    let shown = work::slot_get(&w.d, &w.ctx, w.f.slot.id).await.unwrap();
    assert!(shown.material_check.is_none());
    let v: Value = serde_json::to_value(&shown).unwrap();
    assert!(v.get("material_check").is_none());
    // Holding with `no_material` is a hard finding: nothing to release.
    let b = hold(&w).await.unwrap();
    assert_eq!(b.next_action.as_deref(), Some("fix_piece"));
    assert_eq!(b.details.unwrap()[0]["kind"], "hard");
    let e = material_check_release(&w.d, &w.ctx, release(&w, 1, &"0".repeat(64)))
        .await
        .unwrap_err();
    assert_eq!(reason(&e), "hard_findings_not_releasable");
}
