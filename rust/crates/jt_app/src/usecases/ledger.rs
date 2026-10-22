//! The workspace's ledger: `ledger.list`.
//!
//! Entries are listed newest first, a page at a time, each with the payload passed through
//! [`LedgerEntry::redacted`], so no secret value ever leaves the store through a listing.

use jt_ledger::LedgerEntry;
use jt_tenancy::Permission;
use serde::Serialize;

use super::{Deps, invalid};
use crate::ctx::Ctx;
use crate::error::AppError;
use crate::ports::LedgerFilter;

/// The page size an adapter asks for when the caller names none.
pub const DEFAULT_LIMIT: u32 = 50;
/// The largest page; a larger `limit` is clamped to it.
pub const MAX_LIMIT: u32 = 500;
/// The actor kinds a filter may name.
pub const ACTOR_KINDS: &[&str] = &["human", "agent", "system"];

/// A ledger entry as listed: its sequence id and the entry with secret payload keys masked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LedgerEntryOut {
    pub id: i64,
    pub entry: LedgerEntry,
}

/// The context's ledger entries matching `filter`, newest first. Needs `ledger.read`.
///
/// `limit` is clamped to `1..=`[`MAX_LIMIT`] (adapters default it to [`DEFAULT_LIMIT`]);
/// `before_id` pages back from the previous page's last id; `action_prefix` matches literally;
/// an `actor_kind` other than `human`, `agent` or `system` is `VALIDATION` with
/// `details.field = "actor_kind"`. Every payload is redacted (see [`LedgerEntry::redacted`]).
pub async fn list(
    deps: &Deps,
    ctx: &Ctx,
    filter: LedgerFilter,
) -> Result<Vec<LedgerEntryOut>, AppError> {
    ctx.require(Permission::LedgerRead)?;
    if let Some(kind) = filter.actor_kind.as_deref()
        && !ACTOR_KINDS.contains(&kind)
    {
        return Err(invalid(
            "actor_kind",
            "actor_kind must be human, agent or system",
        ));
    }
    let filter = LedgerFilter {
        limit: filter.limit.clamp(1, MAX_LIMIT),
        ..filter
    };
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let rows = repos.ledger().list(filter).await?;
    Ok(rows
        .into_iter()
        .map(|row| LedgerEntryOut {
            id: row.id,
            entry: row.entry.redacted(),
        })
        .collect())
}
