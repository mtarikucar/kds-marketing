-- Revert only this schema and its system-role grants; custom roles are untouched.
select set_config('app.platform', 'on', true);
update roles set permissions = array_remove(permissions, 'inbox.work')
where is_system and key in ('owner','manager','rep') and permissions @> array['inbox.work'];
update roles set permissions = array_remove(permissions, 'inbox.manage')
where is_system and key in ('owner','manager') and permissions @> array['inbox.manage'];
drop table if exists request_keys;
drop table if exists outbox;
drop table if exists event_consumption;
drop table if exists lost_reasons;
drop table if exists merges;
drop table if exists notes;
drop table if exists tasks;
drop table if exists journey_events;
-- Dropping these task-owned tables also removes sender bindings and activity/reducer revisions.
drop table if exists journeys;
drop table if exists messages;
drop table if exists conversations;
drop table if exists identities;
drop table if exists people;
drop function if exists journey_events_immutable();
drop index if exists inbound_events_id_workspace_idx;

-- Keep the policy row and its pre-existing check-in interval.
alter table if exists workspace_policies drop column if exists inbox_status_labels;
