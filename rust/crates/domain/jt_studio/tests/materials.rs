//! The materials library's pure rules (spec 2026-11-03 §4): olays, materials, the calendar,
//! eligibility, selection and the çekim listesi.
use jt_ledger::Actor;
use jt_studio::*;
use jt_tenancy::{UserId, WorkspaceId};
use std::collections::BTreeSet;
use time::macros::{date, datetime};
use time::{Date, OffsetDateTime};
use uuid::Uuid;

fn ws() -> WorkspaceId {
    WorkspaceId(Uuid::from_u128(1))
}
fn owner() -> UserId {
    UserId(Uuid::from_u128(2))
}
fn at(day: Date) -> OffsetDateTime {
    day.with_hms(12, 0, 0).unwrap().assume_utc()
}

fn olay(n: u128, kind: OlayKind, starts: Date, ends: Date) -> Olay {
    Olay {
        id: OlayId(Uuid::from_u128(100 + n)),
        workspace_id: ws(),
        kind,
        title: format!("Olay {n}"),
        starts_on: starts,
        ends_on: ends,
        place: None,
        client: None,
        notes: String::new(),
        occasion: kind.is_seasonal().then(|| "yilbasi".to_owned()),
        status: OlayStatus::Confirmed,
        confirmed: Some(HumanMark {
            by: owner(),
            at: datetime!(2025-01-01 0:00 UTC),
        }),
        revision: 1,
        created_at: datetime!(2025-01-01 0:00 UTC),
    }
}

fn material(n: u128, binding: Binding) -> Material {
    Material {
        id: MaterialId(Uuid::from_u128(200 + n)),
        workspace_id: ws(),
        file_id: FileId(Uuid::from_u128(300 + n)),
        mime: "image/jpeg".into(),
        title: String::new(),
        origin: Origin::Real,
        binding,
        freed: None,
        share: Some(ShareDecision {
            permission: SharePermission::Shareable,
            by: Some(owner()),
            at: datetime!(2025-01-01 0:00 UTC),
        }),
        tags: Tags {
            quality: Some(Quality::Publishable),
            ..Tags::default()
        },
        tags_reviewed_by: None,
        people: BTreeSet::new(),
        captured_at: None,
        created_by: Actor::Human { user_id: owner() },
        revision: 1,
        created_at: datetime!(2025-01-01 0:00 UTC),
        erased_at: None,
    }
}

fn bound(o: &Olay) -> Binding {
    Binding::Olay { olay_id: o.id }
}

fn freed() -> Option<HumanMark> {
    Some(HumanMark {
        by: owner(),
        at: datetime!(2025-01-02 0:00 UTC),
    })
}

fn calendar() -> Calendar {
    Calendar::effective(2024..=2028, &[])
}

fn check(
    m: &Material,
    role: UseRole,
    s: Subject,
    olays: &[Olay],
    day: Date,
) -> Result<(), Refusal> {
    let cal = calendar();
    check_use(
        m,
        role,
        &s,
        &UseContext {
            at: at(day),
            olays,
            calendar: &cal,
        },
    )
}

#[test]
fn an_olay_names_its_occasion_exactly_when_seasonal_and_is_confirmed_by_a_human() {
    let mut o = olay(
        1,
        OlayKind::Workshop,
        date!(2026 - 11 - 16),
        date!(2026 - 11 - 16),
    );
    o.validate().unwrap();
    o.occasion = Some("yilbasi".into());
    assert_eq!(o.validate(), Err(StudioError::InvalidMaterial("occasion")));
    let mut s = olay(
        2,
        OlayKind::Season,
        date!(2026 - 11 - 1),
        date!(2026 - 12 - 31),
    );
    s.validate().unwrap();
    s.occasion = None;
    assert_eq!(s.validate(), Err(StudioError::InvalidMaterial("occasion")));
    let mut p = olay(3, OlayKind::Other, date!(2026 - 1 - 1), date!(2026 - 1 - 1));
    p.status = OlayStatus::Proposed;
    assert_eq!(p.validate(), Err(StudioError::InvalidMaterial("status")));
    p.confirmed = None;
    p.validate().unwrap();
    let mut long = olay(4, OlayKind::Order, date!(2026 - 1 - 1), date!(2027 - 1 - 2));
    assert_eq!(long.validate(), Err(StudioError::InvalidMaterial("dates")));
    long.ends_on = date!(2025 - 12 - 31);
    assert_eq!(long.validate(), Err(StudioError::InvalidMaterial("dates")));
    let mut c = olay(5, OlayKind::Order, date!(2026 - 1 - 1), date!(2026 - 1 - 1));
    c.client = Some(OlayClient {
        person_id: None,
        organization: None,
    });
    assert_eq!(c.validate(), Err(StudioError::InvalidMaterial("client")));
}

#[test]
fn a_real_genel_material_is_freed_and_only_an_ai_image_takes_an_agents_permission() {
    let mut m = material(1, Binding::Genel);
    assert_eq!(m.validate(), Err(StudioError::InvalidMaterial("binding")));
    m.freed = freed();
    m.validate().unwrap();
    m.share.as_mut().unwrap().by = None;
    assert_eq!(m.validate(), Err(StudioError::InvalidMaterial("share")));
    let mut ai = material(2, Binding::Genel);
    ai.origin = Origin::AiGenerated {
        generator: "codex".into(),
    };
    ai.share.as_mut().unwrap().by = None;
    ai.validate().unwrap();
    ai.tags.depicts.insert(Depicts::ClientLogo);
    assert_eq!(ai.validate(), Err(StudioError::InvalidMaterial("share")));
    ai.origin = Origin::AiGenerated {
        generator: "Codex!".into(),
    };
    assert_eq!(
        ai.validate(),
        Err(StudioError::InvalidMaterial("generator"))
    );
}

#[test]
fn tag_keys_round_trip_through_their_serde_names() {
    for g in ProductGroup::ALL {
        assert_eq!(ProductGroup::parse(g.key()), Some(*g));
        assert_eq!(serde_json::to_value(g).unwrap(), g.key());
    }
    for d in Door::ALL {
        assert_eq!(Door::parse(d.key()), Some(*d));
    }
    for c in ContentType::ALL {
        assert_eq!(serde_json::to_value(c).unwrap(), c.key());
    }
    assert_eq!(ProductGroup::ALL.len(), 6);
    assert_eq!(Door::ALL.len(), 3);
    assert_eq!(ContentType::ALL.len(), 7);
}

#[test]
fn the_turkish_defaults_compute_their_days_and_leave_the_lunar_holidays_undated() {
    for (year, mothers, fathers) in [
        (2025, date!(2025 - 05 - 11), date!(2025 - 06 - 15)),
        (2026, date!(2026 - 05 - 10), date!(2026 - 06 - 21)),
        (2027, date!(2027 - 05 - 09), date!(2027 - 06 - 20)),
        (2028, date!(2028 - 05 - 14), date!(2028 - 06 - 18)),
    ] {
        let d = turkish_defaults(year);
        let find = |k: &str| d.iter().find(|e| e.key == k).unwrap();
        assert_eq!(find("anneler_gunu").window_end, Some(mothers));
        assert_eq!(find("babalar_gunu").window_end, Some(fathers));
        assert_eq!(
            find("sevgililer_gunu").window_end,
            Some(Date::from_calendar_date(year, time::Month::February, 14).unwrap())
        );
        for undated in [
            "ramazan_bayrami",
            "kurban_bayrami",
            "mezuniyet",
            "kulup_sezon_basi",
        ] {
            assert_eq!(find(undated).window(), None, "{undated} {year}");
        }
        for e in &d {
            e.validate().unwrap();
        }
    }
}

#[test]
fn a_workspace_row_replaces_its_default_and_adds_its_own_keys() {
    let ramazan = CalendarEntry {
        key: "ramazan_bayrami".into(),
        year: 2027,
        name: "Ramazan Bayramı".into(),
        kind: OccasionKind::SpecialDay,
        window_start: Some(date!(2027 - 02 - 25)),
        window_end: Some(date!(2027 - 03 - 11)),
        lead_days: Some(28),
        enabled: true,
    };
    let mut off = turkish_defaults(2027)
        .into_iter()
        .find(|e| e.key == "cadilar_bayrami")
        .unwrap();
    off.enabled = false;
    let cal = Calendar::effective(2027..=2027, &[ramazan.clone(), off]);
    assert_eq!(cal.entry("ramazan_bayrami", 2027), Some(&ramazan));
    assert_eq!(cal.windows("cadilar_bayrami").count(), 0);
    assert_eq!(
        cal.years_containing("ramazan_bayrami", date!(2027 - 03 - 01)),
        [2027]
    );
}

#[test]
fn an_olay_shot_before_its_window_belongs_to_that_windows_year() {
    let cal = calendar();
    assert_eq!(
        cal.season_year("yilbasi", date!(2025 - 11 - 10)),
        Some(2025)
    );
    assert_eq!(
        cal.season_year("yilbasi", date!(2025 - 12 - 20)),
        Some(2025)
    );
    assert_eq!(
        cal.season_year("yilbasi", date!(2026 - 01 - 05)),
        Some(2026)
    );
    assert_eq!(
        cal.season_year("ramazan_bayrami", date!(2026 - 01 - 05)),
        None
    );
}

#[test]
fn every_refusal_code() {
    let a = olay(
        1,
        OlayKind::Workshop,
        date!(2026 - 11 - 16),
        date!(2026 - 11 - 16),
    );
    let b = olay(
        2,
        OlayKind::Workshop,
        date!(2026 - 11 - 30),
        date!(2026 - 11 - 30),
    );
    let season = olay(
        3,
        OlayKind::Season,
        date!(2025 - 11 - 10),
        date!(2025 - 12 - 31),
    );
    let mut proposed = olay(
        4,
        OlayKind::Workshop,
        date!(2026 - 12 - 5),
        date!(2026 - 12 - 5),
    );
    proposed.status = OlayStatus::Proposed;
    proposed.confirmed = None;
    let olays = [a.clone(), b.clone(), season.clone(), proposed.clone()];
    let day = date!(2026 - 11 - 20);
    let anchor = UseRole::Anchor;
    let of = |o: &Olay| Subject::Olay { olay_id: o.id };

    let m = material(1, bound(&a));
    assert_eq!(check(&m, anchor, of(&a), &olays, day), Ok(()));
    // Workshop A's footage never appears in workshop B's content.
    assert_eq!(
        check(&m, anchor, of(&b), &olays, day),
        Err(Refusal::OtherOlay)
    );
    assert_eq!(
        check(&m, anchor, Subject::Generic, &olays, day),
        Err(Refusal::NotFreed)
    );
    assert_eq!(
        check(&m, anchor, Subject::Archive { olay_id: a.id }, &olays, day),
        Err(Refusal::ArchiveNotSeason)
    );
    let mut erased = m.clone();
    erased.erased_at = Some(at(day));
    assert_eq!(
        check(&erased, anchor, of(&a), &olays, day),
        Err(Refusal::Erased)
    );
    let mut unset = m.clone();
    unset.share = None;
    assert_eq!(
        check(&unset, anchor, of(&a), &olays, day),
        Err(Refusal::ShareUnset)
    );
    let mut no = m.clone();
    no.share.as_mut().unwrap().permission = SharePermission::NotShareable;
    assert_eq!(
        check(&no, anchor, of(&a), &olays, day),
        Err(Refusal::NotShareable)
    );
    let mut crop = m.clone();
    crop.tags.quality = Some(Quality::NeedsCrop);
    assert_eq!(
        check(&crop, anchor, of(&a), &olays, day),
        Err(Refusal::Quality)
    );
    crop.tags.quality = None;
    assert_eq!(
        check(&crop, anchor, of(&a), &olays, day),
        Err(Refusal::Quality)
    );
    let gone = material(
        2,
        Binding::Olay {
            olay_id: OlayId(Uuid::from_u128(999)),
        },
    );
    assert_eq!(
        check(
            &gone,
            anchor,
            Subject::Olay {
                olay_id: OlayId(Uuid::from_u128(999))
            },
            &olays,
            day
        ),
        Err(Refusal::OlayMissing)
    );
    let p = material(3, bound(&proposed));
    assert_eq!(
        check(&p, anchor, of(&proposed), &olays, day),
        Err(Refusal::OlayUnconfirmed)
    );

    // Freed: generic only.
    let mut f = material(4, bound(&a));
    f.freed = freed();
    assert_eq!(check(&f, anchor, Subject::Generic, &olays, day), Ok(()));
    assert_eq!(
        check(&f, anchor, of(&b), &olays, day),
        Err(Refusal::OtherOlay)
    );
    let mut g = material(5, Binding::Genel);
    g.freed = freed();
    assert_eq!(check(&g, anchor, Subject::Generic, &olays, day), Ok(()));
    assert_eq!(
        check(&g, anchor, of(&a), &olays, day),
        Err(Refusal::GenelGenericOnly)
    );

    // Season: its own year inside the window; a later year only as archive; never out of season.
    let s = material(6, bound(&season));
    let sub = of(&season);
    let arch = Subject::Archive { olay_id: season.id };
    assert_eq!(
        check(&s, anchor, sub, &olays, date!(2025 - 12 - 15)),
        Ok(())
    );
    assert_eq!(
        check(&s, anchor, sub, &olays, date!(2026 - 03 - 01)),
        Err(Refusal::OutOfSeason)
    );
    assert_eq!(
        check(&s, anchor, sub, &olays, date!(2026 - 12 - 15)),
        Err(Refusal::UseArchive)
    );
    assert_eq!(
        check(&s, anchor, arch, &olays, date!(2026 - 12 - 15)),
        Ok(())
    );
    assert_eq!(
        check(&s, anchor, arch, &olays, date!(2025 - 12 - 15)),
        Err(Refusal::OutOfSeason)
    );
    assert_eq!(
        check(&s, anchor, arch, &olays, date!(2026 - 07 - 15)),
        Err(Refusal::OutOfSeason)
    );

    // Sensitive content with an agent's permission.
    let mut ai = material(7, Binding::Genel);
    ai.origin = Origin::AiGenerated {
        generator: "codex".into(),
    };
    ai.share.as_mut().unwrap().by = None;
    ai.tags.depicts.insert(Depicts::Face);
    assert_eq!(
        check(&ai, UseRole::Support, Subject::Generic, &olays, day),
        Err(Refusal::SensitiveNeedsHuman)
    );
    ai.tags.depicts.clear();
    assert_eq!(check(&ai, UseRole::Support, of(&a), &olays, day), Ok(()));
    assert_eq!(
        check(&ai, anchor, of(&a), &olays, day),
        Err(Refusal::AiNotAnchor)
    );

    // An AI poster announces its own olay until it ends, never a recap or another olay.
    let mut poster = ai.clone();
    poster.id = MaterialId(Uuid::from_u128(208));
    poster.binding = bound(&b);
    assert_eq!(check(&poster, anchor, of(&b), &olays, day), Ok(()));
    assert_eq!(
        check(&poster, anchor, of(&b), &olays, date!(2026 - 12 - 01)),
        Err(Refusal::AiOlayPast)
    );
    assert_eq!(
        check(&poster, anchor, of(&a), &olays, day),
        Err(Refusal::OtherOlay)
    );
}

#[test]
fn a_piece_needs_an_anchor_and_every_material_to_pass() {
    let a = olay(
        1,
        OlayKind::Workshop,
        date!(2026 - 11 - 16),
        date!(2026 - 11 - 16),
    );
    let olays = [a.clone()];
    let cal = calendar();
    let cx = UseContext {
        at: at(date!(2026 - 11 - 17)),
        olays: &olays,
        calendar: &cal,
    };
    let subject = Subject::Olay { olay_id: a.id };
    let real = material(1, bound(&a));
    let mut ai = material(2, Binding::Genel);
    ai.origin = Origin::AiGenerated {
        generator: "codex".into(),
    };
    assert_eq!(
        piece_roles(&[&real, &ai], &subject, &cx),
        Ok(vec![(real.id, UseRole::Anchor), (ai.id, UseRole::Support)])
    );
    assert_eq!(
        piece_roles(&[&ai], &subject, &cx),
        Err(PieceRefusal::NoAnchor)
    );
    let mut unset = material(3, bound(&a));
    unset.share = None;
    assert_eq!(
        piece_roles(&[&real, &unset], &subject, &cx),
        Err(PieceRefusal::Refused(vec![(unset.id, Refusal::ShareUnset)]))
    );
    assert_eq!(piece_roles(&[], &subject, &cx), Err(PieceRefusal::NoAnchor));
}

#[test]
fn a_slot_need_reads_tag_keys_from_the_strategys_keys() {
    let need = SlotNeed::from_keys("figur.bitmis_urun", "toplu_siparis");
    assert_eq!(need.product_groups, BTreeSet::from([ProductGroup::Figur]));
    assert_eq!(
        need.content_types,
        BTreeSet::from([ContentType::BitmisUrun])
    );
    assert_eq!(need.doors, BTreeSet::from([Door::TopluSiparis]));
    assert!(SlotNeed::from_keys("reels_hook", "kulup_yoneticileri").is_empty());
    let mut tags = Tags::default();
    assert!(!need.matches(&tags));
    tags.product_groups.insert(ProductGroup::Figur);
    tags.content_types.insert(ContentType::BitmisUrun);
    tags.doors.insert(Door::TopluSiparis);
    tags.doors.insert(Door::KisiyeOzel);
    assert!(need.matches(&tags));
}

#[test]
fn selection_prefers_season_then_upcoming_then_recap_then_archive_then_generic() {
    let day = date!(2026 - 12 - 10);
    let season_now = {
        let mut o = olay(
            1,
            OlayKind::Season,
            date!(2026 - 11 - 20),
            date!(2026 - 12 - 31),
        );
        o.occasion = Some("yilbasi".into());
        o
    };
    let season_last = olay(
        2,
        OlayKind::Season,
        date!(2025 - 11 - 20),
        date!(2025 - 12 - 31),
    );
    let upcoming = olay(
        3,
        OlayKind::Workshop,
        date!(2026 - 12 - 20),
        date!(2026 - 12 - 20),
    );
    let recent = olay(
        4,
        OlayKind::Workshop,
        date!(2026 - 11 - 30),
        date!(2026 - 11 - 30),
    );
    let olays = [
        season_now.clone(),
        season_last.clone(),
        upcoming.clone(),
        recent.clone(),
    ];
    let cal = calendar();
    let cx = UseContext {
        at: at(day),
        olays: &olays,
        calendar: &cal,
    };
    let policy = MaterialPolicy::default();
    let need = SlotNeed::default();
    let mut generic = material(5, Binding::Genel);
    generic.freed = freed();
    let mut all = vec![
        generic.clone(),
        material(4, bound(&season_last)),
        material(3, bound(&recent)),
        material(2, bound(&upcoming)),
        material(1, bound(&season_now)),
    ];
    let order = [
        (
            all[4].id,
            Subject::Olay {
                olay_id: season_now.id,
            },
        ),
        (
            all[3].id,
            Subject::Olay {
                olay_id: upcoming.id,
            },
        ),
        (all[2].id, Subject::Olay { olay_id: recent.id }),
        (
            all[1].id,
            Subject::Archive {
                olay_id: season_last.id,
            },
        ),
        (generic.id, Subject::Generic),
    ];
    for (id, subject) in order {
        let pick = select_anchor(&need, &all, &[], &policy, &cx).unwrap();
        assert_eq!(
            pick,
            Pick {
                material_id: id,
                subject
            }
        );
        all.retain(|m| m.id != id);
    }
    assert_eq!(select_anchor(&need, &all, &[], &policy, &cx), None);
}

#[test]
fn selection_avoids_recent_use_and_needs_the_tags() {
    let a = olay(
        1,
        OlayKind::Workshop,
        date!(2026 - 12 - 20),
        date!(2026 - 12 - 20),
    );
    let olays = [a.clone()];
    let cal = calendar();
    let now = at(date!(2026 - 12 - 10));
    let cx = UseContext {
        at: now,
        olays: &olays,
        calendar: &cal,
    };
    let policy = MaterialPolicy::default();
    let one = material(1, bound(&a));
    let two = material(2, bound(&a));
    let used = [MaterialUsage {
        material_id: one.id,
        at: now - time::Duration::days(3),
    }];
    let need = SlotNeed::default();
    let pick = select_anchor(&need, &[one.clone(), two.clone()], &used, &policy, &cx).unwrap();
    assert_eq!(pick.material_id, two.id);
    // Only recently used ones left: still the least recently used, never none.
    let pick = select_anchor(&need, std::slice::from_ref(&one), &used, &policy, &cx).unwrap();
    assert_eq!(pick.material_id, one.id);
    let need = SlotNeed::from_keys("boyama", "");
    assert_eq!(select_anchor(&need, &[one, two], &[], &policy, &cx), None);
}

#[test]
fn shoot_request_keys_and_texts() {
    let h = jt_strategy::HypothesisId(Uuid::from_u128(9));
    assert_eq!(
        slot_request_key(h, "bitmis_urun", date!(2026 - 11 - 02)),
        format!("slot:{h}:bitmis_urun:2026-11-02")
    );
    assert_eq!(season_request_key("yilbasi", 2026), "season:yilbasi:2026");
    assert_eq!(turkish_day(date!(2026 - 11 - 16)), "16 Kasım");
    assert_eq!(
        olay_request_text("atölyesi", date!(2026 - 11 - 16)),
        "16 Kasım atölyesi için afiş veya hazırlık fotoğrafı yükle."
    );
    assert!(season_request_text("Yılbaşı", date!(2026 - 12 - 01)).contains("1 Aralık"));
}
