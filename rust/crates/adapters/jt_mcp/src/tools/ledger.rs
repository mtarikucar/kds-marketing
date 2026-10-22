//! `jeeta.ledger.list` (`ledger.list`).

use jt_app::ctx::Ctx;
use jt_app::ports::LedgerFilter;
use jt_app::usecases::Deps;
use jt_app::usecases::ledger::{self, DEFAULT_LIMIT, MAX_LIMIT};
use jt_tenancy::Permission;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use super::{ToolDef, args, listed};
use crate::registry::{ToolFuture, schema_for};

pub(super) fn definitions() -> Vec<ToolDef> {
    vec![ToolDef {
        use_case: "ledger.list",
        description: "List the workspace's ledger, the append-only record of everything done in \
                      it, newest first, with secret values masked. Filter by action prefix or \
                      actor kind; page back with before_id set to the last id of the previous \
                      page. Returns {entries: [{id, entry}]}. [risk: READ]",
        permission: Permission::LedgerRead,
        schema: schema_for::<ListArgs>,
        run: list,
    }]
}

/// Which entries, and how many.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ListArgs {
    /// Keep only actions starting with this text, e.g. "team.".
    action_prefix: Option<String>,
    /// Keep only entries by this kind of actor.
    actor_kind: Option<ActorKind>,
    /// At most this many entries: 1 to 500, default 50.
    #[schemars(range(min = 1, max = 500))]
    limit: Option<u32>,
    /// Only entries older than this one: the last id of the previous page.
    before_id: Option<i64>,
}

/// Who performed an action.
#[derive(Clone, Copy, Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(inline)]
enum ActorKind {
    Human,
    Agent,
    System,
}

impl ActorKind {
    fn key(self) -> &'static str {
        match self {
            ActorKind::Human => "human",
            ActorKind::Agent => "agent",
            ActorKind::System => "system",
        }
    }
}

fn list<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let ListArgs {
            action_prefix,
            actor_kind,
            limit,
            before_id,
        } = args(raw)?;
        let filter = LedgerFilter {
            action_prefix,
            actor_kind: actor_kind.map(|k| k.key().to_owned()),
            limit: limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT),
            before_id,
        };
        listed("entries", &ledger::list(deps, ctx, filter).await?)
    })
}
