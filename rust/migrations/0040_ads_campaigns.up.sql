-- Ad campaigns (design 2026-11-10 §8): one document per campaign, from a goal and a budget to
-- what Jeeta built at the ad platform, what the agent changed and what it brought. `start_at`
-- orders the open campaigns; `closed_at` is set once a campaign is over (ended, declined or
-- expired) and orders the closed ones.
create table if not exists ads_campaigns (
    workspace_id uuid not null references workspaces (id),
    id uuid not null,
    revision bigint not null check (revision > 0),
    data jsonb not null check (jsonb_typeof(data) = 'object'),
    start_at timestamptz not null,
    closed_at timestamptz,
    primary key (workspace_id, id),
    check ((data->>'workspace_id')::uuid = workspace_id),
    check ((data->>'id')::uuid = id),
    check ((data->>'revision')::bigint = revision)
);
create index if not exists ads_campaigns_open
    on ads_campaigns (workspace_id, start_at, id) where closed_at is null;
create index if not exists ads_campaigns_closed
    on ads_campaigns (workspace_id, closed_at desc, id desc) where closed_at is not null;

-- The tenant's alone (forced RLS, the policy of 0009_studio).
alter table ads_campaigns enable row level security;
alter table ads_campaigns force row level security;
drop policy if exists tenant_isolation on ads_campaigns;
create policy tenant_isolation on ads_campaigns
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');
