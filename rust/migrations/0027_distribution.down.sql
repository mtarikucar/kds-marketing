-- Reverts 0027_distribution: drops the assignment log (its trigger with it) and its guard, the
-- rules and the rep profiles, and drops `people.recipient_kind` only while every person reads
-- `unknown` (else the column stays, so a kind promotion or a person set survives; run this again
-- once every row is `unknown`). A no-op when already reverted.
drop table if exists journey_assignments;
drop function if exists journey_assignments_guard();
drop table if exists distribution_rules;
drop table if exists rep_profiles;
do $$ declare previous text; begin
    previous := current_setting('app.platform', true);
    perform set_config('app.platform', 'on', true);
    if exists (select 1 from information_schema.columns where table_schema = current_schema()
               and table_name = 'people' and column_name = 'recipient_kind') then
        if not exists (select 1 from people where recipient_kind <> 'unknown') then
            alter table people drop column recipient_kind;
        end if;
    end if;
    perform set_config('app.platform', coalesce(previous, ''), true);
end $$;
