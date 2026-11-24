-- Composed posts (`studio.post_render`): each workspace's brand tokens, the colours, fonts, brand
-- name and logo material its slides and story frames are drawn with. One row per workspace, set
-- through `studio.brand_set`; no row means the neutral defaults. The tokens are a JSON object the
-- application validates; `revision` counts the sets. Forced RLS like every tenant table.
create table if not exists studio_brand (
    workspace_id uuid primary key references workspaces (id),
    data jsonb not null check (jsonb_typeof(data) = 'object'),
    revision bigint not null check (revision > 0),
    updated_at timestamptz not null
);

alter table studio_brand enable row level security;
alter table studio_brand force row level security;
drop policy if exists tenant_isolation on studio_brand;
create policy tenant_isolation on studio_brand
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');
