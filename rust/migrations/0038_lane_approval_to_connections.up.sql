-- A lane no longer has an approval switch of its own (design 2026-11-10 S18, B35): the approval
-- that remains is each connection's (`capabilities.policy.requires_human_approval`). A workspace
-- that had switched a lane's approval on keeps what it asked for: every connection of that lane
-- it has today gets the flag (social accounts for the organic lane, the ad account for the paid
-- one), so a post or an ad change that waited for a person yesterday still waits today.
--
-- A connection made after this migration starts as every connection does, without the flag: the
-- lane switch has nowhere left to live. `studio_control.lane_approval_moved` records what this
-- migration did (the lanes whose switch was on, and the connections whose flag it set), for the
-- rollback alone; the application never reads it.

alter table studio_control add column if not exists lane_approval_moved jsonb;

-- Both tables have FORCE RLS: the move runs as the platform, and leaves the setting as it found it.
do $$
declare
    previous_platform text := coalesce(current_setting('app.platform', true), '');
    lane text;
    kinds text[];
begin
    perform set_config('app.platform', 'on', true);
    foreach lane in array array['organic', 'paid'] loop
        kinds := case lane
            when 'organic' then array['x', 'instagram', 'facebook_page', 'tiktok',
                                      'linkedin_member', 'linkedin_page']
            else array['meta_ads'] end;
        with switched_on as (
            select workspace_id from studio_control
             where data->'lanes'->lane->'requires_human_approval' = 'true'::jsonb
        ), flagged as (
            update capabilities c
               set policy = jsonb_set(c.policy, '{requires_human_approval}', 'true'::jsonb, true)
              from switched_on s
             where c.workspace_id = s.workspace_id
               and c.kind_key = any(kinds)
               and c.policy->'requires_human_approval' is distinct from 'true'::jsonb
            returning c.workspace_id, c.id
        )
        update studio_control s
           set lane_approval_moved = coalesce(s.lane_approval_moved, '{}'::jsonb)
               || jsonb_build_object(lane, coalesce(
                      (select jsonb_agg(f.id order by f.id) from flagged f
                        where f.workspace_id = s.workspace_id), '[]'::jsonb))
         where s.workspace_id in (select workspace_id from switched_on);
    end loop;
    -- The switch leaves every lane's entry, on or off.
    update studio_control s
       set data = jsonb_set(s.data, '{lanes}', (
               select coalesce(jsonb_object_agg(e.key, e.value - 'requires_human_approval'),
                               '{}'::jsonb)
                 from jsonb_each(s.data->'lanes') e))
     where jsonb_typeof(s.data->'lanes') = 'object'
       and exists (select 1 from jsonb_each(s.data->'lanes') e
                    where e.value->'requires_human_approval' is not null);
    perform set_config('app.platform', previous_platform, true);
end $$;
