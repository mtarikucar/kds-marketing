-- A `card_new` proposal may name the well-known card it makes (`jt_knowledge::WELL_KNOWN_CARDS`,
-- today `visual_style`, which the brand scan proposes: docs/operations/brand-scan.md): accepting
-- it makes the card with that key, so the agents find it by its key whatever the owner renames it
-- to. Nothing changes until the owner adds the proposal. Additive: one nullable column on
-- `knowledge_proposals`, with its check. Repeatable: every statement is guarded.
alter table knowledge_proposals add column if not exists card_key text;
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'knowledge_proposals'::regclass
          and conname = 'knowledge_proposals_card_key_rule'
    ) then
        alter table knowledge_proposals add constraint knowledge_proposals_card_key_rule
            check (card_key is null
                   or (kind = 'card_new' and card_key ~ '^[a-z][a-z0-9_]{1,39}$'));
    end if;
end;
$$;
