-- The inbox's automatic replies come back first after an automatic hand-over
-- (`usecases::inbox::autoreply`): each queue row keeps the last automatic hand-over the assistant
-- may come back from (the executor generation it wrote and when; none after an order's
-- hand-over, which a person finishes), and when and for which reason the customer and the owner
-- were last told of one. Additive: four nullable columns on `auto_reply_queue`. Repeatable:
-- every statement is guarded.
alter table auto_reply_queue add column if not exists auto_handed_generation bigint
    check (auto_handed_generation is null or auto_handed_generation between 0 and 4294967295);
alter table auto_reply_queue add column if not exists auto_handed_at timestamptz;
alter table auto_reply_queue add column if not exists told_at timestamptz;
alter table auto_reply_queue add column if not exists told_reason text;

-- Backfill, conservatively: a served conversation (it has a queue row) a person holds now is
-- marked as handed over automatically only when its latest automatic hand-over in the ledger (the
-- automatic replies' or the response-time job's) is its latest executor change of any kind
-- (nothing under `inbox.conversation.%` at or after it: no take-over, no hand-back) and its
-- reason is not an order's. Nobody is marked as told. Whether a person wrote since is read from
-- the messages at run time.
select set_config('app.platform', 'on', true);
update auto_reply_queue q
set auto_handed_generation = c.executor_generation,
    auto_handed_at = a.at
from conversations c
cross join lateral (
    select l.at, l.payload ->> 'reason' as reason
    from ledger_entries l
    where l.workspace_id = c.workspace_id
      and l.subject_kind = 'conversation'
      and l.subject_id = c.id::text
      and l.action in ('inbox.autoreply.handed_over', 'inbox.response_sla')
    order by l.at desc, l.id desc
    limit 1
) a
where c.workspace_id = q.workspace_id
  and c.id = q.conversation_id
  and c.executor_kind = 'human'
  and q.auto_handed_generation is null
  and coalesce(a.reason, '') not like 'order\_%'
  and not exists (
      select 1 from ledger_entries t
      where t.workspace_id = c.workspace_id
        and t.subject_kind = 'conversation'
        and t.subject_id = c.id::text
        and (t.action like 'inbox.conversation.%' or t.action = 'inbox.autoreply.reentered')
        and t.at >= a.at
  );
select set_config('app.platform', '', true);
