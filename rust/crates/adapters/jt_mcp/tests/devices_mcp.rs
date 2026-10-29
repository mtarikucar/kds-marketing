//! The `jeeta.devices.*` tools (device bridge D1-T6): their permissions, risks and schemas, what
//! they tell an agent, and a round trip through the tools: a phone listed, a command run on it and
//! answered by its bridge, a command left queued and followed, a refusal with its reason, and the
//! phone's log.

use std::collections::BTreeMap;
use std::sync::Arc;

use jt_app::catalog::Risk;
use jt_app::ctx::Ctx;
use jt_app::ports::devices::{DeviceCommand, TEXT_UNICODE};
use jt_app::usecases::devices::bridge::{self, CommandsQuery, RegisterIn, ResultsIn};
use jt_device_protocol::{CommandResult, Outcome, PhoneReport, Platform, ResultIn};
use jt_ledger::Actor;
use jt_tenancy::{Permission, SystemRole};
use jt_testkit::fakes::files::MemoryFiles;
use jt_testkit::fakes::{FIXED_NOW, InMemoryUow};
use serde_json::{Value, json};

fn tools() -> BTreeMap<&'static str, jt_mcp::ToolSpec> {
    jt_mcp::registry()
        .into_iter()
        .filter(|t| t.name.starts_with("jeeta.devices."))
        .map(|t| (t.name, t))
        .collect()
}

#[test]
fn tools_listed_with_schemas() {
    let tools = tools();
    let expected = [
        ("jeeta.devices.list", "devices.list", Risk::Read),
        ("jeeta.devices.observe", "devices.observe", Risk::Write),
        ("jeeta.devices.act", "devices.act", Risk::Write),
        (
            "jeeta.devices.command_get",
            "devices.command_get",
            Risk::Read,
        ),
        ("jeeta.devices.commands", "devices.commands", Risk::Read),
    ];
    assert_eq!(tools.len(), expected.len());
    for (name, use_case, risk) in expected {
        let tool = &tools[name];
        assert_eq!(tool.use_case, use_case, "{name}");
        assert_eq!(tool.permission, Permission::DevicesWork, "{name}");
        assert_eq!(tool.risk, risk, "{name}");
        assert!(tool.description.ends_with(jt_mcp::risk_tag(risk)), "{name}");
        let schema = tool.input_schema.as_value();
        assert_eq!(schema["type"], "object", "{name}");
        assert_eq!(schema["additionalProperties"], false, "{name}");
        assert!(!schema.to_string().contains("$ref"), "{name}");
    }
    let schema = |name: &str| tools[name].input_schema.as_value().clone();
    // Listing takes no argument.
    let list = schema("jeeta.devices.list");
    assert!(list["required"].is_null(), "{list}");
    assert!(
        list["properties"].as_object().is_none_or(|p| p.is_empty()),
        "{list}"
    );
    assert_eq!(
        schema("jeeta.devices.act")["required"],
        json!(["capability_id", "command"])
    );
    assert_eq!(
        schema("jeeta.devices.observe")["required"],
        json!(["capability_id"])
    );
    assert_eq!(
        schema("jeeta.devices.command_get")["required"],
        json!(["command_id"])
    );
    assert_eq!(
        schema("jeeta.devices.commands")["required"],
        json!(["capability_id"])
    );
    assert_eq!(
        schema("jeeta.devices.commands")["properties"]["limit"]["maximum"],
        200
    );
    // Every wait is bounded to 20 seconds.
    for name in [
        "jeeta.devices.act",
        "jeeta.devices.observe",
        "jeeta.devices.command_get",
    ] {
        assert_eq!(
            schema(name)["properties"]["wait_s"]["maximum"],
            20,
            "{name}"
        );
        assert_eq!(schema(name)["properties"]["wait_s"]["minimum"], 0, "{name}");
    }
    // The command is one object per kind, each tagged as the bridge reads it.
    let command = &schema("jeeta.devices.act")["properties"]["command"];
    let kinds: Vec<&str> = command["oneOf"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["properties"]["kind"]["const"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, DeviceCommand::KINDS);
    let shell = command["oneOf"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["properties"]["kind"]["const"] == "shell")
        .unwrap();
    assert_eq!(shell["required"], json!(["kind", "argv"]));
    let tap = command["oneOf"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["properties"]["kind"]["const"] == "tap")
        .unwrap();
    assert_eq!(tap["properties"]["x"]["maximum"], 20_000);
    // The log says it carries no result, and where the result is read.
    let log = tools["jeeta.devices.commands"].description;
    assert!(log.contains("without its result"), "{log}");
    assert!(log.contains("jeeta.devices.command_get"), "{log}");
    assert_eq!(shell["properties"]["argv"]["maxItems"], 64);
    // The agent is told that a queued command is not a done one, how long it may wait, and that
    // text outside ASCII needs text.unicode.
    for name in ["jeeta.devices.act", "jeeta.devices.observe"] {
        let text = tools[name].description;
        for rule in [
            "A queued command is not a done command",
            "at most 20",
            "jeeta.devices.command_get",
        ] {
            assert!(text.contains(rule), "{name}: {rule}");
        }
    }
    let act = tools["jeeta.devices.act"].description;
    for word in [
        "text.unicode",
        "ADBKeyBoard",
        "unsupported_by_bridge",
        "unicode_unsupported",
        "device_offline",
        "ledger",
        "never an error",
    ] {
        assert!(act.contains(word), "{word}");
    }
}

#[tokio::test]
async fn a_command_round_trips_through_the_tools() {
    let uow = Arc::new(InMemoryUow::new());
    let mut deps = jt_testkit::fakes::deps(uow.clone());
    deps.files = Arc::new(MemoryFiles::default());
    let out = jt_app::usecases::auth::register(
        &deps,
        jt_app::usecases::auth::RegisterInput {
            email: "owner@phones.example".into(),
            password: "correct horse battery".into(),
            display_name: "Owner".into(),
            workspace_name: "Phones".into(),
        },
    )
    .await
    .unwrap();
    let (ws, owner) = (out.me.current_workspace.unwrap(), out.me.user_id);
    jt_testkit::flows::activate_workspace(&deps, ws).await;
    let owner_ctx = Ctx {
        workspace_id: ws,
        actor: Actor::Human { user_id: owner },
        permissions: SystemRole::Owner.permissions(),
        role_key: Some("owner".into()),
        now: FIXED_NOW,
        agent_connection_id: None,
    };
    let key = jt_app::usecases::api_keys::create(
        &deps,
        &owner_ctx,
        jt_app::usecases::api_keys::CreateKey {
            name: "phones".into(),
            scopes: vec!["devices.bridge".into()],
        },
    )
    .await
    .unwrap();
    let key = jt_app::usecases::api_keys::authenticate(&deps, &key.plaintext)
        .await
        .unwrap();
    let b = bridge::ctx_for_bridge(&key, FIXED_NOW);
    let features: Vec<String> = ["observe", "tap", "shell", "text"]
        .iter()
        .map(|k| (*k).to_owned())
        .collect();
    assert!(!features.contains(&TEXT_UNICODE.to_owned()));
    bridge::register(
        &deps,
        &b,
        RegisterIn {
            bridge_id: "PC-1".into(),
            version: "0.1.0".into(),
            protocol: 1,
            phones: vec![PhoneReport {
                platform: Platform::Android,
                serial: "SER1".into(),
                model: Some("Redmi 10C".into()),
                os_version: Some("13".into()),
                screen: None,
                features,
            }],
        },
    )
    .await
    .unwrap();
    let agent = Ctx {
        actor: Actor::Agent {
            connection_id: jt_tenancy::AgentConnectionId::new_v7(),
            user_id: owner,
        },
        role_key: None,
        ..owner_ctx.clone()
    };
    let tools = tools();
    let run = |name: &str, args: Value| {
        let tool = &tools[name];
        (tool.run)(&deps, &agent, args)
    };

    let listed = run("jeeta.devices.list", json!({})).await.unwrap();
    let phone = listed["phones"][0].clone();
    assert_eq!(phone["serial"], "SER1");
    assert_eq!(phone["online"], true);
    assert_eq!(phone["unicode"], false);
    let p = phone["capability_id"].clone();

    // Run on the phone while its bridge answers.
    let answer = async {
        let leased = bridge::commands(
            &deps,
            &b,
            CommandsQuery {
                wait_s: 5,
                limit: 20,
            },
        )
        .await
        .unwrap()
        .commands;
        let results = leased
            .iter()
            .map(|c| ResultIn {
                command_id: c.id,
                outcome: Outcome::Done {
                    result: CommandResult::shell(0, b"Redmi 10C\n", b""),
                },
                duration_ms: 40,
            })
            .collect();
        bridge::results(&deps, &b, ResultsIn { results })
            .await
            .unwrap();
    };
    let (done, ()) = tokio::join!(
        run(
            "jeeta.devices.act",
            json!({
                "capability_id": p,
                "command": { "kind": "shell", "argv": ["getprop", "ro.product.model"] },
                "wait_s": 10,
            })
        ),
        answer
    );
    let done = done.unwrap();
    assert_eq!(done["status"], "done");
    assert_eq!(done["kind"], "shell");
    assert_eq!(done["result"]["stdout"], "Redmi 10C\n");
    assert_eq!(
        done["command"]["argv"],
        json!(["getprop", "ro.product.model"])
    );

    // Left queued when nothing answers in time; followed by its id.
    let queued = run(
        "jeeta.devices.act",
        json!({ "capability_id": p, "command": { "kind": "tap", "x": 1, "y": 2 }, "wait_s": 0 }),
    )
    .await
    .unwrap();
    assert_eq!(queued["status"], "queued");
    let followed = run(
        "jeeta.devices.command_get",
        json!({ "command_id": queued["command_id"], "wait_s": 0 }),
    )
    .await
    .unwrap();
    assert_eq!(followed["status"], "queued");
    assert_eq!(followed["command_id"], queued["command_id"]);

    // A refusal carries its reason; an argument a tool does not take is refused.
    let refused = run(
        "jeeta.devices.act",
        json!({ "capability_id": p, "command": { "kind": "text", "value": "Ayşe" } }),
    )
    .await
    .unwrap_err();
    assert_eq!(refused.details["reason"], "unicode_unsupported");
    let refused = run(
        "jeeta.devices.act",
        json!({ "capability_id": p, "command": { "kind": "screenshot" }, "wait_s": 0 }),
    )
    .await
    .unwrap_err();
    assert_eq!(refused.details["reason"], "unsupported_by_bridge");
    assert_eq!(refused.details["kind"], "screenshot");
    assert!(
        run(
            "jeeta.devices.act",
            json!({ "capability_id": p, "command": { "kind": "tap", "x": 1, "y": 2 }, "wait": 1 }),
        )
        .await
        .is_err()
    );
    assert!(
        run(
            "jeeta.devices.act",
            json!({ "capability_id": p, "command": { "kind": "tap", "x": 1, "y": 2, "z": 3 } }),
        )
        .await
        .is_err()
    );

    // The phone's log, newest first.
    let log = run(
        "jeeta.devices.commands",
        json!({ "capability_id": p, "limit": 5 }),
    )
    .await
    .unwrap();
    let ids: Vec<&Value> = log["commands"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| &c["command_id"])
        .collect();
    assert_eq!(ids, [&queued["command_id"], &done["command_id"]]);
    for entry in log["commands"].as_array().unwrap() {
        assert!(entry.get("result").is_none(), "{entry}");
    }
    // One command, read by its id, carries its result.
    let one = run(
        "jeeta.devices.command_get",
        json!({ "command_id": done["command_id"], "wait_s": 0 }),
    )
    .await
    .unwrap();
    assert_eq!(
        one["result"]["stdout"],
        "Redmi 10C
"
    );
}
