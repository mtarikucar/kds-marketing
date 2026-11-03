//! Rendering a step (spec §3.10, D12): variables, fallbacks, safe subjects, link rewriting from
//! the snapshot only, and the mandatory footer.

mod support;

use jt_outreach::*;
use support::*;

const TR_FOOTER_PUBLIC: &str = "--\n\
Örnek Yazılım A.Ş. · Örnek Mah. Deneme Sok. 1, İstanbul\n\
Bu e-postayı işletmenizin herkese açık iletişim bilgileri üzerinden gönderiyoruz.\n\
Kişisel verilerin işlenmesi hakkında: https://ornek-yazilim.example.invalid/kvkk\n\
Bu e-postaları almak istemiyorsanız: https://jeeta.example.invalid/u/1/2/3";

const EN_FOOTER_CONSENT: &str = "--\n\
Örnek Yazılım A.Ş. · Örnek Mah. Deneme Sok. 1, İstanbul\n\
You are receiving this email because you agreed to receive messages from us.\n\
About the processing of personal data: https://ornek-yazilim.example.invalid/kvkk\n\
To stop receiving these emails: https://jeeta.example.invalid/u/1/2/3";

fn plain(s: &StepSnapshot, v: &RenderVars) -> Result<Rendered, RenderError> {
    render(s, v, &footer(FooterSource::PublicBusinessData), None)
}

#[test]
fn missing_value_without_fallback_is_an_error() {
    let s = snapshot("Merhaba", "Merhaba {{contact_name}},", Lang::Tr);
    for v in [vars(&[]), vars(&[("contact_name", "   ")])] {
        let err = plain(&s, &v).unwrap_err();
        assert_eq!(err, RenderError::MissingVariable("contact_name".into()));
        assert_eq!(err.to_string(), "missing_variable:contact_name");
    }
    let s = snapshot("{{custom.konu}}", "Merhaba", Lang::Tr);
    assert_eq!(
        plain(&s, &vars(&[])).unwrap_err(),
        RenderError::MissingVariable("custom.konu".into())
    );
}

#[test]
fn fallback_is_used() {
    let s = snapshot(
        "{{company|İşletmeniz}} için",
        "Merhaba {{contact_name|ekibiniz}}, {{\"{{\"}}",
        Lang::Tr,
    );
    let r = plain(&s, &vars(&[])).unwrap();
    assert_eq!(r.subject, "İşletmeniz için");
    assert!(
        r.text.starts_with("Merhaba ekibiniz, {{\n\n--\n"),
        "{}",
        r.text
    );
    let r = plain(
        &s,
        &vars(&[("company", "Deneme Kafe"), ("contact_name", "Ayşe Hanım")]),
    )
    .unwrap();
    assert_eq!(r.subject, "Deneme Kafe için");
    assert!(r.text.starts_with("Merhaba Ayşe Hanım, {{\n\n"));
}

#[test]
fn subject_newline_from_a_value_is_unsafe() {
    let s = snapshot("{{company}} için", "Merhaba {{company}}", Lang::Tr);
    for value in [
        "Deneme\nBcc: x@ornek.example.invalid",
        "Deneme\rKafe",
        "Sekme\tli",
    ] {
        assert_eq!(
            plain(&s, &vars(&[("company", value)])).unwrap_err(),
            RenderError::HeaderUnsafe,
            "{value:?}"
        );
    }
    let long = "ş".repeat(200);
    assert_eq!(
        plain(&s, &vars(&[("company", &long)])).unwrap_err(),
        RenderError::HeaderUnsafe,
        "the subject stays within 200 characters after substitution"
    );
    // A line break in a body value is just text.
    let s = snapshot("Konu", "Not: {{custom.not}}", Lang::Tr);
    let r = plain(&s, &vars(&[("custom.not", "bir\niki")])).unwrap();
    assert!(r.text.starts_with("Not: bir\niki\n\n--\n"));
}

#[test]
fn links_rewritten_only_from_snapshot() {
    let body = "Ürün: https://ornek.example.invalid/a. Fiyat: https://ornek.example.invalid/b";
    let mut s = snapshot("Konu", body, Lang::Tr);
    assert_eq!(s.links.len(), 2);
    let url_for = |i: usize| format!("https://jeeta.example.invalid/c/{i}");
    let r = render(
        &s,
        &vars(&[]),
        &footer(FooterSource::PublicBusinessData),
        Some(&url_for),
    )
    .unwrap();
    assert!(
        r.text.starts_with(
            "Ürün: https://jeeta.example.invalid/c/0. Fiyat: https://jeeta.example.invalid/c/1\n\n"
        ),
        "{}",
        r.text
    );
    // Without a rewriter the text keeps its links.
    let r = plain(&s, &vars(&[])).unwrap();
    assert!(r.text.starts_with(body));
    // Only the snapshot's links are rewritten, by their index there.
    s.links = vec!["https://ornek.example.invalid/b".into()];
    let r = render(
        &s,
        &vars(&[]),
        &footer(FooterSource::PublicBusinessData),
        Some(&url_for),
    )
    .unwrap();
    assert!(r.text.starts_with(
        "Ürün: https://ornek.example.invalid/a. Fiyat: https://jeeta.example.invalid/c/0\n\n"
    ));
    // The footer's links are never rewritten.
    assert!(r.text.ends_with("https://jeeta.example.invalid/u/1/2/3"));
    assert_eq!(
        rewrite_links(
            "a https://ornek.example.invalid/a, b",
            &["https://ornek.example.invalid/a".into()],
            &url_for
        ),
        "a https://jeeta.example.invalid/c/0, b"
    );
}

#[test]
fn variable_urls_are_left_alone() {
    let s = snapshot(
        "Konu",
        "Bakınız: {{custom.link}} ve https://ornek.example.invalid/a",
        Lang::Tr,
    );
    let url_for = |i: usize| format!("https://jeeta.example.invalid/c/{i}");
    let r = render(
        &s,
        &vars(&[("custom.link", "https://ornek.example.invalid/a")]),
        &footer(FooterSource::PublicBusinessData),
        Some(&url_for),
    )
    .unwrap();
    assert!(
        r.text.starts_with(
            "Bakınız: https://ornek.example.invalid/a ve https://jeeta.example.invalid/c/0\n\n"
        ),
        "{}",
        r.text
    );
}

#[test]
fn footer_tr_and_en() {
    let s = snapshot("Konu", "Merhaba,\n\nİyi günler.\n\n", Lang::Tr);
    let r = plain(&s, &vars(&[])).unwrap();
    assert_eq!(
        r.text,
        format!("Merhaba,\n\nİyi günler.\n\n{TR_FOOTER_PUBLIC}")
    );
    let s = snapshot("Subject", "Hello,", Lang::En);
    let r = render(&s, &vars(&[]), &footer(FooterSource::Consent), None).unwrap();
    assert_eq!(r.text, format!("Hello,\n\n{EN_FOOTER_CONSENT}"));
    assert_eq!(r.subject, "Subject");
}

#[test]
fn footer_source_line_depends_on_basis() {
    assert_eq!(
        FooterSource::from(jt_inbox::CommercialBasis::Consent),
        FooterSource::Consent
    );
    assert_eq!(
        FooterSource::from(jt_inbox::CommercialBasis::BusinessRecipient),
        FooterSource::PublicBusinessData
    );
    let lines = |lang, source| footer(source).render(lang).unwrap();
    assert!(lines(Lang::Tr, FooterSource::PublicBusinessData).contains(
        "\nBu e-postayı işletmenizin herkese açık iletişim bilgileri üzerinden gönderiyoruz.\n"
    ));
    assert!(
        lines(Lang::Tr, FooterSource::Consent)
            .contains("\nBu e-postayı bizden ileti almayı kabul ettiğiniz için alıyorsunuz.\n")
    );
    assert!(lines(Lang::En, FooterSource::PublicBusinessData).contains(
        "\nWe are sending this email to your business's publicly listed contact details.\n"
    ));
    assert!(lines(Lang::En, FooterSource::Consent).contains(
        "\nYou are receiving this email because you agreed to receive messages from us.\n"
    ));
}

#[test]
fn the_footer_is_never_blank() {
    let s = snapshot("Konu", "Merhaba", Lang::Tr);
    let changes: [fn(&mut Footer); 5] = [
        |f: &mut Footer| f.sender_company = "  ".into(),
        |f: &mut Footer| f.sender_address = String::new(),
        |f: &mut Footer| f.privacy_notice_url = String::new(),
        |f: &mut Footer| f.unsubscribe_url = " ".into(),
        |f: &mut Footer| f.sender_address = "Satır\nikinci".into(),
    ];
    for change in changes {
        let mut f = footer(FooterSource::Consent);
        change(&mut f);
        assert_eq!(
            render(&s, &vars(&[]), &f, None).unwrap_err(),
            RenderError::FooterIncomplete
        );
    }
}
