-- A prospect's purpose (owner request 2026-11-27, "aday havuzu: sınıflandırma ve amaç"): the ICP
-- entry (`IcpEntry::key` of the strategy's `prospecting` section, the "sales door") the business
-- was sought for, so the pool filters, counts and explains its candidates by what they are for.
-- `prospects.create` takes it from the research task (a standing task's own entry, the entry an
-- ad-hoc task names) or, outside a task, from the recorder; a person may change it. Additive: one
-- nullable column with its check, no index (a workspace's pool is read through `prospects_list`).
--
-- The backfill writes only what is certain: a prospect recorded for a standing task was sought for
-- that task's ICP entry. A prospect of an ad-hoc task (which named no entry before this release)
-- or of no task keeps no purpose; the panel says "Bilinmiyor". Neither the revision nor
-- `updated_at` moves: the purpose was the prospect's from its start, only not written down. The
-- table has FORCE RLS: the backfill runs as the platform and leaves the setting as it found it.
-- Repeatable: every statement is guarded.
alter table prospects add column if not exists icp_key text;
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'prospects'::regclass and conname = 'prospects_icp_key_check'
    ) then
        alter table prospects add constraint prospects_icp_key_check
            check (icp_key is null or icp_key ~ '^[a-z0-9_]{2,32}$');
    end if;
end;
$$;
do $$
declare previous_platform text := coalesce(current_setting('app.platform', true), '');
begin
    perform set_config('app.platform', 'on', true);
    update prospects p
       set icp_key = t.kind->>'icp_key'
      from research_tasks t
     where t.workspace_id = p.workspace_id
       and t.id = p.research_task_id
       and t.kind->>'type' = 'standing'
       and (t.kind->>'icp_key') ~ '^[a-z0-9_]{2,32}$'
       and p.icp_key is null;
    perform set_config('app.platform', previous_platform, true);
end $$;
