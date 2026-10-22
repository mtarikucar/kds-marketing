use std::collections::BTreeSet;

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

fn owner() -> ActorAuthority {
    ActorAuthority {
        permissions: SystemRole::Owner.permissions(),
        is_owner: true,
    }
}

fn manager() -> ActorAuthority {
    ActorAuthority {
        permissions: SystemRole::Manager.permissions(),
        is_owner: false,
    }
}

fn grant(role: SystemRole, current_role_is_owner: bool) -> RoleGrant {
    RoleGrant {
        role_is_owner: role == SystemRole::Owner,
        role_permissions: role.permissions(),
        current_role_is_owner,
    }
}

#[test]
fn granting_a_role_needs_team_manage() {
    let rep = ActorAuthority {
        permissions: SystemRole::Rep.permissions(),
        is_owner: false,
    };
    assert_eq!(
        can_grant_role(&rep, &grant(SystemRole::Rep, false)),
        Err(TenancyError::Forbidden)
    );
    assert_eq!(can_remove_member(&rep, false), Err(TenancyError::Forbidden));
    assert_eq!(
        can_define_role(&rep, &BTreeSet::new()),
        Err(TenancyError::Forbidden)
    );
}

#[test]
fn only_an_owner_grants_changes_or_removes_the_owner_role() {
    // Granting owner, changing an owner's role, removing an owner.
    assert_eq!(
        can_grant_role(&manager(), &grant(SystemRole::Owner, false)),
        Err(TenancyError::OwnerOnly)
    );
    assert_eq!(
        can_grant_role(&manager(), &grant(SystemRole::Manager, true)),
        Err(TenancyError::OwnerOnly)
    );
    assert_eq!(
        can_remove_member(&manager(), true),
        Err(TenancyError::OwnerOnly)
    );
    assert_eq!(
        can_grant_role(&owner(), &grant(SystemRole::Owner, false)),
        Ok(())
    );
    assert_eq!(
        can_grant_role(&owner(), &grant(SystemRole::Rep, true)),
        Ok(())
    );
    assert_eq!(can_remove_member(&owner(), true), Ok(()));

    // Anything else is open to a manager.
    assert_eq!(
        can_grant_role(&manager(), &grant(SystemRole::Manager, false)),
        Ok(())
    );
    assert_eq!(can_remove_member(&manager(), false), Ok(()));
}

#[test]
fn a_role_granted_or_defined_never_exceeds_the_actors_own_permissions() {
    let lead = ActorAuthority {
        permissions: BTreeSet::from([Permission::WorkspaceRead, Permission::TeamManage]),
        is_owner: false,
    };
    let exceeds = Err(TenancyError::ExceedsOwnAuthority {
        missing: BTreeSet::from([Permission::ApiKeysManage, Permission::LedgerRead]),
    });
    assert_eq!(
        can_grant_role(&lead, &grant(SystemRole::Manager, false)),
        exceeds
    );
    assert_eq!(
        can_define_role(&lead, &SystemRole::Manager.permissions()),
        exceeds
    );
    assert_eq!(
        can_grant_role(&lead, &grant(SystemRole::Rep, false)),
        Ok(())
    );
    assert_eq!(
        can_define_role(
            &lead,
            &BTreeSet::from([Permission::WorkspaceRead, Permission::TeamManage])
        ),
        Ok(())
    );
    // Even an owner is held to its own permissions (all of them, for the owner role).
    assert_eq!(
        can_define_role(&owner(), &Permission::all().iter().copied().collect()),
        Ok(())
    );
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
