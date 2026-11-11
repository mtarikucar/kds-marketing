-- The Growth Studio becomes four modules (design 2026-11-10-uc-modul-ve-panel-iskeleti-design.md
-- §4.4): content creation, social media, advertising and the materials library they share. The
-- inbox stops being a required module at the same time. Stored registries follow, so that nobody
-- loses a section they had:
--   (a) a registry holding a `growth-studio` entry gets the four new entries with that entry's
--       `installed` flag and configuration, and loses the old entry;
--   (b) a registry that is not `legacy` and has no `inbox` entry gets one, installed: until now
--       the inbox was installed for every workspace because it was required;
--   (c) a workspace with no registry row gets one holding that same inbox entry.
-- A `legacy` registry with no explicit entries needs nothing: every builtin module, the four new
-- ones included, reads as installed for it. Builtin blueprints are rebuilt from code on every
-- read, so the names written here are placeholders. Repeating this is a no-op.
do $$
declare
    previous_platform text := coalesce(current_setting('app.platform', true), '');
    inbox_entry constant jsonb := '{"blueprint":{"id":"inbox","name":"Gelen kutusu","description":"","version":"1.0","requirements":[],"workflow":[],"builtin":true},"installed":true,"required":false,"config":{"brief":"","agent_ids":[],"capability_ids":[]},"revision":1}'::jsonb;
begin
    if to_regclass('public.workspace_modules') is null then
        return;
    end if;
    perform set_config('app.platform', 'on', true);

    -- (a)
    update workspace_modules w
    set data = jsonb_set(
        w.data,
        '{modules}',
        (
            select coalesce(jsonb_agg(m.entry order by m.ord), '[]'::jsonb)
            from (
                select e.entry, e.ord::numeric as ord
                from jsonb_array_elements(w.data->'modules') with ordinality as e(entry, ord)
                where e.entry->'blueprint'->>'id'
                      not in ('growth-studio', 'content', 'social', 'ads', 'materials')
                union all
                select jsonb_build_object(
                           'blueprint', jsonb_build_object(
                               'id', n.id, 'name', n.name, 'description', '', 'version', '1.0',
                               'requirements', '[]'::jsonb, 'workflow', '[]'::jsonb, 'builtin', true),
                           'installed', coalesce((s.entry->>'installed')::boolean, false),
                           'required', false,
                           'config', coalesce(
                               s.entry->'config',
                               '{"brief":"","agent_ids":[],"capability_ids":[]}'::jsonb),
                           'revision', 1),
                       s.ord::numeric + n.pos
                from jsonb_array_elements(w.data->'modules') with ordinality as s(entry, ord)
                cross join (values
                    ('content', 'İçerik oluşturma', 0.1),
                    ('social', 'Sosyal medya yönetimi', 0.2),
                    ('ads', 'Reklam yönetimi', 0.3),
                    ('materials', 'Materyal kütüphanesi', 0.4)
                ) as n(id, name, pos)
                where s.entry->'blueprint'->>'id' = 'growth-studio'
            ) m
        )
    )
    where jsonb_typeof(w.data->'modules') = 'array'
      and exists (
          select 1 from jsonb_array_elements(w.data->'modules') e
          where e->'blueprint'->>'id' = 'growth-studio');

    -- (b)
    update workspace_modules w
    set data = jsonb_set(
        w.data, '{modules}', coalesce(w.data->'modules', '[]'::jsonb) || inbox_entry, true)
    where coalesce((w.data->>'legacy')::boolean, false) = false
      and jsonb_typeof(coalesce(w.data->'modules', '[]'::jsonb)) = 'array'
      and not exists (
          select 1 from jsonb_array_elements(coalesce(w.data->'modules', '[]'::jsonb)) e
          where e->'blueprint'->>'id' = 'inbox');

    -- (c)
    insert into workspace_modules (workspace_id, data)
    select ws.id, jsonb_build_object('legacy', false, 'modules', jsonb_build_array(inbox_entry))
    from workspaces ws
    where not exists (select 1 from workspace_modules m where m.workspace_id = ws.id);

    perform set_config('app.platform', previous_platform, true);
end $$;
