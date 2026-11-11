-- Reverts 0016_voice_bridge: takes calls.bridge off the system roles (it did not exist before;
-- custom roles keep what their workspaces gave them), then drops the bridge's event notes and the
-- commands' queue order. A no-op when already reverted.
do $$ declare previous text; begin
    previous := current_setting('app.platform', true);
    perform set_config('app.platform', 'on', true);
    update roles set permissions = array_remove(permissions, 'calls.bridge')
        where is_system and 'calls.bridge' = any (permissions);
    perform set_config('app.platform', coalesce(previous, ''), true);
end $$;
drop table if exists call_bridge_events;
alter table if exists call_commands drop column if exists seq;
