-- Reverts 0052_knowledge_proposal_card_key: the column and its check. A pending proposal that
-- names a key is closed as superseded first (decided by nobody), so the release before never
-- adds it as a card without its key. Repeatable.
do $$
begin
    if exists (
        select 1 from information_schema.columns
        where table_name = 'knowledge_proposals' and column_name = 'card_key'
    ) then
        perform set_config('app.platform', 'on', true);
        update knowledge_proposals
        set status = 'superseded', decided_at = now()
        where card_key is not null and status = 'pending';
    end if;
end;
$$;
alter table if exists knowledge_proposals drop constraint if exists knowledge_proposals_card_key_rule;
alter table if exists knowledge_proposals drop column if exists card_key;
