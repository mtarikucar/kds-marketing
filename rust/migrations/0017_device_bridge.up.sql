-- The device bridge (spec 2026-10-28-device-bridge-design.md §5): the commands queued for a phone,
-- each leased to the bridge the phone is plugged into and answered on its own row; and
-- devices.work and devices.bridge on the owner and manager system roles, devices.bridge being the
-- permission of the bridge's API key, so that they can issue it. Repeatable: every statement is
-- guarded.

-- Handed out in `seq` order, the order they were queued in. `requested_by` is the actor that
-- queued the command. `detail` is the failure line a bridge reported. Screenshots and pulled
-- files are Jeeta files, referenced by id, never kept on the row.
create table if not exists device_commands (
    id uuid primary key,
    workspace_id uuid not null references workspaces (id),
    capability_id uuid not null,
    seq bigint generated always as identity,
    kind text not null check (char_length(kind) between 1 and 32),
    payload jsonb not null check (jsonb_typeof(payload) = 'object'),
    status text not null check (status in ('queued', 'leased', 'done', 'failed', 'expired', 'canceled')),
    attempts int not null default 0 check (attempts >= 0),
    leased_at timestamptz,
    expires_at timestamptz not null,
    result jsonb,
    reason text,
    detail text check (detail is null or char_length(detail) <= 300),
    requested_by jsonb not null check (jsonb_typeof(requested_by) = 'object'),
    created_at timestamptz not null,
    done_at timestamptz,
    constraint device_commands_capability_fkey foreign key (workspace_id, capability_id)
        references capabilities (workspace_id, id),
    -- A leased or done command was leased.
    constraint device_commands_leased_check
        check (status not in ('leased', 'done') or leased_at is not null),
    -- A command is finished exactly when it is neither queued nor leased.
    constraint device_commands_done_check
        check ((done_at is null) = (status in ('queued', 'leased')))
);
-- The queue a bridge reads.
create index if not exists device_commands_queue
    on device_commands (workspace_id, capability_id, status, seq);
-- The expiry sweep: commands not finished yet, by their time limit.
create index if not exists device_commands_due
    on device_commands (workspace_id, expires_at) where status in ('queued', 'leased');
-- A phone's command log, in queue order.
create index if not exists device_commands_log
    on device_commands (workspace_id, capability_id, seq);

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

-- The owner and manager system roles gain devices.work and devices.bridge. Custom roles are left
-- to their workspaces.
do $$ declare previous text; begin
    previous := current_setting('app.platform', true);
    perform set_config('app.platform', 'on', true);
    update roles set permissions = array_append(permissions, 'devices.work')
        where is_system and key in ('owner', 'manager')
          and not ('devices.work' = any (permissions));
    update roles set permissions = array_append(permissions, 'devices.bridge')
        where is_system and key in ('owner', 'manager')
          and not ('devices.bridge' = any (permissions));
    perform set_config('app.platform', coalesce(previous, ''), true);
end $$;
