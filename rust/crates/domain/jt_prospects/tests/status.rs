//! The pool's status machine (spec §3.2) and the do-not-contact scrub.

mod support;

use jt_prospects::*;
use support::*;

const STATUSES: [ProspectStatus; 5] = [
    ProspectStatus::New,
    ProspectStatus::Qualified,
    ProspectStatus::Rejected,
    ProspectStatus::Promoted,
    ProspectStatus::DoNotContact,
];

fn events() -> Vec<StatusEvent> {
    vec![
        StatusEvent::Qualify,
        StatusEvent::Reject {
            reason: RejectReason::NotIcp,
        },
        StatusEvent::Reopen,
        StatusEvent::Promote,
        StatusEvent::DoNotContact {
            reason: DncReason::Objected,
        },
    ]
}

/// Spec §3.2, row by row.
fn allowed() -> Vec<(ProspectStatus, usize, ProspectStatus)> {
    use ProspectStatus::*;
    vec![
        (New, 0, Qualified),
        (New, 1, Rejected),
        (Qualified, 1, Rejected),
        (Rejected, 2, New),
        (Qualified, 3, Promoted),
        (New, 3, Promoted),
        (New, 4, DoNotContact),
        (Qualified, 4, DoNotContact),
        (Rejected, 4, DoNotContact),
    ]
}

#[test]
fn every_allowed_transition() {
    let events = events();
    for (from, e, to) in allowed() {
        assert_eq!(
            next_status(from, &events[e]),
            Ok(to),
            "{from:?} {:?}",
            events[e]
        );
    }
}

#[test]
fn every_other_pair_is_refused() {
    let events = events();
    let allowed = allowed();
    let mut refused = 0;
    for from in STATUSES {
        for (i, event) in events.iter().enumerate() {
            if allowed.iter().any(|(f, e, _)| *f == from && *e == i) {
                continue;
            }
            let err = next_status(from, event).expect_err("not in the table");
            assert_eq!(err.from, from.key());
            refused += 1;
        }
    }
    assert_eq!(refused, 25 - allowed.len());
    let err = next_status(
        ProspectStatus::Promoted,
        &StatusEvent::Reject {
            reason: RejectReason::Other,
        },
    )
    .unwrap_err();
    assert_eq!(err.to_string(), "a promoted prospect cannot be rejected");
}

#[test]
fn status_and_reason_keys_are_stable() {
    let keys: Vec<&str> = STATUSES.iter().map(|s| s.key()).collect();
    assert_eq!(
        keys,
        ["new", "qualified", "rejected", "promoted", "do_not_contact"]
    );
    for s in STATUSES {
        assert_eq!(ProspectStatus::parse(s.key()), Some(s));
        assert_eq!(
            serde_json::to_value(s).unwrap(),
            serde_json::Value::String(s.key().into())
        );
    }
    let reasons: Vec<&str> = RejectReason::ALL.iter().map(|r| r.key()).collect();
    assert_eq!(
        reasons,
        [
            "not_icp",
            "closed_business",
            "no_contact_data",
            "competitor",
            "already_customer",
            "duplicate",
            "other"
        ]
    );
    let dnc: Vec<&str> = DncReason::ALL.iter().map(|r| r.key()).collect();
    assert_eq!(dnc, ["objected", "legal", "other"]);
}

#[test]
fn scrub_for_dnc_empties_personal_fields_and_keeps_ids() {
    let mut i = input();
    i.email = Some(field("bilgi@ornek-kafe.example.invalid".into()));
    i.website = Some(field("https://ornek-kafe.example.invalid".into()));
    i.instagram = Some(field("ornek.kafe".into()));
    i.address = Some(field("Örnek Sokak No 0, Kadıköy".into()));
    i.contact_person = Some(field(ContactPerson {
        name: "Ayşe Örnek".into(),
        role: "Kurucu".into(),
    }));
    i.size = Some(field(SizeHint {
        branches: Some(2),
        employees: Some(EmployeeBand::B1To9),
        note: Some("two branches".into()),
    }));
    i.signals = vec![SignalInput {
        text: "new menu".into(),
        source: url("https://ornek-kafe.example.invalid/menu"),
    }];
    i.notes = "a busy corner cafe".into();
    i.labels = vec!["sicak".into()];
    i.discovered_at = vec![url("https://directory.example.invalid/ornek")];
    let mut p = prospect(i);
    let task = p.research_task_id;
    scrub_for_dnc(&mut p);
    assert_eq!(p.business_name, "—");
    assert_eq!(p.contact, ContactFields::default());
    assert_eq!(p.size, None);
    assert!(p.signals.is_empty());
    assert!(p.notes.is_empty());
    assert!(p.labels.is_empty());
    assert!(p.origin.discovered_at.is_empty());
    assert!(
        derive_keys(&p).is_empty(),
        "a scrubbed prospect holds no key"
    );
    // Ids and the record's own facts stay.
    assert_eq!(p.id, pid(1));
    assert_eq!(p.workspace_id, ws());
    assert_eq!(p.research_task_id, task);
    assert_eq!(p.origin.recorder, agent());
    assert_eq!(p.sector.as_deref(), Some("kafe"));
}
