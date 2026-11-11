-- Reverts 0015_voice_calls: refuses while a call is not ended (its line may still be in use),
-- then drops the call tables, the policy column and the consumption retry columns, and takes
-- calls.work and calls.manage off the system roles (they did not exist before; custom roles keep
-- what their workspaces gave them). A no-op when already reverted.
do $$ declare previous text; begin
    previous := current_setting('app.platform', true);
    perform set_config('app.platform', 'on', true);
    -- Nested: PL/pgSQL plans a condition whole, and the table may be gone already.
    if to_regclass('public.call_sessions') is not null then
        if exists (select 1 from call_sessions where state <> 'ended') then
            raise exception '0015_voice_calls down refused: a call session is not ended';
        end if;
    end if;
    update roles set permissions = array_remove(array_remove(permissions, 'calls.work'), 'calls.manage')
        where is_system and permissions && array['calls.work', 'calls.manage'];
    perform set_config('app.platform', coalesce(previous, ''), true);
end $$;
drop table if exists call_duty;
drop table if exists call_commands;
drop table if exists call_turns;
drop table if exists call_sessions;
alter table if exists workspace_policies drop column if exists calls;
alter table if exists event_consumption drop column if exists retry_at;
alter table if exists event_consumption drop column if exists attempts;
