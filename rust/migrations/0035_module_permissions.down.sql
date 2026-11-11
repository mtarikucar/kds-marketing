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
               select distinct on (value) value, pos
                 from unnest(array(select key from unnest(permissions) key where not (key = any(array['content.work', 'social.work', 'ads.work', 'materials.work', 'content.manage', 'social.manage', 'ads.manage']::text[])))
                    || case when permissions @> array['content.work', 'social.work', 'ads.work', 'materials.work']::text[] then array['studio.work']::text[] else array[]::text[] end
                    || case when permissions @> array['content.manage', 'social.manage', 'ads.manage']::text[] then array['studio.manage']::text[] else array[]::text[] end) with ordinality as expanded(value, pos)
                order by value, pos
           ) unique_keys order by pos
       )
     where permissions && array['content.work', 'social.work', 'ads.work', 'materials.work', 'content.manage', 'social.manage', 'ads.manage']::text[];
    update api_keys
       set scopes = array(
           select value from (
               select distinct on (value) value, pos
                 from unnest(array(select key from unnest(scopes) key where not (key = any(array['content.work', 'social.work', 'ads.work', 'materials.work', 'content.manage', 'social.manage', 'ads.manage']::text[])))
                    || case when scopes @> array['content.work', 'social.work', 'ads.work', 'materials.work']::text[] then array['studio.work']::text[] else array[]::text[] end
                    || case when scopes @> array['content.manage', 'social.manage', 'ads.manage']::text[] then array['studio.manage']::text[] else array[]::text[] end) with ordinality as expanded(value, pos)
                order by value, pos
           ) unique_keys order by pos
       )
     where scopes && array['content.work', 'social.work', 'ads.work', 'materials.work', 'content.manage', 'social.manage', 'ads.manage']::text[];
    perform set_config('app.platform', previous_platform, true);
end $$;
