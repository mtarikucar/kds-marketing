-- Before going back to a binary older than schema 46 (design 2026-11-19 "Paylaşımlar and Bilgi
-- bankası" §7.1, §7.6): removes every wake reason code newer than schema 45 from the agents' wake
-- rows, so that binary can read them. Binaries from schema 46 on drop an unknown code when they
-- read a row; older ones refuse the whole row.
--
-- In each `agent_wakes` row, the pending wake's `reasons` and the last attempt's `reasons` keep
-- only the codes schema 45 knows, in their order; a pending wake left with no reason is removed
-- (and its row is no longer due). Rows the codes of schema 45 alone fill are left as they are.
--
-- Runs for every workspace, so with `app.platform` on, put back as it was. Repeatable: a second
-- run changes nothing.
--
--   psql "$JEETA_DATABASE_URL" -v ON_ERROR_STOP=1 -f strip_new_wake_reasons.sql
do $$
declare
    previous_platform text := coalesce(current_setting('app.platform', true), '');
    known constant text[] := array[
        'content_revision',
        'content_requested',
        'capture_answered',
        'production_requested',
        'material_uploaded',
        'analysis_retried',
        'delivery_accepted',
        'account_resumed',
        'ad_campaign_opened',
        'research_requested',
        'conversation_handed',
        'strategy_approved',
        'manual'
    ];
    pending_left integer;
    last_left integer;
begin
    perform set_config('app.platform', 'on', true);
    if to_regclass('public.agent_wakes') is not null then
        -- The pending wake: its known codes, or no pending wake at all.
        update agent_wakes w
        set data = case
                when kept.reasons = '[]'::jsonb then jsonb_set(w.data, '{pending}', 'null'::jsonb)
                else jsonb_set(w.data, '{pending,reasons}', kept.reasons)
            end,
            due_at = case when kept.reasons = '[]'::jsonb then null else w.due_at end
        from (
            select a.workspace_id, a.api_key_id,
                   coalesce((select jsonb_agg(r.code order by r.ord)
                             from jsonb_array_elements_text(a.data->'pending'->'reasons')
                                  with ordinality as r(code, ord)
                             where r.code = any(known)), '[]'::jsonb) as reasons
            from agent_wakes a
            where jsonb_typeof(a.data->'pending'->'reasons') = 'array'
              and exists (select 1
                          from jsonb_array_elements_text(a.data->'pending'->'reasons') as r(code)
                          where not (r.code = any(known)))
        ) kept
        where w.workspace_id = kept.workspace_id and w.api_key_id = kept.api_key_id;
        get diagnostics pending_left = row_count;

        -- The last attempt: its known codes (an attempt may name none).
        update agent_wakes w
        set data = jsonb_set(w.data, '{last,reasons}', kept.reasons)
        from (
            select a.workspace_id, a.api_key_id,
                   coalesce((select jsonb_agg(r.code order by r.ord)
                             from jsonb_array_elements_text(a.data->'last'->'reasons')
                                  with ordinality as r(code, ord)
                             where r.code = any(known)), '[]'::jsonb) as reasons
            from agent_wakes a
            where jsonb_typeof(a.data->'last'->'reasons') = 'array'
              and exists (select 1
                          from jsonb_array_elements_text(a.data->'last'->'reasons') as r(code)
                          where not (r.code = any(known)))
        ) kept
        where w.workspace_id = kept.workspace_id and w.api_key_id = kept.api_key_id;
        get diagnostics last_left = row_count;

        raise notice 'strip_new_wake_reasons: % pending and % last attempts rewritten',
            pending_left, last_left;
    end if;
    perform set_config('app.platform', previous_platform, true);
end $$;
