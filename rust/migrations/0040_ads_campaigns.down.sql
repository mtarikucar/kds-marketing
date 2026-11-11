-- A campaign is a record of money: what was committed, what was built at an ad platform and
-- what it spent. The rollback refuses while one is stored, rather than forget a campaign that
-- may be running; with none, the table goes. Running it again changes nothing.
do $$
declare
    previous_platform text := coalesce(current_setting('app.platform', true), '');
    stored boolean := false;
begin
    if to_regclass('ads_campaigns') is not null then
        perform set_config('app.platform', 'on', true);
        execute 'select exists (select 1 from ads_campaigns)' into stored;
        perform set_config('app.platform', previous_platform, true);
        if stored then
            raise exception 'down refused: an ad campaign is stored';
        end if;
    end if;
end $$;
drop table if exists ads_campaigns;
