-- The device bridge (spec 2026-10-28-device-bridge-design.md §5): the commands queued for a phone,
-- each leased to the bridge the phone is plugged into and answered on its own row; and
-- devices.work, devices.manage and devices.bridge on the owner and manager system roles,
-- devices.bridge being the permission of the bridge's API key, so that they can issue it.
-- Repeatable: every statement is guarded.

-- Handed out in `seq` order, the order they were queued in. `requested_by` is the actor that
-- queued the command. Screenshots and pulled files are Jeeta files, referenced by id, never kept
-- on the row.
create table if not exists device_commands (
    id uuid primary key,
    workspace_id uuid not null references workspaces (id),
    capability_id uuid not null,
    seq bigint generated always as identity,
    kind text not null,
    payload jsonb not null,
    status text not null check (status in ('queued', 'leased', 'done', 'failed', 'expired', 'canceled')),
    attempts int not null default 0,
    leased_at timestamptz,
    expires_at timestamptz not null,
    result jsonb,
    reason text,
    requested_by jsonb not null,
    created_at timestamptz not null,
    done_at timestamptz,
    constraint device_commands_capability_fkey foreign key (workspace_id, capability_id)
        references capabilities (workspace_id, id)
);
create index if not exists device_commands_queue
    on device_commands (workspace_id, capability_id, status, seq);

alter table device_commands enable row level security;
alter table device_commands force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'device_commands' and policyname = 'device_commands_ws') then
        create policy device_commands_ws on device_commands
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

-- The owner and manager system roles gain devices.work, devices.manage and devices.bridge. Custom
-- roles are left to their workspaces.
do $$ declare previous text; begin
    previous := current_setting('app.platform', true);
    perform set_config('app.platform', 'on', true);
    update roles set permissions = array_append(permissions, 'devices.work')
        where is_system and key in ('owner', 'manager')
          and not ('devices.work' = any (permissions));
    update roles set permissions = array_append(permissions, 'devices.manage')
        where is_system and key in ('owner', 'manager')
          and not ('devices.manage' = any (permissions));
    update roles set permissions = array_append(permissions, 'devices.bridge')
        where is_system and key in ('owner', 'manager')
          and not ('devices.bridge' = any (permissions));
    perform set_config('app.platform', coalesce(previous, ''), true);
end $$;
