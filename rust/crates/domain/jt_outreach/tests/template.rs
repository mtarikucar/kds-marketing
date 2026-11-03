//! Template grammar (spec §3.10; plan L4-T1): variables, fallbacks, literal braces, links and the
//! refused schemes.

mod support;

use jt_outreach::*;

fn reason(subject: &str, body: &str) -> String {
    match validate_template(subject, body) {
        Ok(_) => panic!("{subject:?} / {body:?} validated"),
        Err(e) => e.reason().to_owned(),
    }
}

fn body_reason(body: &str) -> String {
    reason("Konu", body)
}

#[test]
fn parses_vars_and_fallbacks() {
    let facts = validate_template(
        "{{company}} için bir öneri",
        "Merhaba {{contact_name|ekibiniz}},\n{{custom.opener}}\n{{ city }} şubeniz için {{company}}.\n{{sender_name}}",
    )
    .unwrap();
    assert_eq!(
        facts.vars,
        vec![
            Var::Company,
            Var::ContactName,
            Var::Custom("opener".into()),
            Var::City,
            Var::SenderName,
        ],
        "deduplicated, in first appearance order, subject first"
    );
    assert!(facts.links.is_empty());
    for (name, var) in [
        ("first_name", Var::FirstName),
        ("contact_name", Var::ContactName),
        ("company", Var::Company),
        ("city", Var::City),
        ("district", Var::District),
        ("sector", Var::Sector),
        ("sender_name", Var::SenderName),
        ("sender_company", Var::SenderCompany),
        ("custom.opener", Var::Custom("opener".into())),
    ] {
        assert_eq!(Var::parse(name), Ok(var.clone()));
        assert_eq!(var.key(), name);
        assert_eq!(
            serde_json::to_value(&var).unwrap(),
            serde_json::json!(name),
            "a variable serialises as its key"
        );
    }
    // A literal brace pair is written {{"{{"}} (and {{"}}"}}); single braces are plain text.
    let facts =
        validate_template("Konu", "Sözdizimi: {{\"{{\"}}ad{{\"}}\"}} ve {tek} süslü").unwrap();
    assert!(facts.vars.is_empty());
}

#[test]
fn unknown_var_is_refused() {
    for name in ["name", "Company", "email", "phone", "custom", "first-name"] {
        let err = validate_template("Konu", &format!("Merhaba {{{{{name}}}}}")).unwrap_err();
        assert_eq!(err.field(), "body");
        assert_eq!(err.reason(), "unknown_variable", "{name}");
    }
    let err = validate_template("{{email}} için", "Merhaba").unwrap_err();
    assert_eq!(
        err,
        TemplateError::UnknownVariable {
            field: "subject",
            name: "email".into()
        }
    );
    assert_eq!(err.to_string(), "subject: unknown_variable:email");
}

#[test]
fn unbalanced_braces_are_refused() {
    for body in [
        "Merhaba {{company",
        "Merhaba company}}",
        "}} {{company}}",
        "{{company}} }}",
        "{{{company}}}",
        "{{company{{city}}",
        "{{}}",
        "{{   }}",
        "{{|ekibiniz}}",
        "{{\"{{\"",
    ] {
        assert_eq!(body_reason(body), "unbalanced_braces", "{body:?}");
    }
    // A literal holds braces only.
    assert_eq!(body_reason("{{\"abc\"}}"), "literal_invalid");
    assert_eq!(body_reason("{{\"\"}}"), "literal_invalid");
    assert_eq!(reason("Konu {{company", "Merhaba"), "unbalanced_braces");
}

#[test]
fn custom_keys_are_bounded() {
    let max = "a".repeat(32);
    for name in ["custom.a", "custom.opener_2", &format!("custom.{max}")] {
        assert!(
            validate_template("Konu", &format!("{{{{{name}}}}}")).is_ok(),
            "{name}"
        );
    }
    for name in [
        format!("custom.{max}a"),
        "custom.Opener".into(),
        "custom.a-b".into(),
        "custom.".into(),
        "custom.açılış".into(),
    ] {
        assert_eq!(
            body_reason(&format!("{{{{{name}}}}}")),
            "custom_key",
            "{name}"
        );
    }
    let fallback = "x".repeat(80);
    assert!(validate_template("Konu", &format!("{{{{company|{fallback}}}}}")).is_ok());
    assert_eq!(
        body_reason(&format!("{{{{company|{fallback}x}}}}")),
        "fallback_invalid"
    );
    for body in [
        "{{company|}}",
        "{{company|   }}",
        "{{company|a{b}}",
        "{{company|a\nb}}",
    ] {
        assert_eq!(body_reason(body), "fallback_invalid", "{body:?}");
    }
}

#[test]
fn links_are_found_and_trimmed() {
    let facts = validate_template(
        "Konu",
        "Sitemiz: https://ornek.example.invalid/urun?a=1. Ayrıca (http://ornek.example.invalid/b), \
         <https://ornek.example.invalid/c>!\nTekrar: https://ornek.example.invalid/urun?a=1\n\
         Son: HTTPS://Ornek.example.invalid/D';",
    )
    .unwrap();
    assert_eq!(
        facts.links,
        vec![
            "https://ornek.example.invalid/urun?a=1",
            "http://ornek.example.invalid/b",
            "https://ornek.example.invalid/c",
            "HTTPS://Ornek.example.invalid/D",
        ],
        "trailing punctuation trimmed, deduplicated, in order, as written"
    );
    let many: String = (0..21)
        .map(|i| format!("https://ornek.example.invalid/{i}\n"))
        .collect();
    assert_eq!(body_reason(&many), "too_many_links");
    let twenty: String = (0..20)
        .map(|i| format!("https://ornek.example.invalid/{i}\n"))
        .collect();
    assert_eq!(validate_template("Konu", &twenty).unwrap().links.len(), 20);
    assert_eq!(
        body_reason("Bakınız https://ornek.example.invalid/{{company}}"),
        "link_has_variable"
    );
    assert_eq!(
        body_reason("Bakınız https://ornek.example.invalid/x{{\"{{\"}}"),
        "link_has_braces"
    );
    assert_eq!(body_reason("Bakınız https:// ve devamı"), "link_invalid");
    assert_eq!(
        body_reason(&format!(
            "https://ornek.example.invalid/{}",
            "a".repeat(2048)
        )),
        "link_too_long"
    );
    assert_eq!(
        reason("Bakınız https://ornek.example.invalid", "Merhaba"),
        "link_in_subject"
    );
}

#[test]
fn non_http_schemes_are_refused() {
    for body in [
        "javascript:alert(1)",
        "Tıkla: JavaScript:alert(1)",
        "data:text/html;base64,AAAA",
        "mailto:info@ornek.example.invalid",
        "file:///etc/passwd",
        "vbscript:msgbox",
        "xhttps://ornek.example.invalid",
    ] {
        assert_eq!(body_reason(body), "link_scheme", "{body:?}");
    }
    assert_eq!(body_reason("http:ornek.example.invalid"), "link_invalid");
    assert_eq!(reason("javascript:alert(1)", "Merhaba"), "link_scheme");
    for body in [
        "Saat 10:30'da görüşelim.",
        "Not: yarın arayacağız.",
        "Tel: +90 500 000 00 00",
        "E-posta: info@ornek.example.invalid",
        "Oran 3:1",
    ] {
        assert!(validate_template("Konu", body).is_ok(), "{body:?}");
    }
}

#[test]
fn lengths_and_lines_are_bounded() {
    assert_eq!(reason("", "Merhaba"), "length");
    assert_eq!(reason("   ", "Merhaba"), "length");
    assert_eq!(reason(&"ş".repeat(201), "Merhaba"), "length");
    assert!(validate_template(&"ş".repeat(200), "Merhaba").is_ok());
    assert_eq!(reason("İki\nsatır", "Merhaba"), "subject_line");
    assert_eq!(reason("Sekme\tvar", "Merhaba"), "subject_line");
    assert_eq!(body_reason(""), "length");
    assert_eq!(body_reason(&"ş".repeat(20_001)), "length");
    assert!(validate_template("Konu", &"ş".repeat(20_000)).is_ok());
    assert_eq!(body_reason("Merhaba\u{7}"), "control_character");
    assert!(validate_template("Konu", "Merhaba,\r\n\tİyi günler").is_ok());
    assert!(validate_template_name("Tanışma e-postası").is_ok());
    for name in ["", "  ", "a\nb"] {
        assert!(validate_template_name(name).is_err(), "{name:?}");
    }
    assert!(validate_template_name(&"a".repeat(121)).is_err());
    assert_eq!(Lang::parse("tr"), Some(Lang::Tr));
    assert_eq!(Lang::En.key(), "en");
    assert_eq!(Lang::parse("de"), None);
}
