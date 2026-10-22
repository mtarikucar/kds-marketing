-- Strategy: the numbered versions of a workspace's strategy, the hypotheses of each version and
-- the append-only consultation log of how a version was worked out.
--
-- A workspace has at most one draft and at most one approved version at a time; two partial
-- unique indexes enforce it, so of two transactions racing to break either rule the second one
-- fails. Hypothesis ids are stable across versions, so a hypothesis is keyed by its version.
-- Hypotheses and consultation entries reference their version together with its workspace, so
-- a row can never hang off another workspace's version, even where row-level security is off.
-- `strategy_versions.created_by_*` hold the creator (a `jt_ledger::Actor`): a human sets only
-- `created_by_user`, an agent `created_by_user` (the issuer) and `created_by_connection`, the
-- system only `created_by_component`.
--
-- Every table is a tenant table with forced row-level security, like those of 0001. Every
-- statement is idempotent: running this file twice leaves the same schema.

create table if not exists strategy_versions (
    id uuid primary key,
    workspace_id uuid not null references workspaces (id) on delete cascade,
    number int not null,
    status text not null check (status in ('draft', 'approved', 'archived')),
    sections jsonb not null default '{}'::jsonb,
    created_at timestamptz not null,
    created_by_user uuid,
    created_by_connection uuid,
    created_by_component text,
    submitted_at timestamptz,
    approved_at timestamptz,
    approved_by uuid references users (id),
    archived_at timestamptz,
    unique (workspace_id, number),
    unique (id, workspace_id)
);
create unique index if not exists strategy_versions_one_approved
    on strategy_versions (workspace_id) where status = 'approved';
create unique index if not exists strategy_versions_one_draft
    on strategy_versions (workspace_id) where status = 'draft';

create table if not exists strategy_hypotheses (
    version_id uuid not null,
    workspace_id uuid not null,
    hypothesis_id uuid not null,
    title text not null,
    segment_key text not null,
    angle text not null,
    channel text not null,
    metric text not null,
    confidence real not null check (confidence >= 0 and confidence <= 1),
    state text not null check (state in ('kept', 'retired', 'added')),
    position int not null,
    primary key (version_id, hypothesis_id),
    constraint strategy_hypotheses_version_fkey foreign key (version_id, workspace_id)
        references strategy_versions (id, workspace_id) on delete cascade
);

create table if not exists consultation_entries (
    id uuid primary key,
    workspace_id uuid not null,
    version_id uuid not null,
    kind text not null,
    section_key text,
    text text not null,
    actor_kind text not null check (actor_kind in ('human', 'agent', 'system')),
    actor_user_id uuid,
    agent_connection_id uuid,
    actor_component text,
    at timestamptz not null,
    constraint consultation_entries_version_fkey foreign key (version_id, workspace_id)
        references strategy_versions (id, workspace_id) on delete cascade
);
create index if not exists consultation_entries_version_at_idx
    on consultation_entries (version_id, at);

create or replace function consultation_entries_immutable() returns trigger
language plpgsql as $$
begin
    raise exception 'consultation_entries is append-only';
end;
$$;

create or replace trigger consultation_entries_append_only
    before update or delete on consultation_entries
    for each row execute function consultation_entries_immutable();

-- Row-level security. `create policy` has no `if not exists`, hence the guards.

alter table strategy_versions enable row level security;
alter table strategy_versions force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'strategy_versions' and policyname = 'strategy_versions_ws') then
        create policy strategy_versions_ws on strategy_versions
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table strategy_hypotheses enable row level security;
alter table strategy_hypotheses force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'strategy_hypotheses' and policyname = 'strategy_hypotheses_ws') then
        create policy strategy_hypotheses_ws on strategy_hypotheses
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table consultation_entries enable row level security;
alter table consultation_entries force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'consultation_entries' and policyname = 'consultation_entries_ws') then
        create policy consultation_entries_ws on consultation_entries
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;
