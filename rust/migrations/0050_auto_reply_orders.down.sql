-- Reverts 0050_auto_reply_orders. The orders hold only codes, amounts and the shop's references
-- (the shop keeps its own copy of every order); the release before has no use for them. A run
-- that ordered is kept as `replied` (it queued an automatic message, the payment link), so the
-- narrower outcome check of 0047 holds again. Repeatable: every statement is guarded.
drop index if exists auto_reply_orders_created;
drop table if exists auto_reply_orders;
do $$
begin
    if to_regclass('auto_reply_runs') is not null then
        update auto_reply_runs set outcome = 'replied' where outcome = 'ordered';
        alter table auto_reply_runs drop constraint if exists auto_reply_runs_outcome_check;
        alter table auto_reply_runs add constraint auto_reply_runs_outcome_check
            check (outcome in ('replied', 'quoted', 'handed_over', 'skipped', 'failed'));
    end if;
end;
$$;
