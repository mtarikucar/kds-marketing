-- Reverts 0019_inbox_public: narrows the outbox state and inbound-event provider checks back,
-- restores 0008's erasure mask and event matching, and drops the public items, their subjects
-- and the poll cursors. Refused, before anything changes, while a row needs the wider checks:
-- inbound events are never deleted (the append-only guard of 0005_connectors), so a stored
-- Trendyol or Hepsiburada event keeps this migration; a reply held for approval must be approved
-- or discarded first. The two tables are locked while they are checked, so no such row is
-- written between the check and the change. TikTok's provider stays (0018_tiktok_webhooks owns
-- it; this migration only carries it). A no-op when already reverted.
do $$ declare previous text; begin
    previous := current_setting('app.platform', true);
    perform set_config('app.platform', 'on', true);
    lock table inbound_events in share row exclusive mode;
    lock table outbox in share row exclusive mode;
    if exists (select 1 from inbound_events where provider in ('trendyol', 'hepsiburada')) then
        raise exception 'inbox public rollback refused: inbound_events holds marketplace events, which are never deleted';
    end if;
    if exists (select 1 from outbox where state = 'held') then
        raise exception 'inbox public rollback refused: outbox holds replies held for approval; approve or discard them first';
    end if;
    alter table outbox drop constraint if exists outbox_state_check;
    alter table outbox add constraint outbox_state_check
        check (state in ('queued','sending','sent','failed','unknown','refused'));
    alter table inbound_events drop constraint if exists inbound_events_provider_check;
    alter table inbound_events add constraint inbound_events_provider_check
        check (provider in ('meta','netgsm','x','mail','tiktok'));
    perform set_config('app.platform', coalesce(previous, ''), true);
end $$;

-- 0008's bodies.
create or replace function inbox_mask_personal(v jsonb) returns jsonb language plpgsql immutable as $$
declare result jsonb; k text; item jsonb;
begin
    if jsonb_typeof(v) = 'object' then
        result := '{}'::jsonb;
        for k, item in select key, value from jsonb_each(v) loop
            if (k = 'source' and v->>'scenario' = 'cdr') or k = any(array['name','display_name','company','phone','email','body','text','product',
                'from','to','recipient','sender','contact','subject','attachments','file_ref','location',
                'customer_num','customer_name','recipient_id','wa_id','note','title','address','field_data',
                'image','audio','video','document','sticker','contacts','url','link',
                'raw','row','recording','crm_id','internal_num','destination']) then
                result := result || jsonb_build_object(k, '');
            else result := result || jsonb_build_object(k, inbox_mask_personal(item)); end if;
        end loop;
        return result;
    elsif jsonb_typeof(v) = 'array' then
        select coalesce(jsonb_agg(inbox_mask_personal(value)), '[]'::jsonb) into result from jsonb_array_elements(v);
        return result;
    end if;
    return v;
end;
$$;

create or replace function inbox_event_person(ws uuid, cap uuid, p jsonb, person uuid)
returns boolean language sql stable as $$
    select p->>'person_id' = person::text or exists (
        select 1 from messages m
        join conversations c on c.workspace_id=m.workspace_id and c.id=m.conversation_id
        join capabilities k on k.workspace_id=c.workspace_id and k.id=c.capability_id
        where m.workspace_id=ws and c.person_id=person and c.capability_id=cap
          and k.kind_key='mailbox' and m.direction='outbound' and m.external_id=p->>'message_id'
    ) or exists (
        select 1 from outbox o
        join conversations c on c.workspace_id=o.workspace_id and c.id=o.conversation_id
        join capabilities k on k.workspace_id=o.workspace_id and k.id=o.capability_id
        where o.workspace_id=ws and c.person_id=person and o.capability_id=cap
          and k.kind_key='mailbox' and o.intent#>>'{mail,message_id}'=p->>'message_id'
    ) or exists (
        select 1 from identities i
        left join capabilities c on c.workspace_id = i.workspace_id and c.id = cap
        cross join lateral (select case c.kind_key
            when 'mailbox' then 'email' when 'sms_line' then 'phone' when 'netgsm_pbx' then 'phone'
            when 'whatsapp_cloud' then 'phone' when 'messenger' then 'messenger'
            when 'facebook_page' then 'messenger' when 'instagram' then 'instagram_dm'
            when 'instagram_dm' then 'instagram_dm' end channel) namespace
        cross join lateral (values
            (p->>'from', namespace.channel), (p->>'to', namespace.channel),
            (p->>'recipient', case p->>'channel' when 'EPOSTA' then 'email'
                when 'MESAJ' then 'phone' when 'ARAMA' then 'phone' else namespace.channel end),
            (p->>'customer_num', 'phone'),
            (case when p->>'scenario'='cdr' then p->>'source' end, 'phone'),
            (case when p->>'scenario'='cdr' then p->>'destination' end, 'phone'),
            (p->>'email', 'email'), (p->>'phone', 'phone'), (p#>>'{message,from}', 'phone'),
            (p#>>'{messaging,sender,id}', namespace.channel),
            (p#>>'{messaging,recipient,id}', namespace.channel),
            (p#>>'{sender,id}', namespace.channel), (p#>>'{recipient,id}', namespace.channel),
            (p#>>'{status,recipient_id}', 'phone')
        ) candidates(candidate, channel)
        cross join lateral (select regexp_replace(candidate, '[^0-9]', '', 'g') digits) d
        where i.workspace_id = ws and i.person_id = person and candidate is not null
        and i.channel = candidates.channel
        and case when i.channel = 'email' then exists (
            -- To/From may be an RFC mailbox list, including display names and angle addresses.
            select 1 from regexp_matches(candidate, '[^[:space:]<>,;:"]+@[^[:space:]<>,;:"]+', 'g') address
            where i.value_normalized = lower(address[1])
        ) else i.value_normalized = case i.channel
            when 'phone' then '+' || case when btrim(candidate) not like '+%' and length(digits)=11
                and digits like '0%' then '90' || substr(digits,2) else digits end
            else c.external_id || ':' || btrim(candidate) end end
    )
$$;

drop table if exists public_items;
drop table if exists public_cursors;
drop table if exists public_subjects;
