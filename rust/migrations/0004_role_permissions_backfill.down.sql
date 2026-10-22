-- Reverts 0004_role_permissions_backfill: removes `capabilities.manage` and `budget.manage` from
-- the system `owner` and `manager` roles (and from no other role: custom roles keep whatever they
-- grant), and drops the check-in lookup index. A no-op when already reverted.
--
-- Like the up migration, it sets `app.platform` for its own transaction only, since `roles` has
-- forced row-level security.

select set_config('app.platform', 'on', true);

update roles
   set permissions = array_remove(array_remove(permissions, 'capabilities.manage'), 'budget.manage')
 where is_system
   and key in ('owner', 'manager')
   and permissions && array['capabilities.manage', 'budget.manage'];

drop index if exists ledger_entries_agent_connection_idx;
