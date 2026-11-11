-- Social media management (design 2026-11-10 §7): what each connected account's platform said on
-- a day, and the accounts whose posting a person paused.

-- One snapshot per account and day: the first successful read of the day stands. `data` holds
-- the numbers the platform gave (any of followers, reach, views, engagement, profile visits; one
-- it does not give is absent, never zero) and its raw counters.
create table if not exists social_account_days (
    workspace_id uuid not null references workspaces (id),
    capability_id uuid not null,
    day date not null,
    data jsonb not null check (jsonb_typeof(data) = 'object'),
    read_at timestamptz not null,
    primary key (workspace_id, capability_id, day),
    -- The account is the same workspace's.
    foreign key (workspace_id, capability_id) references capabilities (workspace_id, id)
        on delete cascade,
    check ((data->>'workspace_id')::uuid = workspace_id),
    check ((data->>'capability_id')::uuid = capability_id)
);

-- The tenant's alone (forced RLS, the policy of 0009_studio).
alter table social_account_days enable row level security;
alter table social_account_days force row level security;
drop policy if exists tenant_isolation on social_account_days;
create policy tenant_isolation on social_account_days
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');

-- A paused account is planned for and published on no more than a braked lane, for that account
-- alone (§7.6). The revision counts the settings' changes.
alter table studio_posting_policy
    add column if not exists paused_capability_ids uuid[] not null default '{}';
alter table studio_posting_policy
    add column if not exists revision bigint not null default 0 check (revision >= 0);

-- Whether a post is left with its platform's own scheduler where the platform has one (§7.3,
-- B47): off until a person switches it on.
alter table studio_posting_policy
    add column if not exists provider_scheduling boolean not null default false;
