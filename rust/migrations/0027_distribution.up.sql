-- Lead distribution (spec 2026-10-30-leads-pool-outreach-design.md §3.9, §4.2): whom a commercial
-- message reaches (`people.recipient_kind`), each member's distribution settings, the ordered
-- rules, and the log of every decision about a journey's owner. The journey's `owner_id` stays
-- the truth for ownership; the log is the decision history, written in the same transaction.
-- Repeatable: every statement is guarded.

-- Unknown until promotion makes the person a business or a person sets it. A constant default
-- makes the add a catalog change; the check is added `not valid` (no scan under the add's
-- ACCESS EXCLUSIVE lock), then validated, which scans `people` under a lock that lets writes
-- through. Validating a valid check again changes nothing.
alter table people add column if not exists recipient_kind text not null default 'unknown';
do $$ begin
    if not exists (select 1 from pg_constraint where conrelid = to_regclass('people')
                   and conname = 'people_recipient_kind_check') then
        alter table people add constraint people_recipient_kind_check
            check (recipient_kind in ('unknown', 'business', 'individual')) not valid;
    end if;
end $$;
alter table people validate constraint people_recipient_kind_check;

-- A member's distribution settings; a member without a row reads as the default profile
-- (accepting, no limit, no filters, always on shift).
create table if not exists rep_profiles (
    workspace_id uuid not null references workspaces (id),
    user_id uuid not null references users (id),
    accepting boolean not null default true,
    max_open integer check (max_open between 1 and 10000),
    languages text[] not null default '{}' check (cardinality(languages) <= 20),
    cities text[] not null default '{}' check (cardinality(cities) <= 20),
    sectors text[] not null default '{}' check (cardinality(sectors) <= 20),
    hours jsonb check (hours is null or jsonb_typeof(hours) = 'object'),
    away_until timestamptz,
    updated_at timestamptz not null,
    primary key (workspace_id, user_id)
);

-- The workspace's rules, applied in `position` order; replaced as a whole.
create table if not exists distribution_rules (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key,
    position integer not null check (position between 0 and 99),
    name text not null check (char_length(name) between 1 and 80),
    enabled boolean not null default true,
    match jsonb not null check (jsonb_typeof(match) = 'object'),
    pool jsonb not null check (jsonb_typeof(pool) = 'object' and pool ? 'kind'),
    method text not null check (method in ('round_robin', 'least_loaded')),
    sla_minutes integer check (sla_minutes between 5 and 10080),
    cursor_user_id uuid references users (id),
    updated_at timestamptz not null,
    unique (workspace_id, position)
);

-- One row per decision about a journey's owner; the live one has no `superseded_at`. A decision
-- that names nobody records why (nobody eligible, the owner left, an unmapped import, a manager's
-- unassignment).
create table if not exists journey_assignments (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key,
    journey_id uuid not null,
    user_id uuid references users (id),
    cause text not null check (cause in ('rule', 'default', 'manual', 'sla_reassign',
                                         'member_left', 'import', 'no_eligible')),
    rule_id uuid,
    assigned_at timestamptz not null,
    sla_due_at timestamptz,
    acted_at timestamptz,
    superseded_at timestamptz,
    by_actor jsonb not null check (jsonb_typeof(by_actor) = 'object'),
    unique (id, workspace_id),
    -- A rule's, the default rule's and an SLA reassignment's decision name a member; nobody
    -- eligible and a departed owner name none; a manager's and an import's may name either.
    constraint journey_assignments_user_check check (
        (cause in ('rule', 'default', 'sla_reassign') and user_id is not null)
        or (cause in ('no_eligible', 'member_left') and user_id is null)
        or cause in ('manual', 'import')),
    constraint journey_assignments_sla_check check (sla_due_at is null or user_id is not null),
    foreign key (journey_id, workspace_id) references journeys (id, workspace_id) on delete cascade
);
create unique index if not exists journey_assignments_live on journey_assignments (workspace_id, journey_id)
    where superseded_at is null;
-- The SLA sweep: live, unacted assignments with a due time.
create index if not exists journey_assignments_sla on journey_assignments (workspace_id, sla_due_at)
    where superseded_at is null and acted_at is null and sla_due_at is not null;
-- A journey's decisions (its previous assignees, its reassignment count).
create index if not exists journey_assignments_journey on journey_assignments
    (workspace_id, journey_id, assigned_at);
-- The workspace's log, newest first.
create index if not exists journey_assignments_log on journey_assignments
    (workspace_id, assigned_at desc, id desc);

-- Append-only except `acted_at` and `superseded_at`, each written once. A row goes only with its
-- journey (the cascade of a journey's deletion, as the v1 import's rollback deletes one).
create or replace function journey_assignments_guard() returns trigger language plpgsql as $$
begin
    if tg_op = 'DELETE' then
        if exists (select 1 from journeys j where j.workspace_id = old.workspace_id
                   and j.id = old.journey_id) then
            raise exception 'journey_assignments is append-only';
        end if;
        return old;
    end if;
    if (to_jsonb(new) - 'acted_at' - 'superseded_at') is distinct from
       (to_jsonb(old) - 'acted_at' - 'superseded_at')
       or (old.acted_at is not null and new.acted_at is distinct from old.acted_at)
       or (old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at) then
        raise exception 'journey_assignments: only acted_at and superseded_at are written, once each';
    end if;
    return new;
end;
$$;
create or replace trigger journey_assignments_append_only before update or delete on journey_assignments
    for each row execute function journey_assignments_guard();

alter table rep_profiles enable row level security;
alter table rep_profiles force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'rep_profiles' and policyname = 'rep_profiles_ws') then
        create policy rep_profiles_ws on rep_profiles
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table distribution_rules enable row level security;
alter table distribution_rules force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'distribution_rules' and policyname = 'distribution_rules_ws') then
        create policy distribution_rules_ws on distribution_rules
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table journey_assignments enable row level security;
alter table journey_assignments force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'journey_assignments' and policyname = 'journey_assignments_ws') then
        create policy journey_assignments_ws on journey_assignments
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;
