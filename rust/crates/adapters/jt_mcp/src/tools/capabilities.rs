//! `jeeta.capability.list`, `jeeta.capability.get`, `jeeta.capability.declare`,
//! `jeeta.capability.verify`, `jeeta.capability.mark_unreachable`, `jeeta.capability.set_policy`,
//! `jeeta.capability.retire`, `jeeta.capability.link_budget`, `jeeta.capability.unlink_budget`
//! and the group tools `jeeta.capability.groups_*`.
//!
//! Reading needs `workspace.read`, and so does verifying: the use case lets an agent verify its
//! own agent or device capability on its evidence alone. Every other change needs
//! `capabilities.manage`. The arguments mirror the panel's bodies; a policy is passed through as
//! written, for the use case's strict parser to judge, on both gates alike.

use jt_app::ctx::Ctx;
use jt_app::usecases::Deps;
use jt_app::usecases::capabilities::{self, CapabilityQuery, DeclareInput, parse_policy_strict};
use jt_app::usecases::groups;
use jt_capability::{
    BudgetItemId, CapabilityGroupId, CapabilityId, Evidence, KINDS, KindGroup, MAX_EVIDENCE_REFS,
};
use jt_tenancy::Permission;
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use super::{NoArgs, ToolDef, args, listed, to_json};
use crate::registry::{ToolFuture, schema_for};

/// The stored status keys a list may be filtered by, in their order of life.
const STATUSES: &[&str] = &["declared", "verified", "unreachable", "retired"];

pub(super) fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            use_case: "capability.list",
            description: "List the workspace's capabilities, the accounts, devices, agent \
                          connections, computer access and third-party tools it can act \
                          through, oldest first. Each carries its effective_status: declared, \
                          verified, stale (verified longer ago than its policy allows), \
                          unreachable or retired. Filter by kind group, kind key, stored status \
                          or capability group id. Returns {capabilities: [...]}. [risk: READ]",
            permission: Permission::WorkspaceRead,
            schema: schema_for::<ListArgs>,
            run: list,
        },
        ToolDef {
            use_case: "capability.get",
            description: "Read one capability by id: its kind, how it is reached (connector, \
                          agent or device), its status and the evidence of its last \
                          verification, its policy and the budget items it spends from, with \
                          its effective_status. [risk: READ]",
            permission: Permission::WorkspaceRead,
            schema: schema_for::<CapabilityArgs>,
            run: get,
        },
        ToolDef {
            use_case: "capability.declare",
            description: "Declare something the workspace can act through. kind_key is one of \
                          a closed list, in these kind groups: social_account, messaging, \
                          telephony, community, ads and calendar (accounts reached through a \
                          connector); device (phone, computer, printer, printer_3d, audio_io, \
                          camera, screen, scanner, usb_storage); agent_connection, \
                          computer_access and third_party (reached through you, the agent). \
                          key_detail only for third_party.other (kind_key \"other\"): the \
                          tool's name, 2 to 40 of a-z, 0-9, _ and -. connector_public holds \
                          public settings only, never a secret; a connector may name its hosts \
                          in connector_public.hosts. policy is optional. The capability starts \
                          declared: verify your own with jeeta.capability.verify. Returns the \
                          capability. [risk: WRITE]",
            permission: Permission::CapabilitiesManage,
            schema: schema_for::<DeclareArgs>,
            run: declare,
        },
        ToolDef {
            use_case: "capability.verify",
            description: "Mark a capability verified on your evidence: for your own \
                          agent/device capabilities; connectors are verified by their probe. \
                          Your own are those you declared through this connection; verifying \
                          one another connection or a person declared needs \
                          capabilities.manage. evidence.text says what you ran or saw (the adb devices line, the \
                          printer's status page); evidence.refs may name what backs it (a \
                          serial number, a file or screenshot id). The evidence is recorded as \
                          your claim and never checked; the verification lasts the policy's \
                          verify_max_age_days, then the capability reads as stale until you \
                          verify it again. Returns the capability. [risk: WRITE]",
            permission: Permission::WorkspaceRead,
            schema: schema_for::<VerifyArgs>,
            run: verify,
        },
        ToolDef {
            use_case: "capability.mark_unreachable",
            description: "Mark a capability unreachable, with a reason of 1 to 500 characters \
                          (the phone is off, the account is locked). Verify it again once it is \
                          back. Returns the capability. [risk: WRITE]",
            permission: Permission::CapabilitiesManage,
            schema: schema_for::<UnreachableArgs>,
            run: mark_unreachable,
        },
        ToolDef {
            use_case: "capability.set_policy",
            description: "Replace a capability's policy: active_hours {tz, from, to, days} \
                          (an IANA zone or UTC, hours 0 to 24 with from before to, ISO weekdays \
                          1 to 7), daily_ops_cap, spend_cap_minor, requires_human_approval and \
                          verify_max_age_days (0 = never stale). A field left out takes its \
                          default; an unknown field is refused. Returns the capability. \
                          [risk: WRITE]",
            permission: Permission::CapabilitiesManage,
            schema: schema_for::<SetPolicyArgs>,
            run: set_policy,
        },
        ToolDef {
            use_case: "capability.retire",
            description: "Retire a capability for good, only with confirm: true: it leaves \
                          every group and budget item and can no longer be verified, grouped or \
                          linked; its record stays. Returns the capability. \
                          [risk: DESTRUCTIVE]",
            permission: Permission::CapabilitiesManage,
            schema: schema_for::<RetireArgs>,
            run: retire,
        },
        ToolDef {
            use_case: "capability.link_budget",
            description: "Link a capability to a budget item it spends from (from \
                          jeeta.budget.items_list). The item's kind must suit the capability: \
                          cash for most; an ad budget for ad accounts; the SMS budget for the \
                          SMS line; agent quotas or hours (never cash) for agent connections; \
                          consumables for printers. Returns the capability. [risk: WRITE]",
            permission: Permission::CapabilitiesManage,
            schema: schema_for::<LinkArgs>,
            run: link_budget,
        },
        ToolDef {
            use_case: "capability.unlink_budget",
            description: "Unlink a capability from a budget item it spends from. Returns the \
                          capability. [risk: WRITE]",
            permission: Permission::CapabilitiesManage,
            schema: schema_for::<LinkArgs>,
            run: unlink_budget,
        },
        ToolDef {
            use_case: "capability.groups.list",
            description: "List the workspace's capability groups (a brand, a branch, a persona, \
                          a purpose), oldest first, each with its member capabilities. Returns \
                          {groups: [...]}. [risk: READ]",
            permission: Permission::WorkspaceRead,
            schema: schema_for::<NoArgs>,
            run: groups_list,
        },
        ToolDef {
            use_case: "capability.groups.create",
            description: "Create a capability group with a name of 1 to 64 characters, unique \
                          in the workspace whatever its case, and an optional purpose. Groups do \
                          not nest. Returns the group, with no members yet. [risk: WRITE]",
            permission: Permission::CapabilitiesManage,
            schema: schema_for::<GroupCreateArgs>,
            run: groups_create,
        },
        ToolDef {
            use_case: "capability.groups.rename",
            description: "Rename a capability group, by group id. Returns the group. \
                          [risk: WRITE]",
            permission: Permission::CapabilitiesManage,
            schema: schema_for::<GroupRenameArgs>,
            run: groups_rename,
        },
        ToolDef {
            use_case: "capability.groups.delete",
            description: "Delete a capability group, by group id; its member capabilities \
                          stay. [risk: DESTRUCTIVE]",
            permission: Permission::CapabilitiesManage,
            schema: schema_for::<GroupArgs>,
            run: groups_delete,
        },
        ToolDef {
            use_case: "capability.groups.add_member",
            description: "Add a capability to a group; a capability may be in many groups, \
                          and a retired one in none. Returns the group. [risk: WRITE]",
            permission: Permission::CapabilitiesManage,
            schema: schema_for::<MemberArgs>,
            run: groups_add_member,
        },
        ToolDef {
            use_case: "capability.groups.remove_member",
            description: "Remove a capability from a group; the capability itself stays. \
                          Returns the group. [risk: WRITE]",
            permission: Permission::CapabilitiesManage,
            schema: schema_for::<MemberArgs>,
            run: groups_remove_member,
        },
    ]
}

/// Which capabilities: every filter given must match.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ListArgs {
    /// A kind group key.
    #[serde(default)]
    #[schemars(schema_with = "optional_group_schema")]
    group: Option<String>,
    /// A kind key.
    #[serde(default)]
    #[schemars(schema_with = "optional_kind_schema")]
    kind: Option<String>,
    /// A stored status.
    #[serde(default)]
    #[schemars(schema_with = "optional_status_schema")]
    status: Option<String>,
    /// Members of this capability group only, from jeeta.capability.groups_list.
    #[serde(default)]
    group_id: Option<Uuid>,
}

/// Which capability.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct CapabilityArgs {
    /// The capability id, from jeeta.capability.list.
    capability_id: Uuid,
}

/// A new capability.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct DeclareArgs {
    /// The kind, from the closed list.
    #[schemars(schema_with = "kind_schema")]
    kind_key: String,
    /// For kind_key "other" only: the tool's name, 2 to 40 of a-z, 0-9, _ and -.
    #[serde(default)]
    key_detail: Option<String>,
    /// The workspace's name for it, 1 to 64 characters.
    name: String,
    /// At most 2000 characters.
    #[serde(default)]
    description: String,
    /// The provider's id of the account, page or line, if it has one.
    #[serde(default)]
    external_id: Option<String>,
    /// Public connector settings; never a secret.
    #[serde(default)]
    #[schemars(schema_with = "connector_public_schema")]
    connector_public: Value,
    /// The policy; none is the default policy.
    #[serde(default)]
    #[schemars(schema_with = "optional_policy_schema")]
    policy: Option<Value>,
}

/// The agent's proof.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(inline)]
struct EvidenceArgs {
    /// What you ran or saw, 1 to 4000 characters.
    text: String,
    /// A serial, a file or screenshot id; at most 20, each at most 256 characters.
    #[serde(default)]
    #[schemars(length(max = MAX_EVIDENCE_REFS))]
    refs: Vec<String>,
}

/// A capability and the evidence that it is in hand.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct VerifyArgs {
    /// The capability id, from jeeta.capability.list.
    capability_id: Uuid,
    evidence: EvidenceArgs,
}

/// A capability and why it cannot be reached.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct UnreachableArgs {
    /// The capability id, from jeeta.capability.list.
    capability_id: Uuid,
    /// Why, 1 to 500 characters.
    reason: String,
}

/// A capability and its whole new policy.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct SetPolicyArgs {
    /// The capability id, from jeeta.capability.list.
    capability_id: Uuid,
    /// The policy, replacing the current one.
    #[schemars(schema_with = "policy_schema")]
    policy: Value,
}

/// The capability to retire.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct RetireArgs {
    /// The capability id, from jeeta.capability.list.
    capability_id: Uuid,
    /// Must be true: retiring is final.
    #[serde(default)]
    confirm: bool,
}

/// A capability and a budget item.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct LinkArgs {
    /// The capability id, from jeeta.capability.list.
    capability_id: Uuid,
    /// The budget item id, from jeeta.budget.items_list.
    budget_item_id: Uuid,
}

/// A new group.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct GroupCreateArgs {
    /// 1 to 64 characters, unique in the workspace whatever its case.
    name: String,
    /// What the group is for, at most 2000 characters.
    #[serde(default)]
    purpose: Option<String>,
}

/// A group's new name.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct GroupRenameArgs {
    /// The group id, from jeeta.capability.groups_list.
    group_id: Uuid,
    /// 1 to 64 characters, unique in the workspace whatever its case.
    name: String,
}

/// Which group.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct GroupArgs {
    /// The group id, from jeeta.capability.groups_list.
    group_id: Uuid,
}

/// A group and a capability.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct MemberArgs {
    /// The group id, from jeeta.capability.groups_list.
    group_id: Uuid,
    /// The capability id, from jeeta.capability.list.
    capability_id: Uuid,
}

/// The JSON Schema of a kind key, naming every kind there is.
fn kind_schema(_: &mut SchemaGenerator) -> Schema {
    let keys: Vec<&str> = KINDS.iter().map(|k| k.key).collect();
    json_schema!({ "type": "string", "enum": keys })
}

/// The JSON Schema of `keys`, or null.
fn optional_enum(keys: Vec<&str>) -> Schema {
    let mut values: Vec<Value> = keys.into_iter().map(|k| json!(k)).collect();
    values.push(Value::Null);
    json_schema!({ "type": ["string", "null"], "enum": values })
}

/// [`kind_schema`], or null.
fn optional_kind_schema(_: &mut SchemaGenerator) -> Schema {
    optional_enum(KINDS.iter().map(|k| k.key).collect())
}

/// A kind group key, or null.
fn optional_group_schema(_: &mut SchemaGenerator) -> Schema {
    optional_enum(KindGroup::all().iter().map(KindGroup::key).collect())
}

/// A stored status key, or null.
fn optional_status_schema(_: &mut SchemaGenerator) -> Schema {
    optional_enum(STATUSES.to_vec())
}

/// The JSON Schema of the public connector fields: an object (or null for none).
fn connector_public_schema(_: &mut SchemaGenerator) -> Schema {
    json_schema!({
        "type": ["object", "null"],
        "description": "Public settings (a page name, a handle, granted scopes); never a \
                        password, token or key. hosts: the host names a connector reaches.",
        "properties": {
            "hosts": { "type": "array", "items": { "type": "string" }, "maxItems": 20 },
        },
    })
}

/// The JSON Schema of a policy as written.
fn policy_schema(_: &mut SchemaGenerator) -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "active_hours": {
                "type": ["object", "null"],
                "description": "When it may act; null for any time. One window a day, from \
                                before to; write an overnight window as two days' windows.",
                "properties": {
                    "tz": { "type": "string", "description": "UTC (default) or an IANA zone." },
                    "from": { "type": "integer", "minimum": 0, "maximum": 23 },
                    "to": { "type": "integer", "minimum": 1, "maximum": 24 },
                    "days": {
                        "type": "array",
                        "items": { "type": "integer", "minimum": 1, "maximum": 7 },
                        "description": "ISO weekdays, 1 = Monday.",
                    },
                },
                "required": ["from", "to", "days"],
                "additionalProperties": false,
            },
            "daily_ops_cap": { "type": ["integer", "null"], "minimum": 0 },
            "spend_cap_minor": { "type": ["integer", "null"], "minimum": 0 },
            "requires_human_approval": { "type": "boolean" },
            "verify_max_age_days": {
                "type": "integer",
                "minimum": 0,
                "maximum": 65535,
                "description": "Default 30; 0 = never stale.",
            },
        },
        "additionalProperties": false,
    })
}

/// [`policy_schema`], or null.
fn optional_policy_schema(generator: &mut SchemaGenerator) -> Schema {
    let mut schema = policy_schema(generator);
    schema.insert("type".into(), json!(["object", "null"]));
    schema
}

fn list<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let ListArgs {
            group,
            kind,
            status,
            group_id,
        } = args(raw)?;
        let query = CapabilityQuery {
            group,
            kind,
            status,
            group_id: group_id.map(CapabilityGroupId),
        };
        listed("capabilities", &capabilities::list(deps, ctx, query).await?)
    })
}

fn get<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let CapabilityArgs { capability_id } = args(raw)?;
        to_json(&capabilities::get(deps, ctx, CapabilityId(capability_id)).await?)
    })
}

fn declare<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let DeclareArgs {
            kind_key,
            key_detail,
            name,
            description,
            external_id,
            connector_public,
            policy,
        } = args(raw)?;
        let policy = match &policy {
            Some(value) => Some(parse_policy_strict(value)?),
            None => None,
        };
        let input = DeclareInput {
            kind_key,
            key_detail,
            name,
            description,
            external_id,
            connector_public,
            policy,
        };
        to_json(&capabilities::declare(deps, ctx, input).await?)
    })
}

fn verify<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let VerifyArgs {
            capability_id,
            evidence: EvidenceArgs { text, refs },
        } = args(raw)?;
        let evidence = Evidence { text, refs };
        to_json(&capabilities::verify(deps, ctx, CapabilityId(capability_id), evidence).await?)
    })
}

fn mark_unreachable<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let UnreachableArgs {
            capability_id,
            reason,
        } = args(raw)?;
        let id = CapabilityId(capability_id);
        to_json(&capabilities::mark_unreachable(deps, ctx, id, reason).await?)
    })
}

fn set_policy<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let SetPolicyArgs {
            capability_id,
            policy,
        } = args(raw)?;
        let policy = parse_policy_strict(&policy)?;
        let id = CapabilityId(capability_id);
        to_json(&capabilities::set_policy(deps, ctx, id, policy).await?)
    })
}

fn retire<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let RetireArgs {
            capability_id,
            confirm,
        } = args(raw)?;
        to_json(&capabilities::retire(deps, ctx, CapabilityId(capability_id), confirm).await?)
    })
}

fn link_budget<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let LinkArgs {
            capability_id,
            budget_item_id,
        } = args(raw)?;
        let (id, item) = (CapabilityId(capability_id), BudgetItemId(budget_item_id));
        to_json(&capabilities::link_budget(deps, ctx, id, item).await?)
    })
}

fn unlink_budget<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let LinkArgs {
            capability_id,
            budget_item_id,
        } = args(raw)?;
        let (id, item) = (CapabilityId(capability_id), BudgetItemId(budget_item_id));
        to_json(&capabilities::unlink_budget(deps, ctx, id, item).await?)
    })
}

fn groups_list<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let NoArgs {} = args(raw)?;
        listed("groups", &groups::list(deps, ctx).await?)
    })
}

fn groups_create<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let GroupCreateArgs { name, purpose } = args(raw)?;
        to_json(&groups::create(deps, ctx, name, purpose).await?)
    })
}

fn groups_rename<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let GroupRenameArgs { group_id, name } = args(raw)?;
        to_json(&groups::rename(deps, ctx, CapabilityGroupId(group_id), name).await?)
    })
}

fn groups_delete<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let GroupArgs { group_id } = args(raw)?;
        groups::delete(deps, ctx, CapabilityGroupId(group_id)).await?;
        Ok(json!({ "group_id": group_id, "deleted": true }))
    })
}

fn groups_add_member<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let MemberArgs {
            group_id,
            capability_id,
        } = args(raw)?;
        let (group, capability) = (CapabilityGroupId(group_id), CapabilityId(capability_id));
        to_json(&groups::add_member(deps, ctx, group, capability).await?)
    })
}

fn groups_remove_member<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let MemberArgs {
            group_id,
            capability_id,
        } = args(raw)?;
        let (group, capability) = (CapabilityGroupId(group_id), CapabilityId(capability_id));
        to_json(&groups::remove_member(deps, ctx, group, capability).await?)
    })
}

#[cfg(test)]
mod tests {
    use jt_capability::StoredStatus;

    use super::*;

    #[test]
    fn the_status_filter_names_every_stored_status() {
        for key in STATUSES {
            let status = StoredStatus::parse(key).unwrap();
            assert_eq!(status.key(), *key);
        }
        for status in [
            StoredStatus::Declared,
            StoredStatus::Verified,
            StoredStatus::Unreachable,
            StoredStatus::Retired,
        ] {
            assert!(STATUSES.contains(&status.key()), "{status:?}");
        }
    }
}
