-- The voice bridge (spec 2026-10-27-agent-voice-calls-design.md §10): the events a bridge
-- reported, noted by the bridge's own numbering so that each is applied once; the order the
-- bridge's commands were queued in; and calls.bridge on the owner and manager system roles, the
-- permission of the bridge's API key, so that they can issue it. Repeatable: every statement is
-- guarded.

-- Keyed as the bridge numbers its events, not by session: an event can arrive before its call
-- has one (an inbound call). Neither the event's words nor any number is kept.
create table if not exists call_bridge_events (
    workspace_id uuid not null references workspaces (id),
    bridge_call_id text not null check (char_length(bridge_call_id) between 1 and 128),
    bridge_seq bigint not null check (bridge_seq >= 0),
    capability_id uuid not null,
    kind text not null check (char_length(kind) between 1 and 32),
    received_at timestamptz not null,
    primary key (workspace_id, bridge_call_id, bridge_seq),
    constraint call_bridge_events_capability_fkey foreign key (capability_id, workspace_id)
        references capabilities (id, workspace_id)
);

alter table call_bridge_events enable row level security;
alter table call_bridge_events force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'call_bridge_events' and policyname = 'call_bridge_events_ws') then
        create policy call_bridge_events_ws on call_bridge_events
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

-- Commands are handed out in the order they were queued: a call's closing before its hangup,
-- whatever their ids.
alter table call_commands add column if not exists seq bigint generated always as identity;

-- The owner and manager system roles gain calls.bridge. Custom roles are left to their workspaces.
do $$ declare previous text; begin
    previous := current_setting('app.platform', true);
    perform set_config('app.platform', 'on', true);
    update roles set permissions = array_append(permissions, 'calls.bridge')
        where is_system and key in ('owner', 'manager')
          and not ('calls.bridge' = any (permissions));
    perform set_config('app.platform', coalesce(previous, ''), true);
end $$;
