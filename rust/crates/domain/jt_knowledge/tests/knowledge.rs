//! The knowledge base's rules, pure: limits and strict parsing at the write boundary, tolerant
//! reads, the empty predicate, and the seed mapping against a sample strategy of a fictional
//! business, a coffee roastery, in the shape of a live one (version 5,
//! `fixtures/strategy-sample.json`).

use jt_knowledge::seed::{
    ARCHIVED_REASON, DRAFT_REASON, PAST_ENTRY_CHARS, SeedParts, fit, goal_lines,
    past_conversations, platform_name, unapplied,
};
use jt_knowledge::*;
use jt_ledger::Actor;
use jt_strategy::{
    ConsultationEntry, ConsultationEntryId, ConsultationKind, Hypothesis, Sections,
    StrategyVersionId,
};
use jt_tenancy::{AgentConnectionId, UserId, WorkspaceId};
use serde_json::{Value, json};
use time::macros::datetime;

const AT: time::OffsetDateTime = datetime!(2026-11-19 12:00 UTC);

fn v5() -> (Sections, Vec<Hypothesis>) {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/strategy-sample.json")).expect("the fixture");
    (
        serde_json::from_value(fixture["sections"].clone()).expect("the sections read"),
        serde_json::from_value(fixture["hypotheses"].clone()).expect("the hypotheses read"),
    )
}

fn card(body: &str, archived: bool) -> Card {
    let actor = Actor::Human {
        user_id: UserId::new_v7(),
    };
    Card {
        id: KnowledgeCardId::new_v7(),
        key: None,
        title: "Kart".into(),
        body: body.into(),
        attachments: vec![],
        position: 0,
        revision: 1,
        created_at: AT,
        created_by: actor.clone(),
        updated_at: AT,
        updated_by: actor,
        archived_at: archived.then_some(AT),
    }
}

// ---------------------------------------------------------------------------------------------
// Limits and strict parsing
// ---------------------------------------------------------------------------------------------

#[test]
fn titles_bodies_and_links_keep_their_limits() {
    assert_eq!(validate_title("  Biz kimiz ").unwrap(), "Biz kimiz");
    let e = validate_title("   ").unwrap_err();
    assert_eq!((e.field.as_str(), e.reason), ("title", "empty"));
    assert!(validate_title(&"a".repeat(80)).is_ok());
    let e = validate_title(&"ş".repeat(81)).unwrap_err();
    assert_eq!((e.field.as_str(), e.reason), ("title", "too_long"));
    assert_eq!(validate_body("").unwrap(), "");
    assert!(validate_body(&"ç".repeat(8000)).is_ok());
    assert_eq!(
        validate_body(&"x".repeat(8001)).unwrap_err().reason,
        "too_long"
    );

    assert_eq!(
        validate_link("url", " https://kahve.example/katalog.pdf ").unwrap(),
        "https://kahve.example/katalog.pdf"
    );
    for bad in [
        "http://kahve.example",
        "https://",
        "https:///path",
        "ftp://x.example",
        "https://a b.example",
    ] {
        assert_eq!(
            validate_link("url", bad).unwrap_err().reason,
            "not_https",
            "{bad}"
        );
    }
    let long = format!("https://x.example/{}", "a".repeat(2048));
    assert_eq!(validate_link("url", &long).unwrap_err().reason, "too_long");
    let links: Vec<String> = (0..11).map(|i| format!("https://x.example/{i}")).collect();
    assert_eq!(
        validate_links("links", &links).unwrap_err().reason,
        "too_many"
    );
    let e = validate_links("links", &["https://ok.example".into(), "nope".into()]).unwrap_err();
    assert_eq!(e.field, "links[1]");
    let twice = validate_links(
        "links",
        &["https://ok.example".into(), "https://ok.example".into()],
    )
    .unwrap();
    assert_eq!(twice.len(), 1);
}

#[test]
fn rules_goals_and_caps_keep_their_limits() {
    let lines = validate_prohibitions(
        "prohibitions",
        &[" Rakip kötülenmez ".into(), "".into(), "  ".into()],
    )
    .unwrap();
    assert_eq!(lines, vec!["Rakip kötülenmez"]);
    let e = validate_prohibitions("prohibitions", &["ok".into(), "x".repeat(501)]).unwrap_err();
    assert_eq!(
        (e.field.as_str(), e.reason),
        ("prohibitions[1]", "too_long")
    );
    let many: Vec<String> = (0..101).map(|i| format!("yasak {i}")).collect();
    assert_eq!(
        validate_prohibitions("prohibitions", &many)
            .unwrap_err()
            .reason,
        "too_many"
    );
    let goals: Vec<String> = (0..21).map(|i| format!("hedef {i}")).collect();
    assert_eq!(
        validate_goals("items", &goals).unwrap_err().reason,
        "too_many"
    );
    assert_eq!(
        validate_goals("items", &["x".repeat(301)])
            .unwrap_err()
            .field,
        "items[0]"
    );

    let cap: CapInput = serde_json::from_value(json!({"amount_minor": 500000})).unwrap();
    assert_eq!(cap.period, None);
    validate_cap("ad_budget", &cap).unwrap();
    let cap: CapInput =
        serde_json::from_value(json!({"amount_minor": 0, "period": "weekly"})).unwrap();
    assert_eq!(cap.period, Some(jt_strategy::Period::Weekly));
    for amount in [-1, MAX_CAP_MINOR + 1] {
        let e = validate_cap(
            "ad_budget",
            &CapInput {
                amount_minor: amount,
                period: None,
            },
        )
        .unwrap_err();
        assert_eq!(
            (e.field.as_str(), e.reason),
            ("ad_budget.amount_minor", "out_of_range")
        );
    }
    assert!(
        serde_json::from_value::<CapInput>(json!({"amount_minor": 1, "currency": "TRY"})).is_err()
    );
    assert!(
        serde_json::from_value::<CapInput>(json!({"amount_minor": 1, "period": "daily"})).is_err()
    );

    let mut lines = vec!["a".to_owned()];
    let added = append_lines(
        "rules",
        &mut lines,
        &["a".into(), " b ".into(), "b".into()],
        3,
    )
    .unwrap();
    assert_eq!(added, vec!["b"]);
    assert_eq!(lines, vec!["a", "b"]);
    let e = append_lines("rules", &mut lines, &["c".into(), "d".into()], 3).unwrap_err();
    assert_eq!(e.reason, "too_many");
    assert_eq!(lines, vec!["a", "b"], "a refused append changes nothing");
}

#[test]
fn notes_and_proposals_keep_their_limits() {
    assert_eq!(
        validate_note_text("  Yılbaşı 15 Aralık'ta kapanıyor ").unwrap(),
        "Yılbaşı 15 Aralık'ta kapanıyor"
    );
    assert_eq!(validate_note_text("").unwrap_err().reason, "empty");
    assert_eq!(
        validate_note_text(&"x".repeat(4001)).unwrap_err().reason,
        "too_long"
    );

    let card = KnowledgeCardId::new_v7();
    let new = validate_proposal(
        ProposalKind::CardNew,
        None,
        Some("SSS"),
        "Kargo 3 gün",
        "Sık soruluyor",
    )
    .unwrap();
    assert_eq!((new.title.as_deref(), new.card_id), (Some("SSS"), None));
    let e = validate_proposal(ProposalKind::CardNew, None, None, "b", "r").unwrap_err();
    assert_eq!((e.field.as_str(), e.reason), ("title", "required"));
    let e = validate_proposal(ProposalKind::CardNew, Some(card), Some("t"), "b", "r").unwrap_err();
    assert_eq!((e.field.as_str(), e.reason), ("card_id", "not_allowed"));
    let e = validate_proposal(ProposalKind::CardEdit, None, None, "b", "r").unwrap_err();
    assert_eq!((e.field.as_str(), e.reason), ("card_id", "required"));
    assert!(validate_proposal(ProposalKind::CardEdit, Some(card), None, "b", "r").is_ok());
    assert!(validate_proposal(ProposalKind::RuleAdd, None, None, &"x".repeat(500), "r").is_ok());
    let e =
        validate_proposal(ProposalKind::RuleAdd, None, None, &"x".repeat(501), "r").unwrap_err();
    assert_eq!((e.field.as_str(), e.reason), ("body", "too_long"));
    let e =
        validate_proposal(ProposalKind::GoalAdd, None, None, &"x".repeat(301), "r").unwrap_err();
    assert_eq!(e.field, "body");
    let e = validate_proposal(ProposalKind::GoalAdd, None, Some("t"), "b", "r").unwrap_err();
    assert_eq!((e.field.as_str(), e.reason), ("title", "not_allowed"));
    let e =
        validate_proposal(ProposalKind::RuleAdd, None, None, "b", &"x".repeat(301)).unwrap_err();
    assert_eq!((e.field.as_str(), e.reason), ("reason", "too_long"));
    assert_eq!(
        validate_proposal(ProposalKind::RuleAdd, None, None, " ", "r")
            .unwrap_err()
            .reason,
        "empty"
    );
}

#[test]
fn attachments_are_written_strictly() {
    let link: AttachmentInput = serde_json::from_value(
        json!({"kind": "link", "url": "https://x.example", "title": "Katalog"}),
    )
    .unwrap();
    assert_eq!(
        link.link("attachments[0]").unwrap(),
        Some(Attachment::Link {
            url: "https://x.example".into(),
            title: Some("Katalog".into())
        })
    );
    let file: AttachmentInput = serde_json::from_value(
        json!({"kind": "file", "file_id": "01a1f78a-56bf-7afa-9228-7158c4849476"}),
    )
    .unwrap();
    assert_eq!(file.link("attachments[1]").unwrap(), None);
    // The stored name and type are the file's own: a writer cannot set them.
    assert!(
        serde_json::from_value::<AttachmentInput>(json!({
            "kind": "file", "file_id": "01a1f78a-56bf-7afa-9228-7158c4849476", "name": "x.pdf"
        }))
        .is_err()
    );
    assert!(
        serde_json::from_value::<AttachmentInput>(json!({"kind": "video", "url": "x"})).is_err()
    );
    let bad: AttachmentInput =
        serde_json::from_value(json!({"kind": "link", "url": "http://x.example"})).unwrap();
    assert_eq!(
        bad.link("attachments[2]").unwrap_err().field,
        "attachments[2].url"
    );
    for mime in [
        "image/png",
        "image/jpeg",
        "video/mp4",
        "application/pdf",
        "APPLICATION/PDF",
    ] {
        assert!(is_knowledge_mime(mime), "{mime}");
    }
    for mime in ["video/quicktime", "text/plain", "application/zip"] {
        assert!(!is_knowledge_mime(mime), "{mime}");
    }
}

#[test]
fn card_keys_and_the_parts_they_feed() {
    for (key, _) in SEED_CARDS {
        assert!(valid_key(key), "{key}");
    }
    assert!(valid_key(PAST_CONVERSATIONS.0));
    for bad in ["", "a", "1abc", "Abc", "ab-c", &"a".repeat(41)] {
        assert!(!valid_key(bad), "{bad}");
    }
    let posting = [
        "who_we_are",
        "products_prices",
        "customers",
        "post_ideas",
        "past_conversations",
    ];
    let prospecting = ["who_we_seek", "customers"];
    for (key, _) in SEED_CARDS.iter().copied().chain([PAST_CONVERSATIONS]) {
        assert_eq!(feeds_posting(Some(key)), posting.contains(&key), "{key}");
        assert_eq!(
            feeds_prospecting(Some(key)),
            prospecting.contains(&key),
            "{key}"
        );
    }
    // The owner's own cards feed both; voice, channels and references neither.
    assert!(feeds_posting(None) && feeds_prospecting(None));
    for key in ["voice", "accounts_channels", "references"] {
        assert!(!feeds_posting(Some(key)) && !feeds_prospecting(Some(key)));
    }
}

#[test]
fn the_knowledge_base_is_empty_until_a_live_card_has_text() {
    assert!(is_empty(&[]));
    assert!(is_empty(&[card("", false), card(" \n\t ", false)]));
    assert!(
        is_empty(&[card("Biz kahve kavururuz", true)]),
        "a removed card does not count"
    );
    assert!(!is_empty(&[
        card("", false),
        card("Biz kahve kavururuz", false)
    ]));
    // Rules and goals are no input of `is_empty`: a workspace with only them is still empty
    // (`jt_app`'s `the_rules_are_saved_whole_and_derive_nothing` and `the_goals_are_saved_whole`
    // check it through the use cases).
}

// ---------------------------------------------------------------------------------------------
// Tolerant reads
// ---------------------------------------------------------------------------------------------

#[test]
fn stored_rows_read_tolerantly() {
    let ws = WorkspaceId::new_v7();
    let user = UserId::new_v7();
    let card: Card = serde_json::from_value(json!({
        "id": KnowledgeCardId::new_v7(),
        "title": "Ses tonu",
        "revision": 3,
        "created_at": "2026-11-19T12:00:00Z",
        "created_by": {"kind": "human", "user_id": user},
        "updated_at": "2026-11-19T12:00:00Z",
        "updated_by": {"kind": "system", "component": "knowledge_backfill"},
        "a_later_field": true,
    }))
    .expect("a card with missing and unknown fields reads");
    assert_eq!(
        (
            card.key.as_deref(),
            card.body.as_str(),
            card.attachments.len()
        ),
        (None, "", 0)
    );
    assert!(card.is_live());

    let s: KnowledgeSettings = serde_json::from_value(json!({
        "workspace_id": ws,
        "revision": 1,
        "rules_revision": 1,
        "goals_revision": 1,
        "seeded_at": "2026-11-19T12:00:00Z",
        "seed_source": "approved",
        "ad_cap": {"amount_minor": 500000},
        "a_later_field": [1, 2],
    }))
    .expect("settings with missing and unknown fields read");
    assert_eq!(
        s.ad_cap,
        Some(Cap {
            amount_minor: 500000,
            period: jt_strategy::Period::Monthly,
            currency: "TRY".into()
        })
    );
    assert!(s.prohibitions.is_empty() && !s.post_approval);

    let note: Note = serde_json::from_value(json!({
        "id": KnowledgeNoteId::new_v7(),
        "text": "Yılbaşı siparişleri 15 Aralık'ta kapanıyor",
        "status": "filed",
        "revision": 2,
        "created_at": "2026-11-19T12:00:00Z",
        "created_by": user,
        "outcome": {"summary": "Ürünler ve fiyat kartına eklendi", "a_later_outcome": {}},
    }))
    .expect("a note reads");
    assert_eq!(
        note.outcome.unwrap().summary.as_deref(),
        Some("Ürünler ve fiyat kartına eklendi")
    );

    let p: Proposal = serde_json::from_value(json!({
        "id": KnowledgeProposalId::new_v7(),
        "kind": "rule_add",
        "body": "Kargo süresi söz verilmez",
        "reason": "Müşteriler soruyor",
        "status": "pending",
        "proposed_at": "2026-11-19T12:00:00Z",
        "proposed_by": {"kind": "agent", "connection_id": AgentConnectionId::new_v7()},
        "expires_at": "2026-12-03T12:00:00Z",
    }))
    .expect("a proposal reads");
    assert!(!p.is_system() && p.is_pending());
}

#[test]
fn a_new_settings_row_is_at_its_first_rules_and_goals_revision() {
    let s = KnowledgeSettings::new(WorkspaceId::new_v7(), SeedSource::Draft, AT);
    assert_eq!((s.revision, s.rules_revision, s.goals_revision), (0, 1, 1));
    assert!(!s.posting_due() && !s.prospecting_due());
    assert_eq!(
        s.rules_content(),
        json!({"prohibitions": [], "ad_cap": null, "message_cap": null,
               "post_approval": false, "post_approval_accounts": []})
    );
    assert_eq!(s.goals_content(), json!({"items": []}));
    for (source, key) in [
        (SeedSource::Approved, "approved"),
        (SeedSource::Draft, "draft"),
        (SeedSource::Empty, "empty"),
    ] {
        assert_eq!(source.key(), key);
        assert_eq!(SeedSource::parse(key), Some(source));
    }
}

#[test]
fn every_stored_code_round_trips() {
    for s in [Subject::Card, Subject::Rules, Subject::Goals] {
        assert_eq!(Subject::parse(s.key()), Some(s));
    }
    for c in [
        Cause::Seed,
        Cause::Backfill,
        Cause::Resync,
        Cause::Owner,
        Cause::Proposal,
        Cause::Note,
        Cause::System,
    ] {
        assert_eq!(Cause::parse(c.key()), Some(c));
    }
    for s in [
        NoteStatus::Open,
        NoteStatus::Filed,
        NoteStatus::Dismissed,
        NoteStatus::Withdrawn,
    ] {
        assert_eq!(NoteStatus::parse(s.key()), Some(s));
    }
    for k in [
        ProposalKind::CardNew,
        ProposalKind::CardEdit,
        ProposalKind::RuleAdd,
        ProposalKind::GoalAdd,
    ] {
        assert_eq!(ProposalKind::parse(k.key()), Some(k));
    }
    for s in [
        ProposalStatus::Pending,
        ProposalStatus::Accepted,
        ProposalStatus::Skipped,
        ProposalStatus::Expired,
        ProposalStatus::Superseded,
    ] {
        assert_eq!(ProposalStatus::parse(s.key()), Some(s));
    }
}

// ---------------------------------------------------------------------------------------------
// The seed mapping
// ---------------------------------------------------------------------------------------------

/// The live hypotheses of the fixture (it holds no owner's request).
fn topics(hypotheses: &[Hypothesis]) -> Vec<Hypothesis> {
    hypotheses.to_vec()
}

#[test]
fn the_owners_strategy_seeds_these_cards() {
    let (s, hypotheses) = v5();
    let parts = SeedParts::from_version(&s, &topics(&hypotheses));
    let keys: Vec<&str> = parts.cards.iter().map(|c| c.key).collect();
    assert_eq!(
        keys,
        vec![
            "who_we_are",
            "products_prices",
            "voice",
            "customers",
            "post_ideas",
            "who_we_seek",
            "accounts_channels",
            "references"
        ]
    );
    let titles: Vec<&str> = parts.cards.iter().map(|c| c.title).collect();
    assert_eq!(
        titles,
        vec![
            "Biz kimiz",
            "Ürünler ve fiyat",
            "Ses tonu",
            "Müşterilerimiz",
            "Paylaşım fikirleri",
            "Kimi arıyoruz",
            "Hesaplar ve kanallar",
            "Referanslar"
        ]
    );

    // Biz kimiz: the positioning, then what sets it apart.
    assert_eq!(
        parts.body("who_we_are"),
        format!(
            "{}\n\nBizi farklı kılan: {}",
            s.identity.positioning, s.identity.usp
        )
    );
    assert!(parts.body("who_we_are").starts_with(
        "Kavrulmuş Kahve Atölyesi: Taze kavrulur, aynı hafta içilir. Mahallenin kavurma atölyesi; \
         tek kökenli ve harman çekirdekleri küçük partilerle kavurup ofislere, kafelere ve evlere \
         aynı hafta ulaştırır. 250 gramlık paketten haftalık toptan siparişe, dükkândan ve \
         kargoyla.\n\nBizi farklı kılan: Kavrulduğu hafta teslim + tek kökenli çekirdeklerde açık \
         köken bilgisi + "
    ));
    // Ürünler ve fiyat, Ses tonu: as written.
    assert_eq!(parts.body("products_prices"), s.identity.product);
    assert!(parts.body("products_prices").starts_with(
        "Çekirdeği küçük partilerle kavurur, kavrulduğu hafta teslim eder. Ürün grupları: (1) \
         Paket kahve: tek kökenli ve harman çekirdek, 250 g ve 1 kg, çekirdek ya da demleme \
         yöntemine göre öğütülmüş; 250 g ₺420'den başlar, şehir içi teslimat dahil."
    ));
    assert_eq!(parts.body("voice"), s.identity.voice);
    assert!(
        parts
            .body("voice")
            .starts_with("Sıcak, meraklı, sade ve kahveyi anlatan: ")
    );
    assert!(
        parts
            .body("voice")
            .ends_with("Kısa slogan: 'Taze kavrulur, aynı hafta içilir.'")
    );

    // Müşterilerimiz: the objective, a blank line, then the ten segments.
    let customers = parts.body("customers");
    let (objective, segments) = customers.split_once("\n\n").unwrap();
    assert_eq!(objective, s.goals.objective);
    assert!(objective.starts_with("Aynı kavurma kapasitesini üç satış kapısından büyütmek: "));
    let lines: Vec<&str> = segments.lines().collect();
    assert_eq!(lines.len(), 10);
    assert!(lines[0].starts_with("• Ofis kahvesi aboneliği: Birinci öncelik. "));
    let names: Vec<&str> = lines
        .iter()
        .map(|l| l.trim_start_matches("• ").split(':').next().unwrap())
        .collect();
    assert_eq!(
        names,
        vec![
            "Ofis kahvesi aboneliği",
            "Kafe ve restoran toptan satışı",
            "Ev kahvecileri",
            "Raf ortakları",
            "Tedarik ağı (PR)",
            "Kahve içerik üreticileri",
            "Tadım buluşması ortakları",
            "Pazar ve festival stantları",
            "Kampüs ve kurs merkezi iş birlikleri",
            "Teslim noktası adayları"
        ]
    );
    for (line, segment) in lines.iter().zip(&s.audience) {
        assert_eq!(
            *line,
            format!("• {}: {}", segment.name, segment.description)
        );
    }

    // Paylaşım fikirleri: the seven live topics, in order.
    let ideas: Vec<&str> = parts.body("post_ideas").lines().collect();
    assert_eq!(ideas.len(), 7);
    for (line, h) in ideas.iter().zip(&hypotheses) {
        assert_eq!(*line, format!("• {}: {}", h.title, h.angle));
    }
    assert!(ideas[0].starts_with(
        "• Çekirdekten fincana: Yeşil çekirdek → kavurma → dinlendirme → paketleme → demleme; "
    ));
    assert!(ideas[6].starts_with("• Yılbaşı hediye kutusu (TikTok): "));

    // Kimi arıyoruz: the seven ICP entries; the rubric is not written.
    let seek: Vec<&str> = parts.body("who_we_seek").lines().collect();
    assert_eq!(seek.len(), 7);
    let first = &s.prospecting.icp[0];
    assert_eq!(first.segment_key, "toptan");
    let expected = format!(
        "• Kafe ve restoran toptan satışı: {}. Şehirler: {}. İşaretler: {}. Hariç: {}. Ölçek: {}.",
        first.sectors.join(", "),
        first
            .areas
            .iter()
            .map(|a| a.city.as_str())
            .collect::<Vec<_>>()
            .join(", "),
        first.signals.join("; "),
        first.exclusions.join("; "),
        first.size_hint
    );
    assert_eq!(seek[0], expected);
    assert!(seek[0].starts_with(
        "• Kafe ve restoran toptan satışı: Bağımsız kafe ve kahve dükkânı, Kahvaltı salonu ve \
         brunch mekânı, Restoran ve bistro, Pastane ve fırın. Şehirler: İzmir, Manisa, Aydın, \
         Muğla, Denizli, Balıkesir, Uşak, Çanakkale. İşaretler: "
    ));
    assert!(!parts.body("who_we_seek").contains("uygunluk"), "no rubric");

    // Hesaplar ve kanallar: one line per choice, `any` without a platform.
    let channels: Vec<&str> = parts.body("accounts_channels").lines().collect();
    assert_eq!(channels.len(), 7);
    assert!(channels[0].starts_with("• Instagram: Ana vitrin. "));
    assert!(channels[1].starts_with("• E-posta: Ofis ve kafe görüşmelerinde birebir e-posta"));
    assert!(channels[2].starts_with("• TikTok: Kavurma makinesinin başından kısa videolar: "));
    assert!(channels[3].starts_with("• LinkedIn şirket sayfası "));
    assert!(channels[4].starts_with("• WhatsApp Business hattı: "));
    assert!(channels[5].starts_with("• Facebook sayfası (Kavrulmuş Kahve Atölyesi): "));
    assert!(channels[6].starts_with("• Yapay zekâ aramasında ve haritalarda görünürlük: "));

    assert_eq!(parts.body("references"), "");

    // Kurallar and Hedefler.
    assert_eq!(parts.prohibitions, s.prohibitions);
    assert_eq!(parts.prohibitions.len(), 7);
    assert_eq!(
        parts.goals,
        vec![
            "Ofis aboneliği: 3 ayda 8 yeni abone ofis",
            "Kafe ve restoran toptan anlaşması: Ayda 2 anlaşma, her biri haftada 5+ kg",
            "Paket kahve satışı: Haftada 30-40 paketten 70'e (3. ayın sonunda)",
            "Raf ortağı: 3 ayda 4 aktif raf ortağı",
            "İçerik üreticisi iş birliği: 3 ayda 4 ücretsiz tadım ziyareti (para ödenmez)"
        ]
    );
    // Every body fits a card.
    for c in &parts.cards {
        assert!(c.body.chars().count() <= MAX_CARD_BODY_CHARS, "{}", c.key);
    }
}

#[test]
fn the_seed_is_deterministic() {
    let (s, h) = v5();
    assert_eq!(
        SeedParts::from_version(&s, &h),
        SeedParts::from_version(&s, &h)
    );
}

#[test]
fn retired_topics_and_empty_texts_seed_nothing() {
    let (mut s, mut h) = v5();
    h[0].state = jt_strategy::HypothesisState::Retired;
    s.identity.usp = String::new();
    s.goals.objective = String::new();
    s.channels[0].rationale = "  ".into();
    let parts = SeedParts::from_version(&s, &h);
    assert_eq!(parts.body("post_ideas").lines().count(), 6);
    assert_eq!(parts.body("who_we_are"), s.identity.positioning);
    assert!(parts.body("customers").starts_with("• Ofis kahvesi"));
    assert_eq!(parts.body("accounts_channels").lines().count(), 6);
    let blank = SeedParts::blank();
    assert!(blank.cards.iter().all(|c| c.body.is_empty()));
    assert_eq!(blank.cards.len(), 8);
}

#[test]
fn a_long_body_keeps_whole_lines_and_says_how_many_are_left() {
    let lines: Vec<String> = (0..100)
        .map(|i| format!("• {i:03} {}", "x".repeat(95)))
        .collect();
    let body = fit(Some("Baş"), &lines);
    assert!(body.chars().count() <= MAX_CARD_BODY_CHARS);
    assert!(body.starts_with("Baş\n\n• 000 "));
    let kept: Vec<&str> = body.lines().filter(|l| l.starts_with("• ")).collect();
    let more = 100 - kept.len();
    assert!(body.ends_with(&format!("\n(+{more} satır daha)")), "{body}");
    assert!(
        kept.iter().all(|l| l.chars().count() == 101),
        "only whole lines"
    );
    // Short enough: as it is.
    assert_eq!(
        fit(Some("Baş"), &lines[..2]),
        format!("Baş\n\n{}\n{}", lines[0], lines[1])
    );
    assert_eq!(fit(None, &[]), "");
    assert_eq!(fit(Some("  "), &lines[..1]), lines[0]);
}

#[test]
fn goal_lines_name_the_target_when_there_is_one() {
    let goals = jt_strategy::Goals {
        objective: String::new(),
        kpis: vec![
            jt_strategy::Kpi {
                name: "Sipariş".into(),
                target: "Ayda 12".into(),
            },
            jt_strategy::Kpi {
                name: "Takipçi".into(),
                target: " ".into(),
            },
            jt_strategy::Kpi {
                name: " ".into(),
                target: "".into(),
            },
            jt_strategy::Kpi {
                name: "Uzun".into(),
                target: "x".repeat(400),
            },
        ],
    };
    let lines = goal_lines(&goals);
    assert_eq!(
        lines[..2],
        ["Sipariş: Ayda 12".to_owned(), "Takipçi".to_owned()]
    );
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[2].chars().count(), MAX_GOAL_CHARS);
    assert!(lines[2].ends_with('…'));
}

fn entry(kind: ConsultationKind, text: &str, minute: i64, actor: Actor) -> ConsultationEntry {
    ConsultationEntry {
        id: ConsultationEntryId::new_v7(),
        version_id: StrategyVersionId::new_v7(),
        kind,
        section_key: None,
        text: text.into(),
        actor,
        at: AT + time::Duration::minutes(minute),
    }
}

#[test]
fn past_conversations_keep_the_owners_answers_and_notes_newest_first() {
    let agent = Actor::Agent {
        connection_id: AgentConnectionId::new_v7(),
        user_id: UserId::new_v7(),
    };
    let system = Actor::System {
        component: "strategy".into(),
    };
    let entries = vec![
        entry(
            ConsultationKind::Answer,
            "Toplu siparişte\nöncelik kurumsal",
            1,
            agent.clone(),
        ),
        entry(
            ConsultationKind::Question,
            "Kime satıyorsunuz?",
            2,
            agent.clone(),
        ),
        entry(ConsultationKind::Note, "consultation started", 0, system),
        entry(ConsultationKind::Note, &"u".repeat(700), 3, agent.clone()),
        entry(ConsultationKind::Assumption, "Varsayım", 4, agent.clone()),
    ];
    let body = past_conversations(&entries).unwrap();
    let lines: Vec<&str> = body.lines().collect();
    assert_eq!(
        lines.len(),
        2,
        "answers and notes only, the system's left out"
    );
    assert_eq!(lines[0].chars().count(), 2 + PAST_ENTRY_CHARS, "cut at 600");
    assert_eq!(lines[1], "• Toplu siparişte öncelik kurumsal");
    assert_eq!(past_conversations(&entries[1..3]), None);
    // Whole entries only, up to a card's body.
    let many: Vec<ConsultationEntry> = (0..20)
        .map(|i| entry(ConsultationKind::Answer, &"a".repeat(600), i, agent.clone()))
        .collect();
    let body = past_conversations(&many).unwrap();
    assert!(body.chars().count() <= MAX_CARD_BODY_CHARS);
    assert_eq!(body.lines().count(), 13);
}

#[test]
fn what_a_draft_wrote_and_no_approval_applied_becomes_proposals() {
    let (s, h) = v5();
    let applied = SeedParts::from_version(&s, &h);
    let mut draft = s.clone();
    draft.identity.voice = "Daha resmî bir dil.".into();
    draft.prohibitions.push("Fiyat pazarlığı yapılmaz.".into());
    draft.prohibitions.push("Fiyat pazarlığı yapılmaz.".into());
    draft.goals.kpis.push(jt_strategy::Kpi {
        name: "Bayi".into(),
        target: "3 ayda 2".into(),
    });
    draft.channels.clear();
    let pending = unapplied(Some(&applied), &SeedParts::from_version(&draft, &h), None);
    assert_eq!(
        pending
            .iter()
            .map(|p| (p.kind, p.card_key, p.body.as_str()))
            .collect::<Vec<_>>(),
        vec![
            (ProposalKind::CardEdit, Some("voice"), "Daha resmî bir dil."),
            (ProposalKind::RuleAdd, None, "Fiyat pazarlığı yapılmaz."),
            (ProposalKind::GoalAdd, None, "Bayi: 3 ayda 2"),
        ],
        "channels are no part of the knowledge base's proposals"
    );
    // A draft the same as the approved version proposes nothing.
    assert!(unapplied(Some(&applied), &applied, None).is_empty());

    // No approved version: every non-empty part of the draft, its channels too, and the log.
    let all = unapplied(None, &applied, Some("• Öncelik kurumsal"));
    let edits: Vec<&str> = all
        .iter()
        .filter(|p| p.kind == ProposalKind::CardEdit)
        .map(|p| p.card_key.unwrap())
        .collect();
    assert_eq!(
        edits,
        vec![
            "who_we_are",
            "products_prices",
            "voice",
            "customers",
            "post_ideas",
            "who_we_seek",
            "accounts_channels"
        ]
    );
    let channels = all
        .iter()
        .find(|p| p.card_key == Some("accounts_channels"))
        .unwrap();
    assert_eq!(channels.body, applied.body("accounts_channels"));
    assert!(channels.body.starts_with("• Instagram: "));
    assert_eq!(
        all.iter()
            .filter(|p| p.kind == ProposalKind::RuleAdd)
            .count(),
        7
    );
    assert_eq!(
        all.iter()
            .filter(|p| p.kind == ProposalKind::GoalAdd)
            .count(),
        5
    );
    let log = all.last().unwrap();
    assert_eq!(
        (log.kind, log.title.as_deref(), log.body.as_str()),
        (
            ProposalKind::CardNew,
            Some("Önceki görüşmeler"),
            "• Öncelik kurumsal"
        )
    );
    // Every seeded proposal is a valid one.
    for p in &all {
        validate_proposal(
            p.kind,
            p.card_key.map(|_| KnowledgeCardId::new_v7()),
            p.title.as_deref(),
            &p.body,
            DRAFT_REASON,
        )
        .unwrap();
    }
    assert!(ARCHIVED_REASON.chars().count() <= MAX_PROPOSAL_REASON_CHARS);
}

#[test]
fn platforms_have_the_owners_names() {
    for (kind, name) in [
        ("instagram", "Instagram"),
        ("facebook_page", "Facebook"),
        ("x", "X"),
        ("linkedin_page", "LinkedIn"),
        ("linkedin_member", "LinkedIn"),
        ("tiktok", "TikTok"),
        ("youtube", "YouTube"),
        ("pinterest", "Pinterest"),
        ("google_business", "Google İşletme"),
        ("mailbox", "E-posta"),
        ("whatsapp_cloud", "WhatsApp"),
        ("sms_line", "SMS"),
        ("meta_ads", "Meta reklam"),
    ] {
        assert_eq!(platform_name(kind), Some(name));
    }
    assert_eq!(platform_name("any"), None);
}
