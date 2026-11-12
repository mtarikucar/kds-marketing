-- Reverts 0043_remove_marketplace: puts back the schema of 0042, exactly. The four checks take
-- the values 0019_inbox_public gave them again (the `trendyol` and `hepsiburada` providers, a
-- `question` item, a `reported` one, a `product` subject) and `inbox_event_person` is
-- 0025_inbox_public_erasure's again, with the two buyer namespaces. Widening needs no row
-- checked and nothing is deleted. Repeatable: every statement is guarded.
alter table inbound_events drop constraint if exists inbound_events_provider_check;
alter table inbound_events add constraint inbound_events_provider_check
    check (provider in ('meta', 'netgsm', 'x', 'mail', 'tiktok', 'trendyol', 'hepsiburada'));
alter table public_items drop constraint if exists public_items_kind_check;
alter table public_items add constraint public_items_kind_check
    check (kind in ('comment','question'));
alter table public_items drop constraint if exists public_items_moderation_check;
alter table public_items add constraint public_items_moderation_check
    check (moderation in ('visible','hidden','deleted','removed','reported'));
alter table public_subjects drop constraint if exists public_subjects_kind_check;
alter table public_subjects add constraint public_subjects_kind_check
    check (kind in ('post','product'));

-- 0025's body.
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
        cross join lateral (select case
            when p#>>'{public,kind}' = 'comment' and c.kind_key in ('instagram','instagram_dm')
                then 'instagram_commenter'
            when p#>>'{public,kind}' = 'comment' and c.kind_key in ('facebook_page','messenger')
                then 'facebook_commenter'
            when p#>>'{public,kind}' = 'question' and c.kind_key = 'trendyol' then 'trendyol_buyer'
            when p#>>'{public,kind}' = 'question' and c.kind_key = 'hepsiburada' then 'hepsiburada_buyer'
            end channel) public_namespace
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
            (p#>>'{status,recipient_id}', 'phone'),
            -- A number onboarded beside the WhatsApp Business app (0024): its shared history (the
            -- thread is the customer's number), what the business wrote from the app, and the
            -- app's contacts.
            (p->>'thread', 'phone'), (p#>>'{history_message,from}', 'phone'),
            (p#>>'{history_message,to}', 'phone'), (p#>>'{echo,to}', 'phone'),
            (p#>>'{state_sync,contact,phone_number}', 'phone'),
            -- A public item's author (0019).
            (coalesce(nullif(p#>>'{public,author,id}', ''),
                case p#>>'{public,kind}' when 'comment' then 'c:' when 'question' then 'q:' end
                    || (p#>>'{public,external_id}')), public_namespace.channel)
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
