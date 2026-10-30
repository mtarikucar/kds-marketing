-- The prospect pool (spec 2026-10-30-leads-pool-outreach-design.md §4.1): businesses agents and
-- people researched, kept apart from the inbox until promoted; their dedupe keys, their score
-- history, the research tasks they are found for, and the do-not-contact blocklist of keyed
-- hashes that outlives every purge. The workspace's leads policy gets its column, and the owner
-- and manager system roles gain prospects.work and prospects.manage. Repeatable: every statement
-- is guarded.

-- The workspace's leads policy: pool retention and caps, distribution, outreach and attachment
-- settings, read key by key over defaults (tolerant decode, like `inbox_policy` and `calls`).
alter table workspace_policies add column if not exists leads_policy jsonb not null default '{}'
    check (jsonb_typeof(leads_policy) = 'object');

-- A research task: a brief from an ICP entry of an approved strategy version (one standing task
-- per entry and version), or one a person or an agent asked for. `claim` is an advisory lease.
create table if not exists research_tasks (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key,
    kind jsonb not null check (jsonb_typeof(kind) = 'object' and kind ? 'type'),
    strategy_version_id uuid not null,
    brief jsonb not null check (jsonb_typeof(brief) = 'object'),
    rubric_digest text not null check (char_length(rubric_digest) between 1 and 64),
    daily_cap integer not null check (daily_cap between 1 and 500),
    status text not null check (status in ('open', 'done', 'canceled', 'superseded')),
    claim jsonb check (claim is null or jsonb_typeof(claim) = 'object'),
    created_by jsonb not null check (jsonb_typeof(created_by) = 'object'),
    created_at timestamptz not null,
    closed_at timestamptz,
    close_note text not null default '' check (char_length(close_note) <= 1000),
    unique (id, workspace_id),
    -- A task is closed exactly when it is not open.
    constraint research_tasks_closed_check check ((closed_at is null) = (status = 'open')),
    constraint research_tasks_version_fkey foreign key (strategy_version_id, workspace_id)
        references strategy_versions (id, workspace_id)
);
-- One open standing task per ICP entry and strategy version: a concurrent second insert of the
-- planning job conflicts and does nothing.
create unique index if not exists research_tasks_one_standing on research_tasks
    (workspace_id, strategy_version_id, (kind->>'icp_key'))
    where status = 'open' and kind->>'type' = 'standing';
create index if not exists research_tasks_list on research_tasks (workspace_id, status, created_at desc, id);

-- A prospect. Listed and filtered columns are columns; the rest of the record (contact fields
-- with their evidence, size, signals, notes, origin, decision) is `data`. Never a private
-- individual (spec D3).
create table if not exists prospects (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key,
    status text not null check (status in ('new', 'qualified', 'rejected', 'promoted', 'do_not_contact')),
    business_name text not null check (char_length(business_name) between 1 and 200),
    entity_kind text not null check (entity_kind in ('legal_entity', 'sole_trader', 'unknown_business')),
    sector text check (sector is null or char_length(sector) between 1 and 80),
    city text check (city is null or char_length(city) between 1 and 80),
    district text check (district is null or char_length(district) between 1 and 80),
    country text not null default 'TR' check (country ~ '^[A-Z]{2}$'),
    language text check (language is null or char_length(language) between 2 and 8),
    segment_key text check (segment_key is null or char_length(segment_key) between 2 and 32),
    labels text[] not null default '{}',
    data jsonb not null check (jsonb_typeof(data) = 'object'),
    research_task_id uuid,
    -- The latest score, written only together with its `prospect_scores` row.
    latest_score smallint check (latest_score between 0 and 100),
    latest_digest text,
    latest_scored_at timestamptz,
    promoted_person_id uuid,
    promoted_journey_id uuid,
    promoted_at timestamptz,
    promoted_score smallint check (promoted_score between 0 and 100),
    purge_after timestamptz,
    revision bigint not null default 1 check (revision >= 1),
    created_at timestamptz not null,
    updated_at timestamptz not null,
    unique (id, workspace_id),
    constraint prospects_task_fkey foreign key (research_task_id, workspace_id)
        references research_tasks (id, workspace_id),
    constraint prospects_person_fkey foreign key (promoted_person_id, workspace_id)
        references people (id, workspace_id),
    constraint prospects_journey_fkey foreign key (promoted_journey_id, workspace_id)
        references journeys (id, workspace_id),
    -- Promoted exactly when it names its person, its journey and when.
    constraint prospects_promoted_check check (
        (status = 'promoted') = (promoted_person_id is not null)
        and (promoted_person_id is null) = (promoted_journey_id is null)
        and (promoted_person_id is null) = (promoted_at is null)
    ),
    constraint prospects_latest_check check (
        (latest_score is null) = (latest_digest is null)
        and (latest_score is null) = (latest_scored_at is null)
    )
);
-- The pool's list, newest first per status.
create index if not exists prospects_list on prospects (workspace_id, status, created_at desc, id);
-- A task's prospects by creation time: its daily cap and its count found.
create index if not exists prospects_task on prospects (workspace_id, research_task_id, created_at);
-- The purge job's sweep.
create index if not exists prospects_purge on prospects (workspace_id, purge_after)
    where purge_after is not null;
-- One prospect per inbox person.
create unique index if not exists prospects_person on prospects (workspace_id, promoted_person_id)
    where promoted_person_id is not null;

-- A prospect's dedupe keys, normalised (spec §3.3). Hard keys are unique among the prospects that
-- hold keys: new, qualified, rejected (until purged) and promoted (kept for the pool's own
-- "duplicate" answer). do_not_contact and erased rows hold none: their keys live on only as
-- blocklist hashes.
create table if not exists prospect_keys (
    workspace_id uuid not null references workspaces (id),
    prospect_id uuid not null,
    kind text not null check (kind in ('phone', 'email', 'instagram', 'tiktok', 'domain', 'name_city')),
    value text not null check (char_length(value) between 1 and 400),
    primary key (workspace_id, prospect_id, kind, value),
    constraint prospect_keys_prospect_fkey foreign key (prospect_id, workspace_id)
        references prospects (id, workspace_id) on delete cascade
);
create unique index if not exists prospect_keys_hard on prospect_keys (workspace_id, kind, value)
    where kind in ('phone', 'email', 'instagram', 'tiktok');
create index if not exists prospect_keys_soft on prospect_keys (workspace_id, kind, value)
    where kind in ('domain', 'name_city');

-- Every score a prospect was given, append-only; the prospect's `latest_*` names the newest.
create table if not exists prospect_scores (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key,
    prospect_id uuid not null,
    score smallint not null check (score between 0 and 100),
    reasons jsonb not null check (jsonb_typeof(reasons) = 'array'),
    rubric_digest text not null check (char_length(rubric_digest) between 1 and 64),
    strategy_version_id uuid,
    recorder jsonb not null check (jsonb_typeof(recorder) = 'object'),
    at timestamptz not null,
    constraint prospect_scores_prospect_fkey foreign key (prospect_id, workspace_id)
        references prospects (id, workspace_id) on delete cascade
);
create index if not exists prospect_scores_by_prospect on prospect_scores (workspace_id, prospect_id, at desc);

-- The do-not-contact blocklist: `key_hash` is the hex HMAC-SHA256, under the workspace's
-- `prospects.blocklist` key, of `kind ‖ 0x00 ‖ normalised value`. Objections (do_not_contact) and
-- erasures never expire; a purged rejection is remembered until `expires_at`.
create table if not exists prospect_blocklist (
    workspace_id uuid not null references workspaces (id),
    kind text not null check (kind in ('phone', 'email', 'instagram', 'tiktok', 'domain', 'name_city')),
    key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
    reason text not null check (reason in ('do_not_contact', 'erased', 'rejected')),
    created_at timestamptz not null,
    expires_at timestamptz,
    constraint prospect_blocklist_expiry_check check ((reason = 'rejected') = (expires_at is not null)),
    primary key (workspace_id, kind, key_hash)
);
-- The purge job's sweep of expired rejections.
create index if not exists prospect_blocklist_expiry on prospect_blocklist (workspace_id, expires_at)
    where expires_at is not null;

alter table research_tasks enable row level security;
alter table research_tasks force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'research_tasks' and policyname = 'research_tasks_ws') then
        create policy research_tasks_ws on research_tasks
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table prospects enable row level security;
alter table prospects force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'prospects' and policyname = 'prospects_ws') then
        create policy prospects_ws on prospects
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table prospect_keys enable row level security;
alter table prospect_keys force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'prospect_keys' and policyname = 'prospect_keys_ws') then
        create policy prospect_keys_ws on prospect_keys
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table prospect_scores enable row level security;
alter table prospect_scores force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'prospect_scores' and policyname = 'prospect_scores_ws') then
        create policy prospect_scores_ws on prospect_scores
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table prospect_blocklist enable row level security;
alter table prospect_blocklist force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'prospect_blocklist' and policyname = 'prospect_blocklist_ws') then
        create policy prospect_blocklist_ws on prospect_blocklist
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

-- The owner and manager system roles gain prospects.work and prospects.manage; rep holds neither
-- (spec D25). Custom roles are left to their workspaces.
do $$ declare previous text; begin
    previous := current_setting('app.platform', true);
    perform set_config('app.platform', 'on', true);
    update roles set permissions = array_append(permissions, 'prospects.work')
        where is_system and key in ('owner', 'manager')
          and not ('prospects.work' = any (permissions));
    update roles set permissions = array_append(permissions, 'prospects.manage')
        where is_system and key in ('owner', 'manager')
          and not ('prospects.manage' = any (permissions));
    perform set_config('app.platform', coalesce(previous, ''), true);
end $$;
