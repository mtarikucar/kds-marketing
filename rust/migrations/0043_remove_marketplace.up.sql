-- The marketplace module leaves the product (owner decision, 2026-11-12): no Trendyol or
-- Hepsiburada store is connected and no customer question is taken, so the values
-- 0019_inbox_public allowed for them go from every CHECK that listed them, and the erasure
-- matching of 0025_inbox_public_erasure loses its two marketplace namespaces:
--
--   inbound_events.provider    back to 0018_tiktok_webhooks' list (no 'trendyol', 'hepsiburada');
--   public_items.kind          'comment' only (no 'question');
--   public_items.moderation    no 'reported' (only a marketplace took reports);
--   public_subjects.kind       'post' only (no 'product').
--
-- Comments are untouched: their tables, indexes, policies, answer states and the outbox's `held`
-- state stay as they are. Nothing is deleted. The migration is refused, before anything changes,
-- while a row still holds one of those values, or one the server can no longer read (a
-- capability of kind `trendyol` or `hepsiburada`, an identity in a buyer namespace, a first
-- touch, consent, suppression or quote on a question channel): no marketplace adapter ever ran,
-- so none is expected, and one that is there is a person's decision, not this file's. The tables
-- whose checks narrow, and the capabilities and identities, are locked while they are checked,
-- so no such row is written between the check and the change. Repeatable: every statement is
-- guarded.
do $$ declare previous text; begin
    previous := current_setting('app.platform', true);
    perform set_config('app.platform', 'on', true);
    lock table inbound_events in share row exclusive mode;
    lock table public_items in share row exclusive mode;
    lock table public_subjects in share row exclusive mode;
    lock table capabilities in share row exclusive mode;
    lock table identities in share row exclusive mode;
    if exists (select 1 from inbound_events where provider in ('trendyol', 'hepsiburada')) then
        raise exception 'marketplace removal refused: inbound_events holds marketplace events, which are never deleted';
    end if;
    if exists (select 1 from capabilities where kind_key in ('trendyol', 'hepsiburada')) then
        raise exception 'marketplace removal refused: capabilities holds a trendyol or hepsiburada capability';
    end if;
    if exists (select 1 from public_items where kind = 'question' or moderation = 'reported') then
        raise exception 'marketplace removal refused: public_items holds a question or a reported item';
    end if;
    if exists (select 1 from public_subjects where kind = 'product') then
        raise exception 'marketplace removal refused: public_subjects holds a product';
    end if;
    if exists (select 1 from identities where channel in ('trendyol_buyer', 'hepsiburada_buyer')) then
        raise exception 'marketplace removal refused: identities holds a marketplace buyer';
    end if;
    if exists (select 1 from people
               where first_touch#>>'{source,channel}' in ('trendyol_question', 'hepsiburada_question'))
       or exists (select 1 from consents where channel in ('trendyol_question', 'hepsiburada_question'))
       or exists (select 1 from suppressions where channel in ('trendyol_question', 'hepsiburada_question'))
       or exists (select 1 from quotes where channel in ('trendyol_question', 'hepsiburada_question')) then
        raise exception 'marketplace removal refused: a person, consent, suppression or quote is on a marketplace question channel';
    end if;
    alter table inbound_events drop constraint if exists inbound_events_provider_check;
    alter table inbound_events add constraint inbound_events_provider_check
        check (provider in ('meta', 'netgsm', 'x', 'mail', 'tiktok'));
    alter table public_items drop constraint if exists public_items_kind_check;
    alter table public_items add constraint public_items_kind_check
        check (kind in ('comment'));
    alter table public_items drop constraint if exists public_items_moderation_check;
    alter table public_items add constraint public_items_moderation_check
        check (moderation in ('visible','hidden','deleted','removed'));
    alter table public_subjects drop constraint if exists public_subjects_kind_check;
    alter table public_subjects add constraint public_subjects_kind_check
        check (kind in ('post'));
    perform set_config('app.platform', coalesce(previous, ''), true);
end $$;

-- 0025's matching without the marketplace buyers: a public item's author is matched in the
-- namespace of a comment's surface only, and an author without an id is the one-off person of
-- its comment (`c:<comment id>`). `inbox_mask_personal` stays 0025's: what it blanks is a
-- superset, and stored events keep being masked as they were.
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
                case p#>>'{public,kind}' when 'comment' then 'c:' end
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
