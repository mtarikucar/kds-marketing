-- Reverts 0017_device_bridge: takes devices.work, devices.manage and devices.bridge off the system
-- roles (they did not exist before; custom roles keep what their workspaces gave them), then drops
-- the commands' table. A no-op when already reverted.
do $$ declare previous text; begin
    previous := current_setting('app.platform', true);
    perform set_config('app.platform', 'on', true);
    update roles set permissions = array_remove(array_remove(array_remove(permissions, 'devices.work'), 'devices.manage'), 'devices.bridge')
        where is_system and permissions && array['devices.work', 'devices.manage', 'devices.bridge'];
    perform set_config('app.platform', coalesce(previous, ''), true);
end $$;
drop table if exists device_commands;
