//! `jeeta.budget.items_list`, `jeeta.budget.items_create`, `jeeta.budget.spend_record` and
//! `jeeta.budget.spend_list`: the workspace's own money and caps, never the system's credit.
//!
//! Creating an item needs `budget.manage`; reading and recording spend need `workspace.read`, so
//! an agent can report what it spent. A spend's source is the caller, never an argument.

use jt_app::ctx::Ctx;
use jt_app::usecases::Deps;
use jt_app::usecases::budget::{self, BudgetItemInput, DEFAULT_SPEND_PAGE};
use jt_capability::{BudgetItemId, BudgetKind, BudgetSpendId, Period, Unit};
use jt_tenancy::Permission;
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use super::{NoArgs, ToolDef, args, listed, to_json};
use crate::registry::{ToolFuture, schema_for};

pub(super) fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            use_case: "budget.items.list",
            description: "List the workspace's budget items, its own money and caps (cash, \
                          ad_budget, sms_budget, agent_quota, agent_hours, consumable), oldest \
                          first, each with what was spent from it in its current period and \
                          what remains (negative when over the cap). Returns {items: [...]}. \
                          [risk: READ]",
            permission: Permission::WorkspaceRead,
            schema: schema_for::<NoArgs>,
            run: items_list,
        },
        ToolDef {
            use_case: "budget.items.create",
            description: "Create a budget item: a name, a kind, a unit that fits the kind \
                          ({kind: currency, value: TRY} for cash, ad and SMS budgets; {kind: \
                          count, value: a label such as spools} for consumables and agent \
                          quotas; {kind: minutes} for agent hours), a cap per period in that \
                          unit (minor units of a currency, so 100000 is 1000.00 TRY) and a \
                          period (daily, weekly, monthly or total). Returns the item. \
                          [risk: WRITE]",
            permission: Permission::BudgetManage,
            schema: schema_for::<ItemCreateArgs>,
            run: items_create,
        },
        ToolDef {
            use_case: "budget.spend.record",
            description: "Record what you spent from a budget item, in its unit (minor units of \
                          a currency), with an optional reference (an invoice number, a \
                          campaign id). The spend is recorded as yours. Spending over the cap is \
                          recorded and flagged, not refused. Returns the spend and what remains \
                          in the period. [risk: SPEND]",
            permission: Permission::WorkspaceRead,
            schema: schema_for::<SpendRecordArgs>,
            run: spend_record,
        },
        ToolDef {
            use_case: "budget.spend.list",
            description: "Read one page of a budget item's spend, newest first, each entry with \
                          its amount, source and reference. Page back with before_at and \
                          before_id set to the at and id of the previous page's last entry. \
                          Returns {spend: [...]}. [risk: READ]",
            permission: Permission::WorkspaceRead,
            schema: schema_for::<SpendListArgs>,
            run: spend_list,
        },
    ]
}

/// A new budget item.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ItemCreateArgs {
    /// 1 to 64 characters.
    name: String,
    /// What the item holds.
    #[schemars(schema_with = "budget_kind_schema")]
    kind: BudgetKind,
    /// What its cap and spend are counted in; it must fit the kind.
    #[schemars(schema_with = "unit_schema")]
    unit: Unit,
    /// The most that may be spent per period, in the unit; not negative.
    #[schemars(range(min = 0))]
    cap: i64,
    /// The period the cap applies to.
    #[schemars(schema_with = "period_schema")]
    period: Period,
}

/// A spend from an item.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct SpendRecordArgs {
    /// The budget item id, from jeeta.budget.items_list.
    budget_item_id: Uuid,
    /// How much, in the item's unit; positive.
    #[schemars(range(min = 1))]
    amount: i64,
    /// An invoice number, a campaign id; at most 256 characters.
    #[serde(default)]
    reference: Option<String>,
}

/// Which item's spend, and which page of it.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct SpendListArgs {
    /// The budget item id, from jeeta.budget.items_list.
    budget_item_id: Uuid,
    /// At most this many entries: 1 to 500, default 50.
    #[schemars(range(min = 1, max = 500))]
    limit: Option<u32>,
    /// The at of the previous page's last entry; given together with before_id.
    #[serde(default)]
    #[schemars(schema_with = "super::optional_date_time_schema")]
    before_at: Option<String>,
    /// The id of the previous page's last entry; given together with before_at.
    before_id: Option<Uuid>,
}

/// The JSON Schema of a budget kind, naming every kind there is.
fn budget_kind_schema(_: &mut SchemaGenerator) -> Schema {
    let keys: Vec<&str> = BudgetKind::all().iter().map(BudgetKind::key).collect();
    json_schema!({ "type": "string", "enum": keys })
}

/// The JSON Schema of a period, naming every period there is.
fn period_schema(_: &mut SchemaGenerator) -> Schema {
    let keys: Vec<&str> = Period::all().iter().map(Period::key).collect();
    json_schema!({ "type": "string", "enum": keys })
}

/// The JSON Schema of a unit: a currency, a count with its label, or minutes.
fn unit_schema(_: &mut SchemaGenerator) -> Schema {
    json_schema!({
        "oneOf": [
            {
                "type": "object",
                "properties": {
                    "kind": { "const": "currency" },
                    "value": {
                        "type": "string",
                        "pattern": "^[A-Z]{3}$",
                        "description": "An ISO 4217 code such as TRY.",
                    },
                },
                "required": ["kind", "value"],
                "additionalProperties": false,
            },
            {
                "type": "object",
                "properties": {
                    "kind": { "const": "count" },
                    "value": { "type": "string", "description": "What is counted, e.g. spools." },
                },
                "required": ["kind", "value"],
                "additionalProperties": false,
            },
            {
                "type": "object",
                "properties": { "kind": { "const": "minutes" } },
                "required": ["kind"],
                "additionalProperties": false,
            },
        ],
    })
}

fn items_list<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let NoArgs {} = args(raw)?;
        listed("items", &budget::list_items(deps, ctx).await?)
    })
}

fn items_create<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let ItemCreateArgs {
            name,
            kind,
            unit,
            cap,
            period,
        } = args(raw)?;
        let input = BudgetItemInput {
            name,
            kind,
            unit,
            cap,
            period,
        };
        to_json(&budget::create_item(deps, ctx, input).await?)
    })
}

fn spend_record<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let SpendRecordArgs {
            budget_item_id,
            amount,
            reference,
        } = args(raw)?;
        let item = BudgetItemId(budget_item_id);
        to_json(&budget::record_spend(deps, ctx, item, amount, reference).await?)
    })
}

fn spend_list<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let SpendListArgs {
            budget_item_id,
            limit,
            before_at,
            before_id,
        } = args(raw)?;
        let before = budget::spend_cursor(before_at.as_deref(), before_id.map(BudgetSpendId))?;
        let limit = limit.unwrap_or(DEFAULT_SPEND_PAGE);
        let spend = budget::spend(deps, ctx, BudgetItemId(budget_item_id), limit, before).await?;
        listed("spend", &spend)
    })
}
