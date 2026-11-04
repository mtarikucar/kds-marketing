-- Olay-driven publishing (spec 2026-11-03-studio-materials-design.md §14.2): the package requests
-- the triggers write for agents, the planned post a slot carries, and the workspace's posting
-- policy with its time zone. Three tenant tables, forced RLS. Records keep Studio's `data jsonb`;
-- the columns below are what the rules and indexes need. The slot keeps its state; why it was
-- retired is the post's (`retired_reason`), so `studio_slots` is unchanged. Repeatable: every
-- statement is guarded.

-- A work item for agents: plan posts from these materials. One request per key.
create table if not exists studio_package_requests (
    workspace_id uuid not null references workspaces (id),
    id uuid not null,
    key text not null check (char_length(key) between 1 and 240),
    trigger text not null check (trigger in ('olay', 'calendar', 'floor')),
    status text not null check (status in ('open', 'answered', 'expired')),
    data jsonb not null check (jsonb_typeof(data) = 'object'),
    created_at timestamptz not null,
    answered_at timestamptz,
    closed_at timestamptz,
    primary key (workspace_id, id),
    constraint studio_package_requests_key unique (workspace_id, key),
    -- An open request is neither answered nor closed; an answered one is not closed; an expired
    -- one was closed without an answer.
    constraint studio_package_requests_status_rule check (
        (status = 'open' and answered_at is null and closed_at is null)
        or (status = 'answered' and answered_at is not null and closed_at is null)
        or (status = 'expired' and closed_at is not null and answered_at is null)
    )
);
create index if not exists studio_package_requests_status
    on studio_package_requests (workspace_id, status, created_at);

-- A slot's planned post: the slot keeps the chain, the channel, the time and the state; this keeps
-- the rest. One per slot.
create table if not exists studio_posts (
    workspace_id uuid not null references workspaces (id),
    slot_id uuid not null,
    data jsonb not null check (jsonb_typeof(data) = 'object'),
    format text not null
        check (format in ('story', 'feed_post', 'carousel', 'reel', 'tiktok_video')),
    capability_id uuid not null,
    publish_at timestamptz not null,
    prep_start_at timestamptz not null,
    grace_until timestamptz not null,
    olay_id uuid,
    package_request_id uuid not null,
    retired_reason text check (retired_reason is null or retired_reason in (
        'cancelled', 'hypothesis_retired', 'strategy_archived', 'week_ended',
        'measurements_complete', 'replanned', 'missed_grace'
    )),
    retired_at timestamptz,
    created_at timestamptz not null,
    primary key (workspace_id, slot_id),
    constraint studio_posts_slot_fkey foreign key (workspace_id, slot_id)
        references studio_slots (workspace_id, id),
    constraint studio_posts_olay_fkey foreign key (workspace_id, olay_id)
        references studio_olays (workspace_id, id),
    constraint studio_posts_request_fkey foreign key (workspace_id, package_request_id)
        references studio_package_requests (workspace_id, id),
    constraint studio_posts_prep_rule check (prep_start_at <= publish_at),
    constraint studio_posts_grace_rule check (grace_until >= publish_at),
    constraint studio_posts_retired_rule check ((retired_reason is null) = (retired_at is null))
);
create index if not exists studio_posts_publish on studio_posts (workspace_id, publish_at);

-- Nothing of a planned post changes but its record and its retirement, which is recorded once.
-- Posts are retired, never deleted, so what was planned stays known.
create or replace function studio_posts_fixed() returns trigger language plpgsql as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'studio_posts: a post is retired, never deleted';
    end if;
    -- Every column but these three, compared whole: a column added later is fixed too.
    if (to_jsonb(new) - 'data' - 'retired_reason' - 'retired_at')
       is distinct from (to_jsonb(old) - 'data' - 'retired_reason' - 'retired_at') then
        raise exception 'studio_posts: only a post''s retirement changes';
    end if;
    if old.retired_at is not null
       and (new.retired_reason is distinct from old.retired_reason
            or new.retired_at is distinct from old.retired_at) then
        raise exception 'studio_posts: a retirement is recorded once';
    end if;
    return new;
end;
$$;
create or replace trigger studio_posts_fixed before update or delete on studio_posts
    for each row execute function studio_posts_fixed();

-- The workspace's posting policy and the time zone its hours and days are read in; absent: the
-- defaults. The scalar columns mirror the policy's.
create table if not exists studio_posting_policy (
    workspace_id uuid primary key references workspaces (id),
    data jsonb not null check (jsonb_typeof(data) = 'object'),
    tz text not null default 'Europe/Istanbul',
    floor_days int not null check (floor_days between 1 and 90),
    debounce_minutes int not null check (debounce_minutes between 0 and 1440),
    horizon_days int not null check (horizon_days between 1 and 90),
    quiet_start_hour int not null check (quiet_start_hour between 0 and 23),
    quiet_end_hour int not null check (quiet_end_hour between 0 and 23),
    constraint studio_posting_policy_tz_rule check (char_length(tz) between 1 and 64)
);

-- Every table is the tenant's alone (forced RLS, the policy of 0009_studio).
alter table studio_package_requests enable row level security;
alter table studio_package_requests force row level security;
drop policy if exists tenant_isolation on studio_package_requests;
create policy tenant_isolation on studio_package_requests
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');
alter table studio_posts enable row level security;
alter table studio_posts force row level security;
drop policy if exists tenant_isolation on studio_posts;
create policy tenant_isolation on studio_posts
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');
alter table studio_posting_policy enable row level security;
alter table studio_posting_policy force row level security;
drop policy if exists tenant_isolation on studio_posting_policy;
create policy tenant_isolation on studio_posting_policy
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');
