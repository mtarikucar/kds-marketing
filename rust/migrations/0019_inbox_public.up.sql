-- Public items (spec 2026-10-30-inbox-comments-marketplace-design.md §4): the comments and
-- marketplace questions the inbox answers, the posts and products they are about, and the poll
-- cursors of the surfaces it polls; replies held for a human's approval; the marketplace
-- providers' inbound events; the erasure mask and event matching for the public-item envelope.
-- 74 -> 77 tables. Repeatable: every statement is guarded.
select set_config('app.platform', 'on', true);

-- Marketplace questions are inbound events of their own providers, beside 0018_tiktok_webhooks'.
alter table inbound_events drop constraint if exists inbound_events_provider_check;
alter table inbound_events add constraint inbound_events_provider_check
    check (provider in ('meta', 'netgsm', 'x', 'mail', 'tiktok', 'trendyol', 'hepsiburada'));

-- An item's conversation and subject are on its own capability: the composite keys the items'
-- foreign keys name.
do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'conversations_id_capability_key'
                   and conrelid = 'conversations'::regclass) then
        alter table conversations add constraint conversations_id_capability_key
            unique (id, workspace_id, capability_id);
    end if;
end;
$$;

-- A post or product items are about: the business's own content, never a person's. The Studio
-- publication that made the post, when one did.
create table if not exists public_subjects (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key,
    capability_id uuid not null,
    kind text not null check (kind in ('post','product')),
    external_id text not null check (char_length(external_id) between 1 and 512),
    title text not null default '' check (char_length(title) <= 280),
    url text check (url is null or char_length(url) <= 2048),
    image_url text check (image_url is null or char_length(image_url) <= 4096),
    facts jsonb not null default '{}' check (jsonb_typeof(facts) = 'object'),
    publication_id uuid,
    first_seen_at timestamptz not null, updated_at timestamptz not null,
    unique (id, workspace_id, capability_id),
    unique (workspace_id, capability_id, external_id),
    foreign key (capability_id, workspace_id) references capabilities (id, workspace_id),
    foreign key (workspace_id, publication_id) references studio_publications (workspace_id, id)
);

-- One comment or question: ids, states and times only, no personal text (the text is the
-- inbound message's). The answer is `jt_inbox::AnswerState` as JSON; `answer_state` is derived
-- from its tag for the indexes and is never written. `live`: a live video's comment, which takes
-- no public reply. `agent_answers`: the agent's public answers the platform received (it may give
-- a second one after a refused first). Its conversation and its subject are on its capability.
create table if not exists public_items (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key,
    capability_id uuid not null, conversation_id uuid not null, message_id uuid not null,
    subject_id uuid,
    kind text not null check (kind in ('comment','question')),
    external_id text not null check (char_length(external_id) between 1 and 512),
    parent_external_id text, root_external_id text not null,
    created_at timestamptz not null, deadline timestamptz, private_reply_until timestamptz,
    live boolean not null default false,
    answer jsonb not null check (jsonb_typeof(answer) = 'object' and answer ? 'state'),
    answer_state text generated always as (answer->>'state') stored
        check (answer_state in ('awaiting','pending','answered','rejected','handled','expired')),
    moderation text not null default 'visible'
        check (moderation in ('visible','hidden','deleted','removed','reported')),
    private_reply_message_id uuid,
    agent_answers smallint not null default 0 check (agent_answers between 0 and 255),
    checked_at timestamptz, updated_at timestamptz not null,
    unique (id, workspace_id),
    unique (workspace_id, capability_id, external_id),
    foreign key (capability_id, workspace_id) references capabilities (id, workspace_id),
    foreign key (conversation_id, workspace_id, capability_id)
        references conversations (id, workspace_id, capability_id),
    foreign key (message_id, workspace_id) references messages (id, workspace_id),
    foreign key (subject_id, workspace_id, capability_id)
        references public_subjects (id, workspace_id, capability_id),
    foreign key (private_reply_message_id, workspace_id) references messages (id, workspace_id)
);
-- Owed items of a conversation (state derivation, context).
create index if not exists public_items_owed on public_items (workspace_id, conversation_id)
    where answer_state in ('awaiting','rejected') and moderation = 'visible';
-- Deadlines (SLA job, work items).
create index if not exists public_items_deadline on public_items (workspace_id, deadline)
    where deadline is not null and answer_state in ('awaiting','rejected','pending');
-- Threads.
create index if not exists public_items_thread
    on public_items (workspace_id, capability_id, root_external_id, created_at);
-- Reconciliation, least recently checked first (rotation, never pinned to the oldest N).
create index if not exists public_items_reconcile
    on public_items (workspace_id, capability_id, checked_at nulls first, id)
    where answer_state in ('awaiting','rejected','pending');
-- A conversation's items in order (context, merges).
create index if not exists public_items_conversation
    on public_items (workspace_id, conversation_id, created_at, id);
-- The item a message is (a message list's marks).
create index if not exists public_items_message on public_items (workspace_id, message_id);

-- Where a polled surface's next poll starts, one per capability.
create table if not exists public_cursors (
    workspace_id uuid not null references workspaces (id),
    capability_id uuid not null,
    cursor jsonb not null check (jsonb_typeof(cursor) = 'object'),
    updated_at timestamptz not null,
    primary key (workspace_id, capability_id),
    foreign key (capability_id, workspace_id) references capabilities (id, workspace_id)
);

-- Held replies wait for a human's approval; nothing claims them.
alter table outbox drop constraint if exists outbox_state_check;
alter table outbox add constraint outbox_state_check
    check (state in ('queued','sending','sent','failed','unknown','refused','held'));

-- 0008's mask, which also blanks the public-item envelope's author and the provider's own copy
-- of the item (`author`, `provider_item`), the commenters' and buyers' names (`username`,
-- `userName`, `customerName`) and a string-valued `message` (Facebook's comment text); an object
-- `message` (WhatsApp's) is recursed into as before.
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
                'raw','row','recording','crm_id','internal_num','destination',
                'author','provider_item','username','userName','customerName'])
                or (k = 'message' and jsonb_typeof(item) = 'string') then
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

-- 0008's matching, which also matches a public-item envelope's author against the namespace of
-- its kind and capability (a comment on an Instagram or a Facebook Page capability, or on the DM
-- sibling a webhook was routed to; a question on a marketplace), scoped by the capability's
-- external id like every opaque identity. An author without an id is the one-off person intake
-- made: `c:<comment id>` or `q:<question id>`; an empty author id is no id.
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

-- Explicit declarations keep tenant isolation auditable by the architecture scanner.

alter table public_subjects enable row level security;
alter table public_subjects force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema()
                   and tablename = 'public_subjects' and policyname = 'public_subjects_ws') then
        create policy public_subjects_ws on public_subjects
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table public_items enable row level security;
alter table public_items force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema()
                   and tablename = 'public_items' and policyname = 'public_items_ws') then
        create policy public_items_ws on public_items
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table public_cursors enable row level security;
alter table public_cursors force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema()
                   and tablename = 'public_cursors' and policyname = 'public_cursors_ws') then
        create policy public_cursors_ws on public_cursors
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;
