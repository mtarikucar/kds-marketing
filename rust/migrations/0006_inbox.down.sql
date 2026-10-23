-- Revert only this schema and its system-role grants; custom roles are untouched.
select set_config('app.platform', 'on', true);
update roles set permissions = array_remove(permissions, 'inbox.work')
where is_system and key in ('owner','manager','rep') and permissions @> array['inbox.work'];
update roles set permissions = array_remove(permissions, 'inbox.manage')
where is_system and key in ('owner','manager') and permissions @> array['inbox.manage'];
drop table if exists request_keys;
-- Receipt/echo lookup indexes are task-owned and are also removed by the table drops.
drop index if exists messages_external_lookup;
drop index if exists messages_echo_candidates;
drop index if exists outbox_message_lookup;
-- Dropping the outbox also removes its conversation_merged receipt fence.
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
drop index if exists inbound_events_call_lookup;
alter table if exists inbound_events drop column if exists call_unique_id;
create or replace function inbound_events_guard() returns trigger
language plpgsql as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'inbound_events rows are never deleted';
    end if;
    -- Every column but `raw` and `processed_at` is frozen, `id` and `workspace_id` included, and
    -- so is any column a later migration adds: the rows are compared whole, as JSON, without
    -- those two.
    if (to_jsonb(new) - 'raw' - 'processed_at') is distinct from
       (to_jsonb(old) - 'raw' - 'processed_at') then
        raise exception 'inbound_events is append-only: only raw and processed_at may change';
    end if;
    if new.raw is not null and new.raw is distinct from old.raw then
        raise exception 'inbound_events.raw may only be removed';
    end if;
    return new;
end;
$$;
drop index if exists inbound_events_id_workspace_idx;

-- Keep the policy row and its pre-existing check-in interval.
alter table if exists workspace_policies drop column if exists inbox_status_labels;
