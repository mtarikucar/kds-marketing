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
fn owner_and_manager_have_all_permissions_rep_reads_and_works_inbox() {
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
        [Permission::WorkspaceRead, Permission::InboxWork]
            .into_iter()
            .collect()
    );
}

#[test]
fn permission_keys_round_trip() {
    for p in Permission::all() {
        assert_eq!(Permission::parse(p.key()), Some(*p));
    }
}

#[test]
fn capabilities_and_budget_permissions_belong_to_owner_and_manager_only() {
    for (p, key) in [
        (Permission::CapabilitiesManage, "capabilities.manage"),
        (Permission::BudgetManage, "budget.manage"),
    ] {
        assert_eq!(p.key(), key);
        assert_eq!(Permission::parse(key), Some(p));
        assert_eq!(serde_json::to_value(p).unwrap(), key);
        assert!(Permission::all().contains(&p), "{key}");
        assert!(SystemRole::Owner.permissions().contains(&p), "{key}");
        assert!(SystemRole::Manager.permissions().contains(&p), "{key}");
        assert!(!SystemRole::Rep.permissions().contains(&p), "{key}");
    }
    // The permissions that came before keep their order; the new ones follow.
    let keys: Vec<&str> = Permission::all().iter().map(Permission::key).collect();
    assert_eq!(
        keys,
        [
            "workspace.read",
            "team.manage",
            "api_keys.manage",
            "ledger.read",
            "capabilities.manage",
            "budget.manage",
            "inbox.work",
            "inbox.manage",
            "studio.work",
            "studio.manage",
        ]
    );
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

/// Giving `role` to a membership that holds the owner role now, or none (a new invitation).
fn grant(role: SystemRole, current_role_is_owner: bool) -> RoleGrant {
    let current = if current_role_is_owner {
        SystemRole::Owner.permissions()
    } else {
        BTreeSet::new()
    };
    RoleGrant {
        role_is_owner: role == SystemRole::Owner,
        role_permissions: role.permissions(),
        current_role_is_owner,
        current_role_permissions: current,
    }
}

/// Moving a membership that holds `from` now to `to`.
fn change(from: SystemRole, to: SystemRole) -> RoleGrant {
    RoleGrant {
        role_is_owner: to == SystemRole::Owner,
        role_permissions: to.permissions(),
        current_role_is_owner: from == SystemRole::Owner,
        current_role_permissions: from.permissions(),
    }
}

/// A custom role with `team.manage` and `workspace.read` only.
fn lead() -> ActorAuthority {
    ActorAuthority {
        permissions: BTreeSet::from([Permission::WorkspaceRead, Permission::TeamManage]),
        is_owner: false,
    }
}

fn none() -> BTreeSet<Permission> {
    BTreeSet::new()
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
    assert_eq!(
        can_remove_member(&rep, false, &none()),
        Err(TenancyError::Forbidden)
    );
    assert_eq!(
        can_define_role(&rep, &BTreeSet::new()),
        Err(TenancyError::Forbidden)
    );
    assert_eq!(
        can_update_role(&rep, &none(), &none()),
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
        can_remove_member(&manager(), true, &SystemRole::Owner.permissions()),
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
    assert_eq!(
        can_remove_member(&owner(), true, &SystemRole::Owner.permissions()),
        Ok(())
    );

    // Anything else is open to a manager.
    assert_eq!(
        can_grant_role(&manager(), &grant(SystemRole::Manager, false)),
        Ok(())
    );
    assert_eq!(
        can_remove_member(&manager(), false, &SystemRole::Manager.permissions()),
        Ok(())
    );
}

#[test]
fn a_member_whose_authority_exceeds_the_actors_is_not_the_actors_to_change() {
    let exceeds = Err(TenancyError::ExceedsOwnAuthority {
        missing: BTreeSet::from([
            Permission::ApiKeysManage,
            Permission::LedgerRead,
            Permission::CapabilitiesManage,
            Permission::BudgetManage,
            Permission::InboxWork,
            Permission::InboxManage,
            Permission::StudioWork,
            Permission::StudioManage,
        ]),
    });
    // A custom lead may neither demote nor remove a manager.
    assert_eq!(
        can_grant_role(&lead(), &change(SystemRole::Manager, SystemRole::Rep)),
        exceeds
    );
    assert_eq!(
        can_remove_member(&lead(), false, &SystemRole::Manager.permissions()),
        exceeds
    );
    // Rep now holds InboxWork too: a lead without it cannot change or remove that member.
    let missing_work = Err(TenancyError::ExceedsOwnAuthority {
        missing: BTreeSet::from([Permission::InboxWork]),
    });
    assert_eq!(
        can_grant_role(&lead(), &change(SystemRole::Rep, SystemRole::Rep)),
        missing_work
    );
    assert_eq!(
        can_remove_member(&lead(), false, &SystemRole::Rep.permissions()),
        missing_work
    );
    let mut inbox_lead = lead();
    inbox_lead.permissions.insert(Permission::InboxWork);
    assert_eq!(
        can_grant_role(&inbox_lead, &change(SystemRole::Rep, SystemRole::Rep)),
        Ok(())
    );
    assert_eq!(
        can_remove_member(&inbox_lead, false, &SystemRole::Rep.permissions()),
        Ok(())
    );
    // Both refusals name every missing permission, of the role given and of the target.
    let auditor = BTreeSet::from([Permission::LedgerRead]);
    let to_auditor_from_keys = RoleGrant {
        role_is_owner: false,
        role_permissions: auditor.clone(),
        current_role_is_owner: false,
        current_role_permissions: BTreeSet::from([Permission::ApiKeysManage]),
    };
    assert_eq!(
        can_grant_role(&lead(), &to_auditor_from_keys),
        Err(TenancyError::ExceedsOwnAuthority {
            missing: BTreeSet::from([Permission::ApiKeysManage, Permission::LedgerRead]),
        }),
        "the missing permissions of both sides, together"
    );

    // A manager may change or remove a rep, or another manager.
    for from in [SystemRole::Rep, SystemRole::Manager] {
        assert_eq!(
            can_grant_role(&manager(), &change(from, SystemRole::Rep)),
            Ok(())
        );
        assert_eq!(
            can_remove_member(&manager(), false, &from.permissions()),
            Ok(())
        );
    }

    // An owner is never held to the target's authority, even one narrowed to `team.manage`
    // (an owner's agent key): owner-only powers travel with it.
    let narrowed_owner = ActorAuthority {
        permissions: BTreeSet::from([Permission::TeamManage]),
        is_owner: true,
    };
    assert_eq!(
        can_remove_member(&narrowed_owner, false, &SystemRole::Manager.permissions()),
        Ok(())
    );
    assert_eq!(
        can_remove_member(&narrowed_owner, true, &SystemRole::Owner.permissions()),
        Ok(())
    );
    // But a role it gives is still held to its own permissions.
    assert_eq!(
        can_grant_role(
            &narrowed_owner,
            &change(SystemRole::Manager, SystemRole::Rep)
        ),
        Err(TenancyError::ExceedsOwnAuthority {
            missing: BTreeSet::from([Permission::WorkspaceRead, Permission::InboxWork]),
        })
    );
}

#[test]
fn updating_a_role_needs_its_present_permissions_too() {
    let keys = BTreeSet::from([Permission::ApiKeysManage]);
    let read = BTreeSet::from([Permission::WorkspaceRead]);
    // Stripping `api_keys.manage` from a role is not the lead's to do: it does not hold it.
    assert_eq!(
        can_update_role(&lead(), &keys, &read),
        Err(TenancyError::ExceedsOwnAuthority {
            missing: keys.clone(),
        })
    );
    // Nor is widening a role beyond its own permissions.
    assert_eq!(
        can_update_role(&lead(), &read, &keys),
        Err(TenancyError::ExceedsOwnAuthority {
            missing: keys.clone(),
        })
    );
    assert_eq!(can_update_role(&lead(), &read, &lead().permissions), Ok(()));
    // An owner may reshape any role.
    assert_eq!(can_update_role(&owner(), &keys, &read), Ok(()));
    assert_eq!(can_update_role(&manager(), &keys, &read), Ok(()));
}

#[test]
fn a_role_granted_or_defined_never_exceeds_the_actors_own_permissions() {
    let lead = ActorAuthority {
        permissions: BTreeSet::from([Permission::WorkspaceRead, Permission::TeamManage]),
        is_owner: false,
    };
    let exceeds = Err(TenancyError::ExceedsOwnAuthority {
        missing: BTreeSet::from([
            Permission::ApiKeysManage,
            Permission::LedgerRead,
            Permission::CapabilitiesManage,
            Permission::BudgetManage,
            Permission::InboxWork,
            Permission::InboxManage,
            Permission::StudioWork,
            Permission::StudioManage,
        ]),
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
        Err(TenancyError::ExceedsOwnAuthority {
            missing: BTreeSet::from([Permission::InboxWork])
        })
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
