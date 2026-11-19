-- Reverts 0046_knowledge_base: drops the five knowledge tables and the trigger function. Only for
-- undoing this release before the next one (the knowledge base's seeding) is deployed: it
-- deletes the owner's knowledge, so it is never a step of a binary rollback after that, and ops
-- dumps the five tables first.
--
-- Refuses while a production area holds a version cancelled without a planned post
-- (`VersionCancel.slot_id` absent or null), which a binary older than this release cannot read.
-- The areas table forces row-level security, so the guard looks with `app.platform` on, and
-- puts the setting back as it was. Repeatable: every statement is guarded.
do $$
declare
    previous_platform text := coalesce(current_setting('app.platform', true), '');
    blocked boolean := false;
begin
    perform set_config('app.platform', 'on', true);
    if to_regclass('public.studio_production_projects') is not null then
        execute $q$select exists (select 1 from studio_production_projects where jsonb_path_exists(
            data,
            '$.packages[*].versions[*].cancelled ? (@.type() == "object" && (!(exists(@.slot_id)) || @.slot_id == null))'))$q$
            into blocked;
        if blocked then
            raise exception 'down refused: a production area holds a version cancelled without a planned post';
        end if;
    end if;
    perform set_config('app.platform', previous_platform, true);
end $$;
drop table if exists knowledge_proposals;
drop table if exists knowledge_notes;
drop table if exists knowledge_revisions;
drop table if exists knowledge_cards;
drop table if exists knowledge_settings;
drop function if exists knowledge_revisions_immutable();
