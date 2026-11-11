-- Split stored module grants without widening partial grants on rollback.
-- Preserve first occurrence order and deduplicate; repeat execution is a no-op.
do $$
declare
    previous_platform text := coalesce(current_setting('app.platform', true), '');
begin
    perform set_config('app.platform', 'on', true);
    update roles
       set permissions = array(
           select value from (
               select distinct on (value) value, pos, subpos
                 from unnest(permissions) with ordinality as old(key, pos)
                      cross join lateral unnest(case key when 'studio.work' then array['content.work', 'social.work', 'ads.work', 'materials.work']::text[] when 'studio.manage' then array['content.manage', 'social.manage', 'ads.manage']::text[] else array[key] end) with ordinality as expanded(value, subpos)
                order by value, pos, subpos
           ) unique_keys order by pos, subpos
       )
     where permissions && array['studio.work', 'studio.manage']::text[];
    update api_keys
       set scopes = array(
           select value from (
               select distinct on (value) value, pos, subpos
                 from unnest(scopes) with ordinality as old(key, pos)
                      cross join lateral unnest(case key when 'studio.work' then array['content.work', 'social.work', 'ads.work', 'materials.work']::text[] when 'studio.manage' then array['content.manage', 'social.manage', 'ads.manage']::text[] else array[key] end) with ordinality as expanded(value, subpos)
                order by value, pos, subpos
           ) unique_keys order by pos, subpos
       )
     where scopes && array['studio.work', 'studio.manage']::text[];
    perform set_config('app.platform', previous_platform, true);
end $$;
