//! Rows that carry a secret's hash print it masked: their `Debug` output (a log line, a panic or
//! an assertion message) never shows a password, session, invite or API-key hash, and still shows
//! the rest of the row.

use std::collections::BTreeSet;

use jt_app::ports::{
    ApiKeyRow, ApiKeyStatus, MembershipRow, OperatorRow, PlatformSessionRow, SessionRow, UserRow,
};
use jt_tenancy::{
    ApiKeyId, Email, MembershipId, MembershipStatus, OperatorId, RoleId, SessionId, UserId,
    WorkspaceId,
};
use time::OffsetDateTime;
use uuid::Uuid;

const HASH: &str = "secret-hash-0123456789";
const T0: OffsetDateTime = OffsetDateTime::UNIX_EPOCH;

fn email() -> Email {
    Email::parse("someone@example.com").unwrap()
}

/// `debug` masks the hash and keeps `visible`.
fn assert_masked(debug: &str, visible: &str) {
    assert!(!debug.contains(HASH), "the hash shows: {debug}");
    assert!(debug.contains("***"), "no mask: {debug}");
    assert!(debug.contains(visible), "{visible} is missing: {debug}");
}

#[test]
fn secret_hashes_are_masked_in_debug_output() {
    let user = UserRow {
        id: UserId(Uuid::from_u128(1)),
        email: email(),
        password_hash: HASH.to_owned(),
        display_name: "Görünen Ad".to_owned(),
        created_at: T0,
    };
    assert_masked(&format!("{user:?}"), "Görünen Ad");

    let session = SessionRow {
        id: SessionId(Uuid::from_u128(2)),
        user_id: UserId(Uuid::from_u128(1)),
        token_hash: HASH.to_owned(),
        current_workspace_id: None,
        created_at: T0,
        expires_at: T0,
        revoked_at: None,
    };
    assert_masked(&format!("{session:?}"), "current_workspace_id: None");

    let invite = MembershipRow {
        id: MembershipId(Uuid::from_u128(3)),
        workspace_id: WorkspaceId(Uuid::from_u128(4)),
        user_id: None,
        role_id: RoleId(Uuid::from_u128(5)),
        status: MembershipStatus::Invited,
        invited_email: Some(email()),
        invite_token_hash: Some(HASH.to_owned()),
        invite_expires_at: Some(T0),
        invited_by: None,
        created_at: T0,
    };
    assert_masked(&format!("{invite:?}"), "Invited");
    // A row without an invite has no hash to mask.
    let member = MembershipRow {
        invite_token_hash: None,
        status: MembershipStatus::Active,
        ..invite
    };
    assert!(format!("{member:?}").contains("invite_token_hash: None"));

    let key = ApiKeyRow {
        id: ApiKeyId(Uuid::from_u128(6)),
        workspace_id: WorkspaceId(Uuid::from_u128(4)),
        name: "gece işleri".to_owned(),
        prefix: "jt_live_abcd".to_owned(),
        key_hash: HASH.to_owned(),
        scopes: BTreeSet::new(),
        issued_by: UserId(Uuid::from_u128(1)),
        status: ApiKeyStatus::Active,
        created_at: T0,
        last_used_at: None,
        revoked_at: None,
    };
    assert_masked(&format!("{key:?}"), "jt_live_abcd");

    let operator = OperatorRow {
        id: OperatorId(Uuid::from_u128(7)),
        email: email(),
        password_hash: HASH.to_owned(),
        created_at: T0,
    };
    assert_masked(&format!("{operator:?}"), "someone@example.com");

    let platform_session = PlatformSessionRow {
        id: Uuid::from_u128(8),
        operator_id: OperatorId(Uuid::from_u128(7)),
        token_hash: HASH.to_owned(),
        created_at: T0,
        expires_at: T0,
    };
    assert_masked(&format!("{platform_session:?}"), "operator_id");
}
