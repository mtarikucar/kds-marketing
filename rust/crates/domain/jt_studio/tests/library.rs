//! The materials library's helpers for its use cases (spec 2026-11-03 §4.2, §5.3, §8, §9.3): the
//! capture time read from a medium's bytes, the olays it suggests, the retention rule, and the
//! ranking of what a slot may show.
use jt_ledger::Actor;
use jt_studio::*;
use jt_tenancy::{UserId, WorkspaceId};
use std::collections::BTreeSet;
use time::macros::{date, datetime};
use time::{Date, OffsetDateTime};
use uuid::Uuid;

/// A JPEG (with a JFIF segment first) whose EXIF names `date` as `DateTimeOriginal`, and `offset`
/// as `OffsetTimeOriginal` when given, in either byte order.
fn exif_jpeg(little: bool, date: &str, offset: Option<&str>) -> Vec<u8> {
    let w16 = |v: u16| {
        if little {
            v.to_le_bytes()
        } else {
            v.to_be_bytes()
        }
    };
    let w32 = |v: u32| {
        if little {
            v.to_le_bytes()
        } else {
            v.to_be_bytes()
        }
    };
    let mut tiff = Vec::new();
    tiff.extend_from_slice(if little { b"II" } else { b"MM" });
    tiff.extend_from_slice(&w16(42));
    tiff.extend_from_slice(&w32(8));
    // IFD0: the Exif sub-IFD pointer.
    let exif_at: u32 = 8 + 2 + 12 + 4;
    tiff.extend_from_slice(&w16(1));
    tiff.extend_from_slice(&w16(0x8769));
    tiff.extend_from_slice(&w16(4));
    tiff.extend_from_slice(&w32(1));
    tiff.extend_from_slice(&w32(exif_at));
    tiff.extend_from_slice(&w32(0));
    // The Exif IFD, then its values.
    let n: u16 = if offset.is_some() { 2 } else { 1 };
    let data_at = exif_at + 2 + 12 * u32::from(n) + 4;
    let date = format!("{date}\0");
    tiff.extend_from_slice(&w16(n));
    tiff.extend_from_slice(&w16(0x9003));
    tiff.extend_from_slice(&w16(2));
    tiff.extend_from_slice(&w32(date.len() as u32));
    tiff.extend_from_slice(&w32(data_at));
    let offset = offset.map(|o| format!("{o}\0"));
    if let Some(o) = &offset {
        tiff.extend_from_slice(&w16(0x9011));
        tiff.extend_from_slice(&w16(2));
        tiff.extend_from_slice(&w32(o.len() as u32));
        tiff.extend_from_slice(&w32(data_at + date.len() as u32));
    }
    tiff.extend_from_slice(&w32(0));
    tiff.extend_from_slice(date.as_bytes());
    if let Some(o) = &offset {
        tiff.extend_from_slice(o.as_bytes());
    }
    let mut out = vec![0xFF, 0xD8];
    out.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x10]);
    out.extend_from_slice(b"JFIF\0\x01\x02\0\0\x01\0\x01\0\0");
    let len = (2 + 6 + tiff.len()) as u16;
    out.extend_from_slice(&[0xFF, 0xE1]);
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(b"Exif\0\0");
    out.extend_from_slice(&tiff);
    out.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x02, 0x11, 0x22, 0xFF, 0xD9]);
    out
}

fn mp4_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut out = ((8 + payload.len()) as u32).to_be_bytes().to_vec();
    out.extend_from_slice(kind);
    out.extend_from_slice(payload);
    out
}

/// An MP4 whose `mvhd` (of `version`) names `created` seconds since 1904.
fn mp4(version: u8, created: u64) -> Vec<u8> {
    let mut mvhd = vec![version, 0, 0, 0];
    if version == 0 {
        mvhd.extend_from_slice(&(created as u32).to_be_bytes());
        mvhd.extend_from_slice(&(created as u32).to_be_bytes());
        mvhd.extend_from_slice(&1000u32.to_be_bytes());
        mvhd.extend_from_slice(&5000u32.to_be_bytes());
    } else {
        mvhd.extend_from_slice(&created.to_be_bytes());
        mvhd.extend_from_slice(&created.to_be_bytes());
        mvhd.extend_from_slice(&1000u32.to_be_bytes());
        mvhd.extend_from_slice(&5000u64.to_be_bytes());
    }
    mvhd.resize(mvhd.len() + 80, 0);
    let mut out = mp4_box(b"ftyp", b"isom\0\0\0\0isom");
    out.extend(mp4_box(b"moov", &mp4_box(b"mvhd", &mvhd)));
    out
}

/// Seconds from 1904-01-01 UTC to `at`.
fn since_1904(at: OffsetDateTime) -> u64 {
    (at.unix_timestamp() + 2_082_844_800) as u64
}

#[test]
fn a_jpeg_names_its_capture_time_in_either_byte_order() {
    let le = exif_jpeg(true, "2026:11:16 14:30:05", Some("+01:00"));
    assert_eq!(
        capture_time("image/jpeg", &le),
        Some(datetime!(2026-11-16 14:30:05 +01:00))
    );
    // No zone: Istanbul time.
    let be = exif_jpeg(false, "2026:11:16 14:30:05", None);
    assert_eq!(
        capture_time("IMAGE/JPEG", &be),
        Some(datetime!(2026-11-16 14:30:05 +03:00))
    );
    let west = exif_jpeg(false, "2026:01:02 03:04:05", Some("-05:30"));
    assert_eq!(
        capture_time("image/jpeg", &west),
        Some(datetime!(2026-01-02 03:04:05 -05:30))
    );
}

#[test]
fn a_jpeg_without_a_readable_time_names_none() {
    // A camera's unset clock, a bad date, a bad shape.
    for text in [
        "0000:00:00 00:00:00",
        "2026:02:30 10:00:00",
        "2026-11-16 14:30:05",
        "2026:11:16",
        "1969:12:31 23:00:00",
    ] {
        assert_eq!(
            capture_time("image/jpeg", &exif_jpeg(true, text, None)),
            None,
            "{text}"
        );
    }
    let good = exif_jpeg(true, "2026:11:16 14:30:05", None);
    // Truncated anywhere inside the EXIF segment.
    for cut in [3, 10, 30, 60, good.len() - 30] {
        assert_eq!(capture_time("image/jpeg", &good[..cut]), None, "{cut}");
    }
    // No EXIF at all, a PNG, a JPEG read as another type.
    let mut plain = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0, 0];
    plain.extend_from_slice(&[0xFF, 0xD9]);
    assert_eq!(capture_time("image/jpeg", &plain), None);
    assert_eq!(capture_time("image/png", &good), None);
    assert_eq!(capture_time("image/jpeg", b"\x89PNG\r\n\x1a\n"), None);
}

#[test]
fn a_video_names_its_mvhd_creation_time() {
    let at = datetime!(2026-11-16 11:30:00 UTC);
    assert_eq!(capture_time("video/mp4", &mp4(0, since_1904(at))), Some(at));
    assert_eq!(capture_time("video/mp4", &mp4(1, since_1904(at))), Some(at));
    // Not set, before 1970, or not an MP4.
    assert_eq!(capture_time("video/mp4", &mp4(0, 0)), None);
    assert_eq!(capture_time("video/mp4", &mp4(1, 1_000)), None);
    assert_eq!(capture_time("video/mp4", b"not a video at all"), None);
    let whole = mp4(0, since_1904(at));
    assert_eq!(capture_time("video/mp4", &whole[..whole.len() - 50]), None);
}

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

#[test]
fn months_move_on_the_calendar_and_end_on_a_shorter_months_last_day() {
    assert_eq!(add_months(date!(2026 - 11 - 16), 24), date!(2028 - 11 - 16));
    assert_eq!(add_months(date!(2026 - 11 - 16), 2), date!(2027 - 01 - 16));
    assert_eq!(add_months(date!(2024 - 02 - 29), 24), date!(2026 - 02 - 28));
    assert_eq!(add_months(date!(2026 - 01 - 31), 1), date!(2026 - 02 - 28));
    assert_eq!(add_months(date!(2026 - 12 - 31), 0), date!(2026 - 12 - 31));
}

#[test]
fn a_material_showing_people_is_kept_24_months_after_its_olay() {
    let o = olay(
        1,
        OlayKind::Workshop,
        date!(2024 - 05 - 01),
        date!(2024 - 05 - 03),
    );
    let mut m = material(1, Binding::Olay { olay_id: o.id });
    m.tags.depicts.insert(Depicts::Face);
    assert_eq!(m.kept_until(Some(o.ends_on)), date!(2026 - 05 - 03));
    assert!(!m.retention_due(Some(o.ends_on), at(date!(2026 - 05 - 03))));
    assert!(m.retention_due(Some(o.ends_on), at(date!(2026 - 05 - 04))));
    // Istanbul's day: 21:30 UTC on the last day is already the next day there.
    assert!(m.retention_due(Some(o.ends_on), datetime!(2026-05-03 21:30 UTC)));
    // A person named, a name or a child shown: personal data too.
    let mut named = material(2, Binding::Olay { olay_id: o.id });
    named.people.insert(Uuid::from_u128(9));
    assert!(named.retention_due(Some(o.ends_on), at(date!(2026 - 06 - 01))));
    let mut child = material(3, Binding::Olay { olay_id: o.id });
    child.tags.depicts.insert(Depicts::Child);
    assert!(child.retention_due(Some(o.ends_on), at(date!(2026 - 06 - 01))));
    // A logo or a corporate mark is no person: kept until the owner deletes it.
    let mut logo = material(4, Binding::Olay { olay_id: o.id });
    logo.tags.depicts.insert(Depicts::ClientLogo);
    assert!(!logo.retention_due(Some(o.ends_on), at(date!(2030 - 01 - 01))));
    assert!(!material(5, Binding::Genel).retention_due(None, at(date!(2030 - 01 - 01))));
    // An erased material is gone already.
    let erased = m.redacted(at(date!(2025 - 01 - 01)));
    assert!(!erased.retention_due(Some(o.ends_on), at(date!(2030 - 01 - 01))));
    // A genel material counts from the day it was added.
    let mut genel = material(6, Binding::Genel);
    genel.tags.depicts.insert(Depicts::Name);
    genel.created_at = datetime!(2024-07-10 08:00 UTC);
    assert_eq!(genel.kept_until(None), date!(2026 - 07 - 10));
    assert!(genel.retention_due(None, at(date!(2026 - 07 - 11))));
}

#[test]
fn olays_containing_the_capture_day_are_suggested_nearest_first() {
    let long = olay(
        1,
        OlayKind::Season,
        date!(2026 - 11 - 01),
        date!(2026 - 12 - 31),
    );
    let workshop = olay(
        2,
        OlayKind::Workshop,
        date!(2026 - 11 - 16),
        date!(2026 - 11 - 16),
    );
    let order = olay(
        3,
        OlayKind::Order,
        date!(2026 - 11 - 10),
        date!(2026 - 11 - 20),
    );
    let mut proposed = olay(
        4,
        OlayKind::Other,
        date!(2026 - 11 - 16),
        date!(2026 - 11 - 18),
    );
    proposed.status = OlayStatus::Proposed;
    proposed.confirmed = None;
    let other = olay(
        5,
        OlayKind::Workshop,
        date!(2026 - 11 - 17),
        date!(2026 - 11 - 17),
    );
    let olays = vec![
        long.clone(),
        workshop.clone(),
        order.clone(),
        proposed.clone(),
        other,
    ];
    let ids: Vec<OlayId> = olay_suggestions(&olays, date!(2026 - 11 - 16))
        .into_iter()
        .map(|o| o.id)
        .collect();
    assert_eq!(ids, vec![workshop.id, proposed.id, order.id, long.id]);
    assert!(olay_suggestions(&olays, date!(2027 - 03 - 01)).is_empty());
}

#[test]
fn a_slots_materials_rank_as_selection_picks_and_name_the_refusals() {
    let calendar = Calendar::effective(2025..=2027, &[]);
    let now = at(date!(2026 - 11 - 16));
    let ws_olay = olay(
        1,
        OlayKind::Workshop,
        date!(2026 - 11 - 20),
        date!(2026 - 11 - 20),
    );
    let past = olay(
        2,
        OlayKind::Workshop,
        date!(2026 - 10 - 01),
        date!(2026 - 10 - 01),
    );
    let mut unconfirmed = olay(
        3,
        OlayKind::Workshop,
        date!(2026 - 11 - 18),
        date!(2026 - 11 - 18),
    );
    unconfirmed.status = OlayStatus::Proposed;
    unconfirmed.confirmed = None;
    let olays = vec![ws_olay.clone(), past.clone(), unconfirmed.clone()];
    let upcoming = material(
        1,
        Binding::Olay {
            olay_id: ws_olay.id,
        },
    );
    let mut recap = material(2, Binding::Olay { olay_id: past.id });
    recap.tags.product_groups.insert(ProductGroup::Figur);
    let waiting = material(
        3,
        Binding::Olay {
            olay_id: unconfirmed.id,
        },
    );
    let mut genel_ai = material(4, Binding::Genel);
    genel_ai.origin = Origin::AiGenerated {
        generator: "codex".into(),
    };
    let mut unset = material(
        5,
        Binding::Olay {
            olay_id: ws_olay.id,
        },
    );
    unset.share = None;
    let erased = material(
        6,
        Binding::Olay {
            olay_id: ws_olay.id,
        },
    )
    .redacted(now);
    let materials = vec![
        recap.clone(),
        upcoming.clone(),
        waiting.clone(),
        genel_ai.clone(),
        unset.clone(),
        erased.clone(),
    ];
    let cx = UseContext {
        at: now,
        olays: &olays,
        calendar: &calendar,
        ai_standalone: false,
    };
    let policy = MaterialPolicy::default();
    // No need: the upcoming olay's material first, then the recap; the AI visual supports.
    let (ranked, refused) = rank_materials(&SlotNeed::default(), &materials, &[], &policy, &cx);
    let first = ranked[0];
    assert_eq!(
        (first.material_id, first.subject, first.role),
        (
            upcoming.id,
            Subject::Olay {
                olay_id: ws_olay.id
            },
            UseRole::Anchor
        )
    );
    let pick = select_anchor(&SlotNeed::default(), &materials, &[], &policy, &cx).unwrap();
    assert_eq!(
        (pick.material_id, pick.subject),
        (first.material_id, first.subject)
    );
    assert_eq!(ranked[1].material_id, recap.id);
    let last = ranked.last().unwrap();
    assert_eq!(
        (last.material_id, last.role),
        (genel_ai.id, UseRole::Support)
    );
    assert_eq!(
        refused.iter().copied().collect::<BTreeSet<_>>(),
        BTreeSet::from([
            (waiting.id, Refusal::OlayUnconfirmed),
            (unset.id, Refusal::ShareUnset)
        ])
    );
    assert!(ranked.iter().all(|c| c.material_id != erased.id));
    // A need for figures: the recap matches it and comes first, as selection picks it.
    let need = SlotNeed::from_keys("figur.bitmis_urun", "all");
    recap.tags.content_types.insert(ContentType::BitmisUrun);
    let materials = vec![upcoming.clone(), recap.clone(), genel_ai];
    let (ranked, _) = rank_materials(&need, &materials, &[], &policy, &cx);
    assert_eq!(
        (ranked[0].material_id, ranked[0].matches_need),
        (recap.id, true)
    );
    assert_eq!(
        select_anchor(&need, &materials, &[], &policy, &cx)
            .unwrap()
            .material_id,
        recap.id
    );
    assert!(
        ranked
            .iter()
            .any(|c| c.material_id == upcoming.id && !c.matches_need)
    );
}

#[test]
fn material_validation_requires_canonical_labels() {
    let mut m = material(
        1,
        Binding::Olay {
            olay_id: OlayId(Uuid::from_u128(901)),
        },
    );
    m.tags.labels = normalize_material_labels(&["  Fresh   Bread ".into()]).unwrap();
    assert_eq!(m.validate(), Ok(()));
    m.tags.labels = BTreeSet::from([" Fresh Bread ".to_owned()]);
    assert_eq!(m.validate(), Err(StudioError::InvalidMaterial("labels")));
}

#[test]
fn strategy_label_selects_only_materials_carrying_it() {
    let calendar = Calendar::effective(2025..=2027, &[]);
    let now = at(date!(2026 - 11 - 16));
    let occasion = olay(
        1,
        OlayKind::Workshop,
        date!(2026 - 11 - 20),
        date!(2026 - 11 - 20),
    );
    let olays = vec![occasion.clone()];
    let mut matching = material(
        1,
        Binding::Olay {
            olay_id: occasion.id,
        },
    );
    matching.tags.labels = normalize_material_labels(&[" Fresh Bread ".into()]).unwrap();
    let other = material(
        2,
        Binding::Olay {
            olay_id: occasion.id,
        },
    );
    let cx = UseContext {
        at: now,
        olays: &olays,
        calendar: &calendar,
        ai_standalone: false,
    };
    let need = SlotNeed::from_keys("label:fresh bread", "existing_segment");
    let pick = select_anchor(
        &need,
        &[other.clone(), matching.clone()],
        &[],
        &MaterialPolicy::default(),
        &cx,
    )
    .unwrap();
    assert_eq!(pick.material_id, matching.id);
    assert!(select_anchor(&need, &[other], &[], &MaterialPolicy::default(), &cx).is_none());
}
