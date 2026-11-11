-- External agents claim analysis work; the server stores results and leases, never performs vision.
create table if not exists studio_material_intelligence (
    workspace_id uuid not null references workspaces(id),
    material_id uuid not null,
    data jsonb not null check (jsonb_typeof(data) = 'object'),
    primary key (workspace_id, material_id),
    foreign key (workspace_id, material_id) references studio_materials(workspace_id,id),
    check (data->'intelligence'->>'status' in ('pending','running','completed','failed'))
);
alter table studio_material_intelligence enable row level security;
alter table studio_material_intelligence force row level security;
drop policy if exists tenant_isolation on studio_material_intelligence;
create policy tenant_isolation on studio_material_intelligence
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');
-- Existing materials remain unchanged; the work projection offers missing analysis records on agent check-in.
