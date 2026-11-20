-- Before going back from PR 2's binaries (or later ones) to PR 1's (design 2026-11-19
-- "Paylaşımlar and Bilgi bankası" §7.6): writes post approval back onto the social accounts'
-- stored flags, which is all a PR 1 binary reads for posts. From PR 2 on, post approval is the
-- knowledge base's (the Kurallar switch `post_approval` and the list `post_approval_accounts`,
-- D1), and once a workspace's post gate is seeded the stored `requires_human_approval` is no
-- longer read for its posts; going back without this would release every post that only the
-- knowledge base holds (an account added to the list or covered by the switch, an account
-- connected after the seed, a flag an agent lowered after the seed).
--
-- For every workspace whose post gate is seeded (`knowledge_settings.post_gate_seeded_at`): when
-- the switch is on, every social account that is not retired, else each listed one that is not
-- retired, gets `policy.requires_human_approval = true`, with one `capability.set_policy` ledger
-- entry per account changed (the system as actor, component `rollback`; payload the new policy
-- and `reason: "rollback"`; the frame in force named). This also holds those accounts' comment
-- replies until a person changes the flag, which errs safe. No flag is ever set to false, and an
-- account already flagged is left as it is.
--
-- Runs for every workspace, so with `app.platform` on, put back as it was. Repeatable: a second
-- run changes nothing. Run it before switching the binaries:
--
--   psql "$JEETA_DATABASE_URL" -v ON_ERROR_STOP=1 -f write_back_post_approval.sql
do $$
declare
    previous_platform text := coalesce(current_setting('app.platform', true), '');
    -- The kinds posts go out on (`studio::chain::ORGANIC_KINDS`).
    social constant text[] := array[
        'x',
        'instagram',
        'facebook_page',
        'tiktok',
        'linkedin_member',
        'linkedin_page'
    ];
    flagged integer := 0;
begin
    perform set_config('app.platform', 'on', true);
    if to_regclass('public.knowledge_settings') is not null then
        with targets as (
            select c.id, c.workspace_id
            from capabilities c
            join knowledge_settings k on k.workspace_id = c.workspace_id
            where k.post_gate_seeded_at is not null
              and c.kind_key = any(social)
              and c.status <> 'retired'
              and coalesce((c.policy->>'requires_human_approval')::boolean, false) = false
              and (k.post_approval
                   or k.post_approval_accounts @> jsonb_build_array(c.id::text))
        ),
        updated as (
            update capabilities c
            set policy = c.policy || jsonb_build_object('requires_human_approval', true),
                updated_at = now()
            from targets t
            where c.id = t.id and c.workspace_id = t.workspace_id
            returning c.id, c.workspace_id, c.policy
        )
        insert into ledger_entries (
            workspace_id, at, actor_kind, actor_component, action, subject_kind, subject_id,
            payload, strategy_version_id
        )
        select u.workspace_id, now(), 'system', 'rollback', 'capability.set_policy',
               'capability', u.id::text,
               jsonb_build_object('policy', u.policy, 'reason', 'rollback'),
               (select v.id from strategy_versions v
                where v.workspace_id = u.workspace_id and v.status = 'approved'
                limit 1)
        from updated u;
        get diagnostics flagged = row_count;
        raise notice 'write_back_post_approval: % social accounts flagged', flagged;
    end if;
    perform set_config('app.platform', previous_platform, true);
end $$;
