-- Drops only M3 learning evidence/fields; preserves existing strategy, budget and inbox rows.
drop table if exists studio_learning_applications;
alter table budget_items drop column if exists unit_cost_minor;
alter table strategy_hypotheses drop column if exists cadence;
do $$ begin
    if exists (select 1 from information_schema.columns where table_schema = 'public'
               and table_name = 'strategy_hypotheses' and column_name = 'prior_confidence') then
        alter table strategy_hypotheses rename column prior_confidence to confidence;
    end if;
end $$;
