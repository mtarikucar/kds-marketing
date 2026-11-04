//! The `jeeta.outreach.*` tools (leads L4-T7): their permissions, risks and schemas, and what
//! they tell an agent about the lock (`JEETA_OUTREACH_ENABLED`), the approval and the
//! business-recipient basis.

use std::collections::BTreeMap;

use jt_app::catalog::Risk;
use jt_tenancy::Permission;
use serde_json::json;

fn tools() -> BTreeMap<&'static str, jt_mcp::ToolSpec> {
    jt_mcp::registry()
        .into_iter()
        .filter(|t| t.name.starts_with("jeeta.outreach."))
        .map(|t| (t.name, t))
        .collect()
}

#[test]
fn outreach_tools_listed_with_risks_and_permissions() {
    let tools = tools();
    let (work, manage) = (Permission::OutreachWork, Permission::OutreachManage);
    let expected = [
        ("templates_list", Risk::Read, work),
        ("templates_save", Risk::Write, work),
        ("templates_archive", Risk::Write, work),
        ("campaigns_list", Risk::Read, work),
        ("campaigns_get", Risk::Read, work),
        ("campaigns_save", Risk::Write, work),
        ("audience_preview", Risk::Read, work),
        ("campaigns_launch", Risk::Write, work),
        ("campaigns_approve", Risk::Write, manage),
        ("campaigns_control", Risk::Write, work),
        ("enroll", Risk::Write, work),
        ("enrollments_list", Risk::Read, work),
        ("enrollments_stop", Risk::Write, work),
        ("personalize", Risk::Write, work),
        ("test_send", Risk::Write, work),
        ("report", Risk::Read, work),
        ("settings_get", Risk::Read, work),
        ("settings_set", Risk::Write, manage),
    ];
    assert_eq!(tools.len(), expected.len());
    for (action, risk, permission) in expected {
        let name = format!("jeeta.outreach.{action}");
        let tool = &tools[name.as_str()];
        assert_eq!(tool.use_case, format!("outreach.{action}"), "{name}");
        assert_eq!(tool.permission, permission, "{name}");
        assert_eq!(tool.risk, risk, "{name}");
        assert!(tool.description.ends_with(jt_mcp::risk_tag(risk)), "{name}");
        let schema = tool.input_schema.as_value();
        assert_eq!(schema["type"], "object", "{name}");
        assert_eq!(schema["additionalProperties"], false, "{name}");
        assert!(!schema.to_string().contains("$ref"), "{name}");
    }
    let schema = |name: &str| tools[name].input_schema.as_value().clone();
    assert_eq!(
        schema("jeeta.outreach.campaigns_launch")["required"],
        json!(["campaign_id", "expected_revision"])
    );
    assert_eq!(
        schema("jeeta.outreach.test_send")["required"],
        json!(["campaign_id"])
    );
    assert_eq!(
        schema("jeeta.outreach.report")["required"],
        json!(["from", "to"])
    );
}

/// Every tool that can lead to an email names the platform switch and the business-recipient
/// basis; the approval and the settings say who may open what.
#[test]
fn descriptions_name_the_lock_the_approval_and_the_basis() {
    let tools = tools();
    for action in [
        "campaigns_launch",
        "campaigns_approve",
        "campaigns_control",
        "enroll",
        "test_send",
    ] {
        let d = tools[format!("jeeta.outreach.{action}").as_str()].description;
        for word in [
            "JEETA_OUTREACH_ENABLED",
            "outreach_disabled_on_platform",
            "business-recipient basis",
            "counsel's confirmation",
            "one-click unsubscribe",
        ] {
            assert!(d.contains(word), "{action}: {word}");
        }
    }
    let launch = tools["jeeta.outreach.campaigns_launch"].description;
    for word in [
        "awaiting_approval",
        "outreach.manage",
        "sender_identity_missing",
    ] {
        assert!(launch.contains(word), "{word}");
    }
    let approve = tools["jeeta.outreach.campaigns_approve"].description;
    assert!(approve.contains("human_required"));
    let settings = tools["jeeta.outreach.settings_set"].description;
    for word in [
        "b2b_basis",
        "legal_ack",
        "counsel_confirmed",
        "owner_required",
        "an agent never can",
        "JEETA_OUTREACH_ENABLED",
    ] {
        assert!(settings.contains(word), "{word}");
    }
    let test = tools["jeeta.outreach.test_send"].description;
    assert!(test.contains("own login address only"));
    assert!(test.contains("not_a_members_login_address"));
    let preview = tools["jeeta.outreach.audience_preview"].description;
    assert!(preview.contains("no_basis"));
}

/// Every `jeeta.*` tool an outreach description names is a registered tool.
#[test]
fn outreach_descriptions_name_only_registered_tools() {
    let registered: Vec<&str> = jt_mcp::registry().iter().map(|t| t.name).collect();
    let mut named = Vec::new();
    for tool in tools().values() {
        for (i, _) in tool.description.match_indices("jeeta.") {
            let name: String = tool.description[i..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '_')
                .collect();
            named.push((tool.name, name.trim_end_matches('.').to_owned()));
        }
    }
    assert!(!named.is_empty());
    for (tool, name) in named {
        assert!(registered.contains(&name.as_str()), "{tool} names {name}");
    }
}
