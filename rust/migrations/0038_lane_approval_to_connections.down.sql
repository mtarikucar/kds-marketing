-- Puts the lane's approval switch back as 0038 found it: on for the lanes it was on for, and the
-- connections whose flag the migration set get it cleared again (the lane's switch covers them
-- once more). A flag a person set on a connection is not in the record and is left alone. Every
-- lane entry gets the field back (off where it was not on): the code before 0038 does not read
-- a lane entry without it. Running it again changes nothing.
do $$
declare
    previous_platform text := coalesce(current_setting('app.platform', true), '');
begin
    perform set_config('app.platform', 'on', true);
    if exists (select 1 from information_schema.columns
               where table_schema = current_schema() and table_name = 'studio_control'
                 and column_name = 'lane_approval_moved') then
        execute $move$
            update capabilities c
               set policy = jsonb_set(c.policy, '{requires_human_approval}', 'false'::jsonb, true)
              from studio_control s, jsonb_each(s.lane_approval_moved) lane,
                   jsonb_array_elements_text(lane.value) moved(id)
             where s.lane_approval_moved is not null
               and c.workspace_id = s.workspace_id
               and c.id = moved.id::uuid
               and c.policy->'requires_human_approval' = 'true'::jsonb
        $move$;
        execute $lanes$
            update studio_control s
               set data = jsonb_set(s.data, '{lanes}',
                       coalesce(nullif(s.data->'lanes', 'null'::jsonb), '{}'::jsonb) || (
                           select jsonb_object_agg(lane.key,
                                      coalesce(s.data->'lanes'->lane.key,
                                               '{"brake_engaged": false}'::jsonb)
                                      || '{"requires_human_approval": true}'::jsonb)
                             from jsonb_each(s.lane_approval_moved) lane), true)
             where s.lane_approval_moved is not null
               and s.lane_approval_moved <> '{}'::jsonb
        $lanes$;
    end if;
    update studio_control s
       set data = jsonb_set(s.data, '{lanes}', (
               select jsonb_object_agg(e.key,
                          case when e.value->'requires_human_approval' is null
                               then e.value || '{"requires_human_approval": false}'::jsonb
                               else e.value end)
                 from jsonb_each(s.data->'lanes') e))
     where jsonb_typeof(s.data->'lanes') = 'object'
       and exists (select 1 from jsonb_each(s.data->'lanes') e
                    where e.value->'requires_human_approval' is null);
    perform set_config('app.platform', previous_platform, true);
end $$;
alter table if exists studio_control drop column if exists lane_approval_moved;
