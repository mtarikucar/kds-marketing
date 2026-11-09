-- A project coordinates existing media and publishing records without creating another tenant.
create table if not exists studio_production_projects (
    workspace_id uuid not null references workspaces(id),
    id uuid not null,
    revision bigint not null check (revision > 0),
    archived boolean not null default false,
    data jsonb not null check (jsonb_typeof(data) = 'object'),
    primary key (workspace_id,id),
    check ((data->>'workspace_id')::uuid = workspace_id),
    check ((data->>'id')::uuid = id),
    check ((data->>'revision')::bigint = revision),
    check ((data->>'archived')::boolean = archived)
);
create index if not exists studio_projects_recent on studio_production_projects (workspace_id, archived, id desc);
alter table studio_production_projects enable row level security;
alter table studio_production_projects force row level security;
drop policy if exists tenant_isolation on studio_production_projects;
create policy tenant_isolation on studio_production_projects
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');

-- A project request is consumed by the canonical post planner, not a second scheduler.
alter table studio_package_requests drop constraint if exists studio_package_requests_trigger_check;
alter table studio_package_requests add constraint studio_package_requests_trigger_check check (trigger in ('olay','calendar','floor','project'));
