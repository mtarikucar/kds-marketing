-- Bütçe (design 2026-11-10 §9, B37): one general ad budget per workspace, and a spend entry
-- that says which module spent it.

-- The general ad budget: an `ad_budget` item in a currency with a period that is not `total`.
-- Every paid spend counts against it, whatever the ad account, and ad campaigns draw from it.
-- A workspace that has exactly one such live item when the column arrives gets it marked: that
-- item is what it used as its ad budget. With none or several, a person chooses in Bütçe. The
-- table has FORCE RLS: the marking runs as the platform and leaves the setting as it found it.
do $$
declare
    previous_platform text := coalesce(current_setting('app.platform', true), '');
begin
    if not exists (select 1 from information_schema.columns
                   where table_schema = current_schema() and table_name = 'budget_items'
                     and column_name = 'general') then
        alter table budget_items add column general boolean not null default false;
        perform set_config('app.platform', 'on', true);
        update budget_items b set general = true
         where b.retired_at is null and b.kind = 'ad_budget'
           and b.unit->>'kind' = 'currency' and b.period <> 'total'
           and (select count(*) from budget_items o
                 where o.workspace_id = b.workspace_id and o.retired_at is null
                   and o.kind = 'ad_budget' and o.unit->>'kind' = 'currency'
                   and o.period <> 'total') = 1;
        perform set_config('app.platform', previous_platform, true);
    end if;
end $$;

alter table budget_items drop constraint if exists budget_items_general_rule;
alter table budget_items add constraint budget_items_general_rule check
    (not general or (kind = 'ad_budget' and unit->>'kind' = 'currency' and period <> 'total'));

-- At most one live general item per workspace.
create unique index if not exists budget_items_one_general
    on budget_items (workspace_id) where general and retired_at is null;

-- Which module a spend belongs to (S6: Bütçe shows spend by module) and, for advertising, which
-- ad campaign. Both absent on a spend a person or an agent recorded by hand.
alter table budget_spend_entries add column if not exists module text
    check (module in ('ads', 'inbox', 'outreach', 'calls', 'social'));
alter table budget_spend_entries add column if not exists campaign_id uuid;
