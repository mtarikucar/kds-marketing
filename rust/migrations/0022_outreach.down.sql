-- Reverts 0022_outreach: takes outreach.work and outreach.manage off the system roles (they did
-- not exist before; custom roles keep what their workspaces gave them) and drops the four tables,
-- their indexes with them. Nothing here holds an objection: an unsubscribe is the inbox's
-- suppression and withdrawn consent, which stay. A no-op when already reverted.
do $$ declare previous text; begin
    previous := current_setting('app.platform', true);
    perform set_config('app.platform', 'on', true);
    update roles set permissions = array_remove(array_remove(permissions, 'outreach.work'), 'outreach.manage')
        where is_system and permissions && array['outreach.work', 'outreach.manage'];
    perform set_config('app.platform', coalesce(previous, ''), true);
end $$;
drop table if exists outreach_sends;
drop table if exists outreach_enrollments;
drop table if exists outreach_campaigns;
drop table if exists outreach_templates;
