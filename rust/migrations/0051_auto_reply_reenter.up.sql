-- The inbox's automatic replies come back first after an automatic hand-over
-- (`usecases::inbox::autoreply`): each queue row keeps the last automatic hand-over (the executor
-- generation it wrote and when) and when the customer and the owner were last told of one.
-- Additive: three nullable columns on `auto_reply_queue`. Repeatable: every statement is guarded.
alter table auto_reply_queue add column if not exists auto_handed_generation bigint
    check (auto_handed_generation is null or auto_handed_generation between 0 and 4294967295);
alter table auto_reply_queue add column if not exists auto_handed_at timestamptz;
alter table auto_reply_queue add column if not exists told_at timestamptz;

-- Backfill, conservatively: a served conversation a person holds now counts as handed over
-- automatically when its latest automatic hand-over in the ledger (the automatic replies' or the
-- response-time job's) came after any explicit take-over. Whether a person wrote since is read
-- from the messages at run time, so it is not stored here.
select set_config('app.platform', 'on', true);
update auto_reply_queue q
set auto_handed_generation = c.executor_generation,
    auto_handed_at = a.at,
    told_at = a.at
from conversations c
cross join lateral (
    select max(l.at) as at
    from ledger_entries l
    where l.workspace_id = c.workspace_id
      and l.subject_kind = 'conversation'
      and l.subject_id = c.id::text
      and l.action in ('inbox.autoreply.handed_over', 'inbox.response_sla')
) a
where c.workspace_id = q.workspace_id
  and c.id = q.conversation_id
  and c.executor_kind = 'human'
  and a.at is not null
  and q.auto_handed_generation is null
  and not exists (
      select 1 from ledger_entries t
      where t.workspace_id = c.workspace_id
        and t.subject_kind = 'conversation'
        and t.subject_id = c.id::text
        and t.action = 'inbox.conversation.taken_over'
        and t.at >= a.at
  );
select set_config('app.platform', '', true);
