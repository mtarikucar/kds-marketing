-- Image generation runs in a connected external agent. Keep its task and source provenance.
create table if not exists studio_material_productions (
    workspace_id uuid not null references workspaces(id),
    id uuid not null,
    revision bigint not null check (revision > 0),
    data jsonb not null check (jsonb_typeof(data) = 'object'),
    primary key (workspace_id,id),
    check (data->'production'->>'status' in ('pending','running','completed','failed','cancelled'))
);
alter table studio_material_productions enable row level security;
alter table studio_material_productions force row level security;
drop policy if exists tenant_isolation on studio_material_productions;
create policy tenant_isolation on studio_material_productions
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');
