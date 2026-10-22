use jt_ledger::*;
use jt_tenancy::{AgentConnectionId, UserId, WorkspaceId};
use serde_json::json;
use time::OffsetDateTime;
use time::macros::datetime;

const AT: OffsetDateTime = datetime!(2026-10-22 09:30:00 UTC);

fn entry(actor: Actor, payload: serde_json::Value) -> LedgerEntry {
    LedgerEntry::new(
        WorkspaceId::new_v7(),
        actor,
        Action::new("team.invite").unwrap(),
        payload,
        AT,
    )
}

#[test]
fn action_requires_dotted_lowercase() {
    for bad in ["Team.Invite", "team", "team invite"] {
        assert!(Action::new(bad).is_err(), "{bad}");
    }
    for good in ["team.invite", "mcp.tool_call"] {
        assert_eq!(Action::new(good).unwrap().as_str(), good);
    }
}

#[test]
fn redacted_masks_secret_keys_at_any_depth() {
    let human = Actor::Human {
        user_id: UserId::new_v7(),
    };
    let e = entry(human, json!({"token":"x","nested":{"api_key":"y","ok":1}}));
    let r = e.redacted();
    assert_eq!(
        r.payload,
        json!({"token":"***","nested":{"api_key":"***","ok":1}})
    );
}

#[test]
fn entry_serialises_actor_tagged() {
    let connection_id = AgentConnectionId::new_v7();
    let user_id = UserId::new_v7();
    let e = entry(
        Actor::Agent {
            connection_id,
            user_id,
        },
        json!({}),
    );
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(
        v["actor"],
        json!({
            "kind": "agent",
            "connection_id": connection_id.to_string(),
            "user_id": user_id.to_string(),
        })
    );
}

// Beyond the brief: pins the details later crates rely on.

#[test]
fn action_rejects_edge_shapes() {
    for bad in [
        "",
        ".",
        ".team.invite",
        "team.invite.",
        "team-invite.x",
        "ekip.davet\u{131}",
    ] {
        assert!(
            matches!(Action::new(bad), Err(LedgerError::InvalidAction(ref s)) if s == bad),
            "{bad}"
        );
    }
    assert!(Action::new("v2.team_9.invite").is_ok());
    assert!(serde_json::from_str::<Action>("\"Team.Invite\"").is_err());
    assert_eq!(
        serde_json::from_str::<Action>("\"team.invite\"").unwrap(),
        Action::new("team.invite").unwrap()
    );
}

#[test]
fn redaction_is_case_insensitive_reaches_into_arrays_and_leaves_the_original() {
    let payload = json!({
        "Password": "p",
        "SECRET": {"deep": "s"},
        "items": [{"Token": "t", "name": "a"}, [{"api_key": "k"}], "token"],
        "tokens": "kept",
        "nested": {"password_hint": "kept"}
    });
    let e = entry(
        Actor::System {
            component: "scheduler".to_owned(),
        },
        payload.clone(),
    );
    let r = e.redacted();
    assert_eq!(
        r.payload,
        json!({
            "Password": "***",
            "SECRET": "***",
            "items": [{"Token": "***", "name": "a"}, [{"api_key": "***"}], "token"],
            "tokens": "kept",
            "nested": {"password_hint": "kept"}
        })
    );
    assert_eq!(e.payload, payload);
    assert_eq!(r.actor, e.actor);
    assert_eq!(r.action, e.action);
    assert_eq!(r.at, e.at);
    assert_eq!(r.workspace_id, e.workspace_id);
}

#[test]
fn entry_round_trips_through_json_with_rfc3339_time() {
    let mut e = entry(
        Actor::Human {
            user_id: UserId::new_v7(),
        },
        json!({"n": 1}),
    );
    e.subject = Some(Subject {
        kind: "membership".to_owned(),
        id: "m-1".to_owned(),
    });
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["at"], "2026-10-22T09:30:00Z");
    assert_eq!(v["action"], "team.invite");
    assert_eq!(v["actor"]["kind"], "human");
    assert_eq!(v["subject"], json!({"kind": "membership", "id": "m-1"}));
    assert_eq!(v["strategy_version_id"], serde_json::Value::Null);
    let back: LedgerEntry = serde_json::from_value(v).unwrap();
    assert_eq!(back, e);
}

#[test]
fn action_rejects_empty_segments() {
    for bad in ["team..invite", "a.b..c", "a...b"] {
        assert!(
            matches!(Action::new(bad), Err(LedgerError::InvalidAction(ref s)) if s == bad),
            "{bad}"
        );
    }
    assert!(serde_json::from_str::<Action>("\"team..invite\"").is_err());
    assert!(Action::new("a.b.c").is_ok());
}

#[test]
fn redaction_masks_every_secret_key_by_exact_name_in_any_case() {
    let secret_keys = [
        "password",
        "token",
        "secret",
        "api_key",
        "access_token",
        "refresh_token",
        "apikey",
        "authorization",
        "client_secret",
        "key_hash",
        "token_hash",
        "invite_token",
        "plaintext",
    ];
    // The list is public so other crates can refuse such keys where secrets must never appear.
    assert_eq!(REDACTED_KEYS, secret_keys);
    let mut payload = serde_json::Map::new();
    let mut expected = serde_json::Map::new();
    for key in secret_keys {
        payload.insert(key.to_owned(), json!("s"));
        payload.insert(key.to_uppercase(), json!({"deep": "s"}));
        expected.insert(key.to_owned(), json!("***"));
        expected.insert(key.to_uppercase(), json!("***"));
    }
    // Near misses are not secret keys: only an exact (case-insensitive) name is masked.
    for kept in [
        "key",
        "hash",
        "token_count",
        "plaintext_length",
        "authorized",
        "prefix",
    ] {
        payload.insert(kept.to_owned(), json!("kept"));
        expected.insert(kept.to_owned(), json!("kept"));
    }
    let e = entry(
        Actor::System {
            component: "test".to_owned(),
        },
        json!({ "outer": [serde_json::Value::Object(payload)] }),
    );
    assert_eq!(
        e.redacted().payload,
        json!({ "outer": [serde_json::Value::Object(expected)] })
    );
}
