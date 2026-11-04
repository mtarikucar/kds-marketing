-- Reverts 0022_studio_posts: refuses while a planned post or a package request is stored (a re-run
-- of `up` would not bring them back), then drops its tables and function. A no-op when already
-- reverted.
do $$ declare previous text; begin
    previous := current_setting('app.platform', true);
    perform set_config('app.platform', 'on', true);
    -- Nested: PL/pgSQL plans a condition whole, and the table may be gone already.
    if to_regclass('public.studio_posts') is not null then
        if exists (select 1 from studio_posts) then
            raise exception '0022_studio_posts down refused: planned posts are stored';
        end if;
    end if;
    if to_regclass('public.studio_package_requests') is not null then
        if exists (select 1 from studio_package_requests) then
            raise exception '0022_studio_posts down refused: package requests are stored';
        end if;
    end if;
    perform set_config('app.platform', coalesce(previous, ''), true);
end $$;
drop table if exists studio_posts;
drop table if exists studio_posting_policy;
drop table if exists studio_package_requests;
drop function if exists studio_posts_fixed();
