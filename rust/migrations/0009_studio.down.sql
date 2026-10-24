-- Schema rollback removes Studio data; baseline inbox, strategy, budget and ledger rows survive.
do $$ declare previous text; begin
    if to_regclass('public.studio_control') is not null then
        previous := current_setting('app.platform',true);
        perform set_config('app.platform','on',true);
        update roles r set permissions=array(select p from unnest(r.permissions) p where not exists (
            select 1 from studio_control c cross join lateral jsonb_array_elements(c.seed_grants) g
            where c.workspace_id=r.workspace_id and (g->>'role_id')::uuid=r.id and g->>'permission'=p))
        where exists (select 1 from studio_control c cross join lateral jsonb_array_elements(c.seed_grants) g
            where c.workspace_id=r.workspace_id and (g->>'role_id')::uuid=r.id
                  and g->>'permission'=any(r.permissions));
        perform set_config('app.platform',coalesce(previous,''),true);
    end if;
end $$;
drop table if exists studio_request_keys;
drop table if exists studio_budget_moves;
drop table if exists studio_spend_reservations;
drop table if exists studio_learning_applications;
drop table if exists studio_measurements;
drop table if exists studio_trends;
drop table if exists studio_publications;
drop table if exists studio_publish_attempts;
drop table if exists studio_pieces;
drop table if exists studio_files;
drop table if exists studio_adset_bindings;
drop table if exists studio_slots;
drop table if exists studio_arms;
drop table if exists studio_control;
drop index if exists studio_hypothesis_tenant_identity;
alter table budget_items drop column if exists unit_cost_minor;
alter table strategy_hypotheses drop column if exists cadence;
do $$ begin
    if exists (select 1 from information_schema.columns where table_schema = 'public'
               and table_name = 'strategy_hypotheses' and column_name = 'prior_confidence') then
        alter table strategy_hypotheses rename column prior_confidence to confidence;
    end if;
end $$;
