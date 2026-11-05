//! Shared builders of the jt_outreach tests. Every value is invented: `example.invalid`
//! addresses and made-up business names.
#![allow(dead_code)]

use jt_capability::Hours;
use jt_inbox::PersonId;
use jt_outreach::*;
use time::OffsetDateTime;
use time::macros::datetime;
use uuid::Uuid;

pub const NOW: OffsetDateTime = datetime!(2026-11-03 09:00 UTC);

/// A step snapshot of a template that validates, with the links validation found.
pub fn snapshot(subject: &str, body: &str, language: Lang) -> StepSnapshot {
    let facts = validate_template(subject, body).expect("a valid template");
    StepSnapshot {
        template_revision: 1,
        subject: subject.to_owned(),
        body: body.to_owned(),
        links: facts.links,
        language,
    }
}

pub fn vars(pairs: &[(&str, &str)]) -> RenderVars {
    RenderVars {
        values: pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect(),
    }
}

pub fn footer(source: FooterSource) -> Footer {
    Footer {
        sender_company: "Örnek Yazılım A.Ş.".into(),
        sender_address: "Örnek Mah. Deneme Sok. 1, İstanbul".into(),
        privacy_notice_url: "https://ornek-yazilim.example.invalid/kvkk".into(),
        unsubscribe_url: "https://jeeta.example.invalid/u/1/2/3".into(),
        source,
    }
}

pub fn step(n: u128, delay_days: u16) -> Step {
    Step {
        template_id: TemplateId(Uuid::from_u128(n)),
        delay_days,
        same_thread: false,
        snapshot: None,
    }
}

pub fn window() -> Hours {
    Hours {
        tz: "Europe/Istanbul".into(),
        from: 9,
        to: 18,
        days: vec![1, 2, 3, 4, 5],
    }
}

pub fn definition() -> Definition {
    Definition {
        sender_name: "Ayşe Deneme".into(),
        steps: vec![step(1, 0), step(2, 3)],
        audience: Audience {
            explicit: vec![PersonId(Uuid::from_u128(9))],
            ..Audience::default()
        },
        schedule: Schedule {
            start_at: None,
            window: window(),
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
