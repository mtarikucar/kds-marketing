-- Reverts 0034_split_growth_studio for the code before it, which knows one `growth-studio` module
-- and a required inbox:
--   (a) a registry holding any of `content`, `social`, `ads`, `materials` loses those entries
--       and, unless it already has one, gains a `growth-studio` entry: installed when any of the
--       four was, with the configuration of the first of them present (in that order);
--   (b) a registry that is not `legacy` loses an inbox entry still equal to the one the up
--       seeded (the older code installs the inbox for everyone, so nothing is lost);
--   (c) a registry left as an empty non-legacy one is deleted: that is what "no row" meant.
-- An inbox entry a workspace has since saved, and every other entry, is left as it is.
-- Repeating this is a no-op.
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
            select coalesce(jsonb_agg(e.entry order by e.ord), '[]'::jsonb)
            from jsonb_array_elements(w.data->'modules') with ordinality as e(entry, ord)
            where e.entry->'blueprint'->>'id' not in ('content', 'social', 'ads', 'materials')
        )
        || case
            when exists (
                select 1 from jsonb_array_elements(w.data->'modules') e
                where e->'blueprint'->>'id' = 'growth-studio')
            then '[]'::jsonb
            else jsonb_build_array(jsonb_build_object(
                'blueprint', jsonb_build_object(
                    'id', 'growth-studio', 'name', 'Büyüme stüdyosu', 'description', '',
                    'version', '1.0', 'requirements', '[]'::jsonb, 'workflow', '[]'::jsonb,
                    'builtin', true),
                'installed', (
                    select bool_or(coalesce((e->>'installed')::boolean, false))
                    from jsonb_array_elements(w.data->'modules') e
                    where e->'blueprint'->>'id' in ('content', 'social', 'ads', 'materials')),
                'required', false,
                'config', coalesce(
                    (
                        select e.entry->'config'
                        from jsonb_array_elements(w.data->'modules') with ordinality as e(entry, ord)
                        join (values ('content', 1), ('social', 2), ('ads', 3), ('materials', 4))
                             as p(id, pri) on p.id = e.entry->'blueprint'->>'id'
                        order by p.pri
                        limit 1
                    ),
                    '{"brief":"","agent_ids":[],"capability_ids":[]}'::jsonb),
                'revision', 1))
        end
    )
    where jsonb_typeof(w.data->'modules') = 'array'
      and exists (
          select 1 from jsonb_array_elements(w.data->'modules') e
          where e->'blueprint'->>'id' in ('content', 'social', 'ads', 'materials'));

    -- (b)
    update workspace_modules w
    set data = jsonb_set(
        w.data,
        '{modules}',
        (
            select coalesce(jsonb_agg(e.entry order by e.ord), '[]'::jsonb)
            from jsonb_array_elements(w.data->'modules') with ordinality as e(entry, ord)
            where e.entry <> inbox_entry
        )
    )
    where coalesce((w.data->>'legacy')::boolean, false) = false
      and jsonb_typeof(w.data->'modules') = 'array'
      and exists (
          select 1 from jsonb_array_elements(w.data->'modules') e where e = inbox_entry);

    -- (c)
    delete from workspace_modules where data = '{"legacy":false,"modules":[]}'::jsonb;

    perform set_config('app.platform', previous_platform, true);
end $$;
