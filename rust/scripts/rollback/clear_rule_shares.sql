-- Before going back from PR 4's binaries (or later ones) to PR 3's (design 2026-11-19
-- "Paylaşımlar and Bilgi bankası" §7.6): clears every share the person-upload rule gave
-- (§3.4.4, D5). A PR 3 binary does not know a share by rule: it takes a real material's share
-- with no person on it for an invalid row, and refuses every write to that material (an analysis,
-- a tag, a filing, an intelligence update, a production invalidated). Going back without this
-- would leave such a material's analysis stuck.
--
-- For every material not erased whose share is the rule's (`data->'share'->>'rule' =
-- 'person_upload'`): the share is cleared (the stored document and its `share` column), its
-- revision raised by one, and one `studio.material.permission_set` ledger entry written (the
-- system as actor, component `rollback`; payload `{"share": null, "reason": "rollback",
-- "rule": "person_upload", "revision"}`). A cleared share errs safe under D5: a person decides
-- again on PR 3's pages, and a post showing the file is held by the publish gate meanwhile.
--
-- Runs for every workspace, so with `app.platform` on, put back as it was. Repeatable: a second
-- run changes nothing. Run it before switching the binaries:
--
--   psql "$JEETA_DATABASE_URL" -v ON_ERROR_STOP=1 -f clear_rule_shares.sql
do $$
declare
    previous_platform text := coalesce(current_setting('app.platform', true), '');
    cleared integer := 0;
begin
    perform set_config('app.platform', 'on', true);
    if to_regclass('public.studio_materials') is not null then
        with updated as (
            update studio_materials m
            set data = jsonb_set(jsonb_set(m.data, '{share}', 'null'::jsonb), '{revision}',
                                 to_jsonb(m.revision + 1)),
                share = null,
                revision = m.revision + 1
            where m.erased_at is null
              and m.data->'share'->>'rule' = 'person_upload'
            returning m.workspace_id, m.id, m.revision
        )
        insert into ledger_entries (
            workspace_id, at, actor_kind, actor_component, action, subject_kind, subject_id,
            payload, strategy_version_id
        )
        select u.workspace_id, now(), 'system', 'rollback', 'studio.material.permission_set',
               'studio_material', u.id::text,
               jsonb_build_object('share', null, 'reason', 'rollback', 'rule', 'person_upload',
                                  'revision', u.revision),
               (select v.id from strategy_versions v
                where v.workspace_id = u.workspace_id and v.status = 'approved'
                limit 1)
        from updated u;
        get diagnostics cleared = row_count;
        raise notice 'clear_rule_shares: % materials cleared', cleared;
    end if;
    perform set_config('app.platform', previous_platform, true);
end $$;
