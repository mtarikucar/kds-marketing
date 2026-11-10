-- Declarative blueprints and module bindings. No executable content or secrets.
-- Preserve existing navigation; newly registered workspaces start with only the core.
-- Both workspaces and this table force RLS even for the ordinary migration owner.
-- Repeating the migration must neither overwrite configured registries nor turn a newly
-- registered, core-only workspace into a legacy workspace. Seed only at table creation.
do $$
declare
    previous_platform text := coalesce(current_setting('app.platform', true), '');
    registry_existed boolean := to_regclass('public.workspace_modules') is not null;
begin
    create table if not exists workspace_modules (
        workspace_id uuid primary key references workspaces(id),
        data jsonb not null check (jsonb_typeof(data) = 'object')
    );
    alter table workspace_modules enable row level security;
    alter table workspace_modules force row level security;
    drop policy if exists tenant_isolation on workspace_modules;
    create policy tenant_isolation on workspace_modules
        using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
               or current_setting('app.platform', true) = 'on')
        with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                    or current_setting('app.platform', true) = 'on');
    if not registry_existed then
        perform set_config('app.platform', 'on', true);
        insert into workspace_modules (workspace_id, data)
            select id, '{"legacy":true,"modules":[]}'::jsonb from workspaces;
        perform set_config('app.platform', previous_platform, true);
    end if;
end $$;
