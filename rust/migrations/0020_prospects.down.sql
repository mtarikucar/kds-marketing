-- Reverts 0020_prospects. Refuses while the blocklist holds an objection or an erasure: a
-- business's "do not contact me" must outlive a rollback (spec D9, D27). The operator exports
-- those hashes and deletes them by hand first. Rejection memory (rows that expire anyway) does not
-- hold the rollback up.
--
-- Then takes prospects.work and prospects.manage off the system roles (they did not exist before;
-- custom roles keep what their workspaces gave them), drops the five tables, their indexes with
-- them, and drops `workspace_policies.leads_policy` only while every row holds `{}` (else the
-- column stays, so a policy a workspace set survives; run this again once it is `{}`). A no-op
-- when already reverted.
do $$ declare previous text; begin
    previous := current_setting('app.platform', true);
    perform set_config('app.platform', 'on', true);
    -- Nested: PL/pgSQL plans a condition whole, and the table may be gone already.
    if to_regclass('public.prospect_blocklist') is not null then
        if exists (select 1 from prospect_blocklist where reason in ('do_not_contact', 'erased')) then
            raise exception '0020_prospects down refused: the prospect blocklist holds do-not-contact or erased entries';
        end if;
    end if;
    update roles set permissions = array_remove(array_remove(permissions, 'prospects.work'), 'prospects.manage')
        where is_system and permissions && array['prospects.work', 'prospects.manage'];
    perform set_config('app.platform', coalesce(previous, ''), true);
end $$;
drop table if exists prospect_scores;
drop table if exists prospect_keys;
drop table if exists prospects;
drop table if exists research_tasks;
drop table if exists prospect_blocklist;
do $$ declare previous text; begin
    previous := current_setting('app.platform', true);
    perform set_config('app.platform', 'on', true);
    if exists (select 1 from information_schema.columns where table_schema = current_schema()
               and table_name = 'workspace_policies' and column_name = 'leads_policy') then
        if not exists (select 1 from workspace_policies where leads_policy <> '{}'::jsonb) then
            alter table workspace_policies drop column leads_policy;
        end if;
    end if;
    perform set_config('app.platform', coalesce(previous, ''), true);
end $$;
