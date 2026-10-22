use jt_tenancy::*;

#[test]
fn email_normalises_case_and_whitespace() {
    assert_eq!(
        Email::parse("  Tarik@Example.COM ").unwrap().as_str(),
        "tarik@example.com"
    );
}

#[test]
fn email_rejects_garbage() {
    for bad in ["", "a@", "@b.c", "a@b", "a b@c.d"] {
        assert!(Email::parse(bad).is_err(), "{bad}");
    }
}

#[test]
fn owner_and_manager_have_all_permissions_rep_reads_only() {
    assert_eq!(
        SystemRole::Owner.permissions().len(),
        Permission::all().len()
    );
    assert_eq!(
        SystemRole::Manager.permissions().len(),
        Permission::all().len()
    );
    assert_eq!(
        SystemRole::Rep.permissions(),
        [Permission::WorkspaceRead].into_iter().collect()
    );
}

#[test]
fn permission_keys_round_trip() {
    for p in Permission::all() {
        assert_eq!(Permission::parse(p.key()), Some(*p));
    }
}

#[test]
fn last_owner_cannot_be_demoted() {
    let actor = SystemRole::Owner.permissions();
    assert!(matches!(
        can_change_role(&actor, true),
        Err(TenancyError::LastOwner)
    ));
    assert!(can_change_role(&actor, false).is_ok());
    assert!(matches!(
        can_change_role(&SystemRole::Rep.permissions(), false),
        Err(TenancyError::Forbidden)
    ));
}

#[test]
fn status_keys_round_trip() {
    for s in [
        WorkspaceStatus::PendingPayment,
        WorkspaceStatus::Active,
        WorkspaceStatus::Suspended,
    ] {
        assert_eq!(WorkspaceStatus::parse(s.key()), Some(s));
    }
}

// Beyond the brief: pins the details later crates rely on.

#[test]
fn email_rejects_more_than_254_chars() {
    let local = "a".repeat(64);
    let ok = format!("{local}@{}.com", "b".repeat(254 - 64 - 1 - 4));
    assert_eq!(ok.len(), 254);
    assert!(Email::parse(&ok).is_ok());
    let long = format!("{local}@{}.com", "b".repeat(254 - 64 - 1 - 4 + 1));
    assert!(matches!(Email::parse(&long), Err(EmailError::TooLong)));
    assert!(matches!(Email::parse("   "), Err(EmailError::Empty)));
    assert!(matches!(Email::parse("a@@b.c"), Err(EmailError::Invalid)));
}

#[test]
fn email_deserialisation_validates() {
    let e: Email = serde_json::from_str("\" A@B.co \"").unwrap();
    assert_eq!(e.as_str(), "a@b.co");
    assert_eq!(serde_json::to_string(&e).unwrap(), "\"a@b.co\"");
    assert!(serde_json::from_str::<Email>("\"nope\"").is_err());
}

#[test]
fn ids_display_parse_and_serialise_as_plain_uuid() {
    let id = WorkspaceId::new_v7();
    assert_eq!(id.as_uuid().get_version_num(), 7);
    let text = id.to_string();
    assert_eq!(text, id.0.hyphenated().to_string());
    assert_eq!(text.parse::<WorkspaceId>().unwrap(), id);
    assert_eq!(serde_json::to_string(&id).unwrap(), format!("\"{text}\""));
    assert_eq!(WorkspaceId::from(id.0), id);
    assert!("not-a-uuid".parse::<UserId>().is_err());
}

#[test]
fn serde_names_match_keys() {
    for p in Permission::all() {
        assert_eq!(serde_json::to_value(p).unwrap(), p.key());
    }
    for r in [SystemRole::Owner, SystemRole::Manager, SystemRole::Rep] {
        assert_eq!(serde_json::to_value(r).unwrap(), r.key());
    }
    for s in [
        WorkspaceStatus::PendingPayment,
        WorkspaceStatus::Active,
        WorkspaceStatus::Suspended,
    ] {
        assert_eq!(serde_json::to_value(s).unwrap(), s.key());
    }
    for m in [
        MembershipStatus::Invited,
        MembershipStatus::Active,
        MembershipStatus::Removed,
    ] {
        assert_eq!(serde_json::to_value(m).unwrap(), m.key());
        assert_eq!(MembershipStatus::parse(m.key()), Some(m));
    }
}
