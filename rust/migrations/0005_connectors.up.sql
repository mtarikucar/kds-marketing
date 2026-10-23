-- Connectors: what providers send in (inbound events), OAuth flows between their start and the
-- owner's choice of assets (pending OAuth), and the log of the system's own trial calls (probe
-- runs).
--
-- An inbound event is a webhook delivery or a polled record, routed to a workspace. It is stored
-- once per provider id: `(workspace_id, provider, external_id)` is unique, so a replayed delivery
-- writes nothing (the repo inserts with `on conflict do nothing`). The raw body is kept beside
-- the parsed payload for 30 days and then removed by a scheduled purge (`raw = null`, served by a
-- partial index over the events that still hold a body); apart from that and the time it was
-- handed on (`processed_at`), an event never changes and is never deleted: a trigger refuses an
-- update of any other column (a column a later migration adds included), setting `raw` to
-- anything but null, and every delete.
--
-- A pending OAuth flow is found by the hash of its signed state, which is unique across every
-- workspace. The PKCE code verifier never travels in the state: it is sealed server-side here
-- (`pkce_verifier_sealed`). Once the provider calls back, the assets the account can reach are
-- stored sealed (`assets_sealed`, credentials included) and as their public facts
-- (`assets_public`, a JSON array). A reconnection names the capability it renews
-- (`capability_id`, null for a new connection). Rows are short-lived: confirmed or abandoned
-- flows are deleted (`delete`, `purge_expired`).
--
-- A probe run records one probe of a connector capability; the log is append-only (a trigger
-- refuses updates and deletes), read newest first per capability.
--
-- Events, probe runs and reconnections reference their capability together with the workspace
-- (composite foreign keys on `capabilities (id, workspace_id)`), so a row can never tie in
-- another workspace's capability, even where row-level security is off. An event's capability
-- is optional (null: not routed to one), and so is a pending flow's.
--
-- An inbound webhook is routed, across workspaces, to the capability that holds the provider's
-- account and was connected through the provider: sealed credentials, and stored status verified
-- or unreachable (an expired token keeps its events, so they are there when the owner
-- reconnects). A partial index on `capabilities` serves that lookup (a capability only declared,
-- or verified on an agent's word without credentials, is not in it and never receives events).
--
-- Every table is a tenant table with forced row-level security, like those of 0001 to 0003.
-- Every statement is idempotent: running this file twice leaves the same schema.

create table if not exists inbound_events (
    id uuid primary key,
    workspace_id uuid not null references workspaces (id) on delete cascade,
    provider text not null check (provider in ('meta', 'netgsm', 'x')),
    capability_id uuid,
    external_id text not null,
    kind text not null,
    payload jsonb not null,
    raw bytea,
    received_at timestamptz not null,
    processed_at timestamptz,
    unique (workspace_id, provider, external_id),
    constraint inbound_events_capability_fkey foreign key (capability_id, workspace_id)
        references capabilities (id, workspace_id) on delete cascade
);
create index if not exists inbound_events_pending_idx
    on inbound_events (workspace_id, processed_at, received_at);
create index if not exists inbound_events_raw_received_idx
    on inbound_events (received_at)
    where raw is not null;

create or replace function inbound_events_guard() returns trigger
language plpgsql as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'inbound_events rows are never deleted';
    end if;
    -- Every column but `raw` and `processed_at` is frozen, `id` and `workspace_id` included, and
    -- so is any column a later migration adds: the rows are compared whole, as JSON, without
    -- those two.
    if (to_jsonb(new) - 'raw' - 'processed_at') is distinct from
       (to_jsonb(old) - 'raw' - 'processed_at') then
        raise exception 'inbound_events is append-only: only raw and processed_at may change';
    end if;
    if new.raw is not null and new.raw is distinct from old.raw then
        raise exception 'inbound_events.raw may only be removed';
    end if;
    return new;
end;
$$;

create or replace trigger inbound_events_append_only
    before update or delete on inbound_events
    for each row execute function inbound_events_guard();

create index if not exists capabilities_connected_account_idx
    on capabilities (kind_key, external_id)
    where status in ('verified', 'unreachable') and connector_sealed is not null;

create table if not exists oauth_pending (
    id uuid primary key,
    workspace_id uuid not null references workspaces (id) on delete cascade,
    provider text not null check (provider in ('meta', 'netgsm', 'x')),
    kind_key text not null,
    state_hash text not null unique,
    started_by uuid not null references users (id) on delete cascade,
    capability_id uuid,
    pkce_verifier_sealed bytea,
    assets_sealed bytea,
    assets_public jsonb not null default '[]'::jsonb,
    expires_at timestamptz not null,
    created_at timestamptz not null,
    constraint oauth_pending_capability_fkey foreign key (capability_id, workspace_id)
        references capabilities (id, workspace_id) on delete cascade
);
create index if not exists oauth_pending_expires_idx
    on oauth_pending (workspace_id, expires_at);

create table if not exists probe_runs (
    id uuid primary key,
    workspace_id uuid not null references workspaces (id) on delete cascade,
    capability_id uuid not null,
    at timestamptz not null,
    ok boolean not null,
    error_kind text check (error_kind in ('auth', 'permission', 'throttle', 'transient',
                                          'permanent')),
    latency_ms integer not null check (latency_ms >= 0),
    facts jsonb not null default '{}'::jsonb,
    constraint probe_runs_capability_fkey foreign key (capability_id, workspace_id)
        references capabilities (id, workspace_id) on delete cascade
);
create index if not exists probe_runs_capability_at_idx
    on probe_runs (capability_id, at desc);

create or replace function probe_runs_immutable() returns trigger
language plpgsql as $$
begin
    raise exception 'probe_runs is append-only';
end;
$$;

create or replace trigger probe_runs_append_only
    before update or delete on probe_runs
    for each row execute function probe_runs_immutable();

-- Row-level security. `create policy` has no `if not exists`, hence the guards.

alter table inbound_events enable row level security;
alter table inbound_events force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'inbound_events' and policyname = 'inbound_events_ws') then
        create policy inbound_events_ws on inbound_events
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table oauth_pending enable row level security;
alter table oauth_pending force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'oauth_pending' and policyname = 'oauth_pending_ws') then
        create policy oauth_pending_ws on oauth_pending
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table probe_runs enable row level security;
alter table probe_runs force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'probe_runs' and policyname = 'probe_runs_ws') then
        create policy probe_runs_ws on probe_runs
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;
