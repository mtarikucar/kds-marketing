-- Inbox persistence. Every child reference includes its tenant; every table forces RLS.
-- All statements can be repeated. Schema rollback removes these tables, including defaults.
select set_config('app.platform', 'on', true);
create unique index if not exists inbound_events_id_workspace_idx on inbound_events (id, workspace_id);

create table if not exists people (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key, display_name text not null default '', company text not null default '',
    first_touch jsonb not null, first_touch_capability_id uuid, merged_into uuid, erased_at timestamptz,
    created_at timestamptz not null, updated_at timestamptz not null,
    unique (id, workspace_id),
    foreign key (first_touch_capability_id, workspace_id) references capabilities (id, workspace_id),
    foreign key (merged_into, workspace_id) references people (id, workspace_id)
);

create table if not exists identities (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key, person_id uuid not null, channel text not null,
    value_normalized text not null, value_display text not null default '', active boolean not null default true,
    first_seen_at timestamptz not null, unique (id, workspace_id),
    foreign key (person_id, workspace_id) references people (id, workspace_id)
);

create table if not exists conversations (
    created_at timestamptz not null, updated_at timestamptz not null,
    workspace_id uuid not null references workspaces (id),
    id uuid primary key, person_id uuid not null, capability_id uuid not null,
    kind_key text not null, state text not null default 'open', snoozed_until timestamptz,
    activity_revision bigint not null default 0 check (activity_revision >= 0),
    last_inbound_identity_id uuid,
    foreign key (last_inbound_identity_id, workspace_id) references identities (id, workspace_id),
    executor_kind text not null default 'agent' check (executor_kind in ('agent', 'human')),
    executor_user_id uuid references users (id), executor_generation bigint not null default 0
    check (executor_generation between 0 and 4294967295), last_inbound_at timestamptz, last_outbound_at timestamptz,
    unique (id, workspace_id), unique (workspace_id, person_id, capability_id),
    foreign key (person_id, workspace_id) references people (id, workspace_id),
    foreign key (capability_id, workspace_id) references capabilities (id, workspace_id)
);

create table if not exists messages (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key, conversation_id uuid not null, direction text not null,
    author jsonb not null, body text not null default '', external_id text, status jsonb not null,
    cost_minor bigint, at timestamptz not null, unique (id, workspace_id),
    sender_identity_id uuid,
    foreign key (sender_identity_id, workspace_id) references identities (id, workspace_id),
    foreign key (conversation_id, workspace_id) references conversations (id, workspace_id)
);

create table if not exists journeys (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key, person_id uuid not null, status text not null default 'new',
    reducer_revision bigint not null default 0 check (reducer_revision >= 0),
    owner_id uuid references users (id), opened_at timestamptz not null, closed_at timestamptz,
    lost_reason jsonb, unreachable_attempts smallint not null default 0 check (unreachable_attempts between 0 and 255),
    source jsonb not null, updated_at timestamptz not null, unique (id, workspace_id),
    foreign key (person_id, workspace_id) references people (id, workspace_id)
);

create table if not exists journey_events (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key, journey_id uuid not null, source jsonb not null,
    idempotency_key text not null, payload jsonb not null, reason_label text, at timestamptz not null,
    from_status text not null, to_status text not null, unique (workspace_id, idempotency_key),
    foreign key (journey_id, workspace_id) references journeys (id, workspace_id)
);

create table if not exists tasks (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key, journey_id uuid not null, title text not null, due_at timestamptz not null,
    assignee uuid references users (id), status text not null default 'open',
    foreign key (journey_id, workspace_id) references journeys (id, workspace_id)
);

create table if not exists notes (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key, journey_id uuid not null, author jsonb not null, text text not null,
    at timestamptz not null, foreign key (journey_id, workspace_id) references journeys (id, workspace_id)
);

create table if not exists merges (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key, source_id uuid not null, target_id uuid not null, decision jsonb not null,
    conflicts jsonb not null default '[]', status text not null, moved_snapshot jsonb not null,
    at timestamptz not null, applied_by uuid references users (id), undone_at timestamptz,
    foreign key (source_id, workspace_id) references people (id, workspace_id),
    foreign key (target_id, workspace_id) references people (id, workspace_id), check (source_id <> target_id)
);

create table if not exists lost_reasons (
    workspace_id uuid not null references workspaces (id),
    key text not null, label text not null, active boolean not null default true,
    seeded boolean not null default false, primary key (workspace_id, key)
);

create table if not exists event_consumption (
    workspace_id uuid not null references workspaces (id),
    consumer text not null, event_id uuid not null, consumed_at timestamptz,
    outcome text, primary key (workspace_id, consumer, event_id),
    foreign key (event_id, workspace_id) references inbound_events (id, workspace_id)
);

create table if not exists outbox (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key, conversation_id uuid not null, message_id uuid not null,
    capability_id uuid not null, intent jsonb not null, expected_generation bigint not null
    check (expected_generation between 0 and 4294967295), fence_snapshot jsonb,
    state text not null default 'queued' check (state in ('queued','sending','sent','failed','unknown','refused')),
    attempts integer not null default 0 check (attempts >= 0), last_error text,
    created_at timestamptz not null, updated_at timestamptz not null,
    foreign key (conversation_id, workspace_id) references conversations (id, workspace_id),
    foreign key (message_id, workspace_id) references messages (id, workspace_id),
    foreign key (capability_id, workspace_id) references capabilities (id, workspace_id)
);

create table if not exists request_keys (
    workspace_id uuid not null references workspaces (id),
    key text not null, response jsonb not null, at timestamptz not null,
    primary key (workspace_id, key)
);

create unique index if not exists identities_active_key on identities (workspace_id, channel, value_normalized) where active;
create unique index if not exists journeys_one_open on journeys (workspace_id, person_id) where closed_at is null;
create unique index if not exists messages_external_key on messages (workspace_id, conversation_id, external_id) where external_id is not null;
-- External ids are account-scoped via conversations; this narrows receipts before the join.
create index if not exists messages_external_lookup on messages (workspace_id, external_id, at, id) where external_id is not null;
create index if not exists messages_echo_candidates on messages (workspace_id, conversation_id, at, id) where direction='outbound' and external_id is null;
create index if not exists outbox_message_lookup on outbox (workspace_id, message_id);
create index if not exists outbox_pending on outbox (workspace_id, state, updated_at);
create index if not exists request_keys_expiry on request_keys (workspace_id, at);

create or replace function journey_events_immutable() returns trigger language plpgsql as $$
begin
    raise exception 'journey_events is append-only';
end;
$$;
create or replace trigger journey_events_append_only before update or delete on journey_events
    for each row execute function journey_events_immutable();

alter table people enable row level security;
alter table people force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'people' and policyname = 'people_ws') then
        create policy people_ws on people
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table identities enable row level security;
alter table identities force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'identities' and policyname = 'identities_ws') then
        create policy identities_ws on identities
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table conversations enable row level security;
alter table conversations force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'conversations' and policyname = 'conversations_ws') then
        create policy conversations_ws on conversations
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table messages enable row level security;
alter table messages force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'messages' and policyname = 'messages_ws') then
        create policy messages_ws on messages
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table journeys enable row level security;
alter table journeys force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'journeys' and policyname = 'journeys_ws') then
        create policy journeys_ws on journeys
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table journey_events enable row level security;
alter table journey_events force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'journey_events' and policyname = 'journey_events_ws') then
        create policy journey_events_ws on journey_events
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table tasks enable row level security;
alter table tasks force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'tasks' and policyname = 'tasks_ws') then
        create policy tasks_ws on tasks
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table notes enable row level security;
alter table notes force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'notes' and policyname = 'notes_ws') then
        create policy notes_ws on notes
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table merges enable row level security;
alter table merges force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'merges' and policyname = 'merges_ws') then
        create policy merges_ws on merges
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table lost_reasons enable row level security;
alter table lost_reasons force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'lost_reasons' and policyname = 'lost_reasons_ws') then
        create policy lost_reasons_ws on lost_reasons
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table event_consumption enable row level security;
alter table event_consumption force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'event_consumption' and policyname = 'event_consumption_ws') then
        create policy event_consumption_ws on event_consumption
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table outbox enable row level security;
alter table outbox force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'outbox' and policyname = 'outbox_ws') then
        create policy outbox_ws on outbox
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table request_keys enable row level security;
alter table request_keys force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'request_keys' and policyname = 'request_keys_ws') then
        create policy request_keys_ws on request_keys
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

insert into lost_reasons (workspace_id, key, label, active, seeded)
select w.id, d.key, d.label, true, true from workspaces w cross join
(values ('fiyat','Fiyat'), ('zaman','Zaman'), ('rakip','Rakip'),
        ('ulasilamadi','Ulaşılamadı'), ('ilgisiz','İlgisiz'), ('diger','Diğer')) as d(key,label)
on conflict do nothing;

update roles set permissions = array_append(permissions, 'inbox.work')
where is_system and key in ('owner','manager','rep') and not (permissions @> array['inbox.work']);
update roles set permissions = array_append(permissions, 'inbox.manage')
where is_system and key in ('owner','manager') and not (permissions @> array['inbox.manage']);


-- Display labels belong to the existing policy row; the funnel keys remain fixed.
alter table workspace_policies add column if not exists inbox_status_labels jsonb not null default '{}'
    constraint workspace_policies_inbox_status_labels_check check (
        jsonb_typeof(inbox_status_labels) = 'object'
        and inbox_status_labels - array['new','contacted','unreachable','appointment','met','quoted','pending','won','lost']::text[] = '{}'::jsonb
        and not jsonb_path_exists(inbox_status_labels, '$.* ? (@.type() != "string")')
    );
