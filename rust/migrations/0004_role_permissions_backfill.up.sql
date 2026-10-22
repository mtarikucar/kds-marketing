-- Role permissions backfill and the check-in lookup index.
--
-- M1a added two permissions, `capabilities.manage` and `budget.manage`, that the system `owner`
-- and `manager` roles grant (`jt_tenancy::SystemRole::permissions`). A workspace registered
-- before them keeps the permission list its roles were created with, so its owner could not
-- declare a capability or open a budget item. This adds each key to every system `owner` and
-- `manager` role that lacks it, and to nothing else: custom roles, and the system `rep` role,
-- stay as their workspace set them.
--
-- `roles` has forced row-level security, so the updates see rows only with `app.platform` on; it
-- is set for this migration's own transaction (`set_config(…, true)`), never beyond it.
--
-- The index serves the agent check-in's lookup of its connection's latest ledgered check-in
-- (`work.checkin`, at most one entry an hour per connection), which would otherwise scan the
-- workspace's whole ledger.
--
-- Every statement is idempotent: running this file twice leaves the same data and schema.

select set_config('app.platform', 'on', true);

update roles
   set permissions = array_append(permissions, 'capabilities.manage')
 where is_system
   and key in ('owner', 'manager')
   and not (permissions @> array['capabilities.manage']);

update roles
   set permissions = array_append(permissions, 'budget.manage')
 where is_system
   and key in ('owner', 'manager')
   and not (permissions @> array['budget.manage']);

create index if not exists ledger_entries_agent_connection_idx
    on ledger_entries (workspace_id, agent_connection_id, id desc)
    where agent_connection_id is not null;
