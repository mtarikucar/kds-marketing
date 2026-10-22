-- Capabilities: what a workspace can act through (spec §6), the groups that name sets of them,
-- the budget items they spend from with the append-only spend ledger, and the workspace-wide
-- policies.
--
-- A kind may have many capabilities (B10), but one external account (a kind and the provider's
-- id) is held by at most one capability that is not retired: a partial unique index enforces it,
-- so of two transactions racing to declare it the second one fails. The sealed connector
-- credentials are opaque bytes in `capabilities.connector_sealed` that only the workspace's key
-- opens. Group members, budget links and spend entries reference their rows together with the
-- workspace, so a row can never tie rows of two workspaces together, even where row-level
-- security is off. Spend entries are never changed or deleted: a trigger refuses it.
--
-- Every table is a tenant table with forced row-level security, like those of 0001 and 0002.
-- Every statement is idempotent: running this file twice leaves the same schema.

create table if not exists capabilities (
    id uuid primary key,
    workspace_id uuid not null references workspaces (id) on delete cascade,
    kind_key text not null,
    key_detail text,
    name text not null,
    description text not null default '',
    reach text not null check (reach in ('connector', 'agent', 'device')),
    status text not null check (status in ('declared', 'verified', 'unreachable', 'retired')),
    external_id text,
    connector_public jsonb not null default '{}'::jsonb,
    connector_sealed bytea,
    last_verified_at timestamptz,
    evidence jsonb,
    policy jsonb not null default '{}'::jsonb,
    strategy_version_id uuid,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    unique (id, workspace_id)
);
create unique index if not exists capabilities_live_external_account
    on capabilities (workspace_id, kind_key, external_id)
    where external_id is not null and status <> 'retired';

create table if not exists capability_groups (
    id uuid primary key,
    workspace_id uuid not null references workspaces (id) on delete cascade,
    name text not null,
    purpose text,
    created_at timestamptz not null,
    unique (workspace_id, name),
    unique (id, workspace_id)
);

create table if not exists capability_group_members (
    workspace_id uuid not null,
    group_id uuid not null,
    capability_id uuid not null,
    primary key (group_id, capability_id),
    constraint capability_group_members_group_fkey foreign key (group_id, workspace_id)
        references capability_groups (id, workspace_id) on delete cascade,
    constraint capability_group_members_capability_fkey foreign key (capability_id, workspace_id)
        references capabilities (id, workspace_id) on delete cascade
);
create index if not exists capability_group_members_capability_idx
    on capability_group_members (capability_id);

create table if not exists budget_items (
    id uuid primary key,
    workspace_id uuid not null references workspaces (id) on delete cascade,
    name text not null,
    kind text not null check (kind in ('cash', 'ad_budget', 'sms_budget', 'agent_quota',
                                       'agent_hours', 'consumable')),
    unit jsonb not null,
    cap bigint not null check (cap >= 0),
    period text not null check (period in ('daily', 'weekly', 'monthly', 'total')),
    strategy_version_id uuid,
    created_at timestamptz not null,
    unique (id, workspace_id)
);

create table if not exists capability_budget_links (
    workspace_id uuid not null,
    capability_id uuid not null,
    budget_item_id uuid not null,
    primary key (capability_id, budget_item_id),
    constraint capability_budget_links_capability_fkey foreign key (capability_id, workspace_id)
        references capabilities (id, workspace_id) on delete cascade,
    constraint capability_budget_links_budget_item_fkey foreign key (budget_item_id, workspace_id)
        references budget_items (id, workspace_id) on delete cascade
);
create index if not exists capability_budget_links_budget_item_idx
    on capability_budget_links (budget_item_id);

create table if not exists budget_spend_entries (
    id uuid primary key,
    workspace_id uuid not null,
    budget_item_id uuid not null,
    at timestamptz not null,
    amount bigint not null check (amount > 0),
    source jsonb not null,
    reference text,
    constraint budget_spend_entries_budget_item_fkey foreign key (budget_item_id, workspace_id)
        references budget_items (id, workspace_id) on delete cascade
);
create index if not exists budget_spend_entries_item_at_idx
    on budget_spend_entries (budget_item_id, at);

create or replace function budget_spend_entries_immutable() returns trigger
language plpgsql as $$
begin
    raise exception 'budget_spend_entries is append-only';
end;
$$;

create or replace trigger budget_spend_entries_append_only
    before update or delete on budget_spend_entries
    for each row execute function budget_spend_entries_immutable();

create table if not exists workspace_policies (
    workspace_id uuid primary key references workspaces (id) on delete cascade,
    agent_checkin_interval_minutes int not null default 1440
        check (agent_checkin_interval_minutes between 15 and 10080),
    updated_at timestamptz not null
);

-- Row-level security. `create policy` has no `if not exists`, hence the guards.

alter table capabilities enable row level security;
alter table capabilities force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'capabilities' and policyname = 'capabilities_ws') then
        create policy capabilities_ws on capabilities
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table capability_groups enable row level security;
alter table capability_groups force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'capability_groups' and policyname = 'capability_groups_ws') then
        create policy capability_groups_ws on capability_groups
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table capability_group_members enable row level security;
alter table capability_group_members force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'capability_group_members' and policyname = 'capability_group_members_ws') then
        create policy capability_group_members_ws on capability_group_members
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table budget_items enable row level security;
alter table budget_items force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'budget_items' and policyname = 'budget_items_ws') then
        create policy budget_items_ws on budget_items
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table capability_budget_links enable row level security;
alter table capability_budget_links force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'capability_budget_links' and policyname = 'capability_budget_links_ws') then
        create policy capability_budget_links_ws on capability_budget_links
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table budget_spend_entries enable row level security;
alter table budget_spend_entries force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'budget_spend_entries' and policyname = 'budget_spend_entries_ws') then
        create policy budget_spend_entries_ws on budget_spend_entries
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table workspace_policies enable row level security;
alter table workspace_policies force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'workspace_policies' and policyname = 'workspace_policies_ws') then
        create policy workspace_policies_ws on workspace_policies
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;
