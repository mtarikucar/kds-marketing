-- Voice calls (spec 2026-10-27-agent-voice-calls-design.md §9): call sessions and their turn
-- log, the commands queued for a voice bridge, the agents on inbound duty, the workspace's call
-- policy, the calls.* grants of the system roles, and the retry bookkeeping of deferred event
-- consumption (cleanup plan C5). Every tenant table is scoped by `workspace_id` first, with
-- composite foreign keys and forced row-level security. Repeatable: every statement is guarded.

create table if not exists call_sessions (
    workspace_id uuid not null references workspaces (id),
    id uuid not null,
    capability_id uuid not null,
    person_id uuid,
    journey_id uuid,
    direction text not null check (direction in ('inbound', 'outbound')),
    purpose text not null check (purpose in ('service', 'commercial', 'callback')),
    mode text not null check (mode in ('agent', 'human')),
    state text not null check (state in ('planned', 'dialing', 'ringing', 'live', 'holding',
                                         'ending', 'ended')),
    -- Empty once the person was erased.
    counterpart_e164 text not null check (counterpart_e164 = '' or counterpart_e164 ~ '^\+[0-9]{8,15}$'),
    bridge_call_id text,
    pbx_unique_id text,
    crm_id text,
    agent_connection_id uuid,
    started_at timestamptz not null,
    ended_at timestamptz,
    end_cause text,
    outcome text check (outcome in ('connected', 'no_answer', 'voicemail', 'refused_by_customer',
                                    'appointment', 'callback_requested', 'other')),
    -- The whole session (plan, metrics, timers, recording, placed_by) as the domain encodes it.
    data jsonb not null check (jsonb_typeof(data) = 'object'),
    created_at timestamptz not null,
    updated_at timestamptz not null,
    primary key (workspace_id, id),
    constraint call_sessions_capability_fkey foreign key (capability_id, workspace_id)
        references capabilities (id, workspace_id),
    constraint call_sessions_person_fkey foreign key (person_id, workspace_id)
        references people (id, workspace_id),
    constraint call_sessions_journey_fkey foreign key (journey_id, workspace_id)
        references journeys (id, workspace_id)
);
create index if not exists call_sessions_state_idx on call_sessions (workspace_id, state);
create index if not exists call_sessions_person_idx
    on call_sessions (workspace_id, person_id, started_at desc);
create index if not exists call_sessions_started_idx
    on call_sessions (workspace_id, started_at desc, id desc);
create unique index if not exists call_sessions_crm_id_key
    on call_sessions (workspace_id, crm_id) where crm_id is not null;
create unique index if not exists call_sessions_bridge_call_key
    on call_sessions (workspace_id, bridge_call_id) where bridge_call_id is not null;

create table if not exists call_turns (
    workspace_id uuid not null references workspaces (id),
    call_id uuid not null,
    seq integer not null check (seq >= 0),
    at timestamptz not null,
    kind text not null check (kind in ('utterance', 'say', 'holding', 'fallback', 'dtmf', 'event')),
    -- Who spoke: the counterpart, the agent or the script; empty for an event.
    speaker text not null default '' check (speaker in ('', 'counterpart', 'agent', 'script')),
    -- Erased with the person (seq, kind and time stay).
    text text not null default '' check (char_length(text) <= 2000),
    data jsonb not null check (jsonb_typeof(data) = 'object'),
    primary key (workspace_id, call_id, seq),
    constraint call_turns_session_fkey foreign key (workspace_id, call_id)
        references call_sessions (workspace_id, id) on delete cascade
);

create table if not exists call_commands (
    workspace_id uuid not null references workspaces (id),
    id uuid not null,
    call_id uuid,
    kind text not null,
    payload jsonb not null check (jsonb_typeof(payload) = 'object'),
    created_at timestamptz not null,
    taken_at timestamptz,
    acked_at timestamptz,
    result jsonb,
    primary key (workspace_id, id),
    constraint call_commands_session_fkey foreign key (workspace_id, call_id)
        references call_sessions (workspace_id, id) on delete cascade
);
create index if not exists call_commands_open_idx
    on call_commands (workspace_id, taken_at) where acked_at is null;

create table if not exists call_duty (
    workspace_id uuid not null references workspaces (id),
    agent_connection_id uuid not null,
    since timestamptz not null,
    last_poll_at timestamptz not null,
    primary key (workspace_id, agent_connection_id)
);

alter table call_sessions enable row level security;
alter table call_sessions force row level security;
alter table call_turns enable row level security;
alter table call_turns force row level security;
alter table call_commands enable row level security;
alter table call_commands force row level security;
alter table call_duty enable row level security;
alter table call_duty force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'call_sessions' and policyname = 'call_sessions_ws') then
        create policy call_sessions_ws on call_sessions
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'call_turns' and policyname = 'call_turns_ws') then
        create policy call_turns_ws on call_turns
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'call_commands' and policyname = 'call_commands_ws') then
        create policy call_commands_ws on call_commands
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'call_duty' and policyname = 'call_duty_ws') then
        create policy call_duty_ws on call_duty
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

-- The workspace's call policy (tolerant decode, like `inbox_policy`).
alter table workspace_policies add column if not exists calls jsonb not null default '{}'
    check (jsonb_typeof(calls) = 'object');

-- Deferred consumption is retried with a backoff (C5): `attempts` counts the deferrals,
-- `retry_at` is when the next one is due.
alter table event_consumption add column if not exists attempts integer not null default 0
    check (attempts >= 0);
alter table event_consumption add column if not exists retry_at timestamptz;

-- The system roles gain the call permissions: calls.work for owner, manager and rep,
-- calls.manage for owner and manager. Custom roles are left to their workspaces.
do $$ declare previous text; begin
    previous := current_setting('app.platform', true);
    perform set_config('app.platform', 'on', true);
    update roles set permissions = array_append(permissions, 'calls.work')
        where is_system and key in ('owner', 'manager', 'rep')
          and not ('calls.work' = any (permissions));
    update roles set permissions = array_append(permissions, 'calls.manage')
        where is_system and key in ('owner', 'manager')
          and not ('calls.manage' = any (permissions));
    perform set_config('app.platform', coalesce(previous, ''), true);
end $$;
