-- Inbox compliance, mailbox cursors and immutable acquisition provenance: 36 -> 48 tables.
-- Every tenant reference uses the tenant key. Global users retain their global FK.
select set_config('app.platform', 'on', true);

alter table capabilities add column if not exists iys_sealed bytea null;

create table if not exists consents (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key, person_id uuid not null,
    channel text not null,
    kind text not null check (kind in ('explicit','implied_by_contract','withdrawn')),
    source text not null check (source in ('form','agent','import','iys_sync','customer')),
    at timestamptz not null,
    sync_state text not null default 'pending' check (sync_state in ('pending','sent','failed','failed_final')),
    attempts bigint not null default 0 check (attempts between 0 and 4294967295),
    foreign key (person_id, workspace_id) references people (id, workspace_id)
);
create index if not exists consents_effective_idx on consents (workspace_id, person_id, channel, at desc, id desc);
create index if not exists consents_retry_idx on consents (workspace_id, at, id)
    where sync_state in ('pending','failed');

create table if not exists suppressions (
    workspace_id uuid not null references workspaces (id),
    person_id uuid not null, channel text not null,
    reason text not null check (reason in ('unsubscribe','bounce','complaint','manual')),
    primary key (workspace_id, person_id, channel, reason),
    foreign key (person_id, workspace_id) references people (id, workspace_id)
);

create table if not exists quotes (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key, journey_id uuid not null, amount_minor bigint not null,
    currency text not null, valid_until timestamptz not null, file_ref text,
    channel text not null, state text not null check (state in ('sent','accepted','expired')),
    created_at timestamptz not null,
    foreign key (journey_id, workspace_id) references journeys (id, workspace_id)
);
create index if not exists quotes_journey_idx on quotes (workspace_id, journey_id, created_at, id);

create table if not exists appointments (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key, journey_id uuid not null,
    starts_at timestamptz not null, ends_at timestamptz not null check (ends_at > starts_at),
    location text not null, state text not null check (state in ('booked','held','cancelled')),
    created_at timestamptz not null,
    foreign key (journey_id, workspace_id) references journeys (id, workspace_id)
);
create index if not exists appointments_journey_idx on appointments (workspace_id, journey_id, starts_at, id);

create table if not exists commissions (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key, journey_id uuid not null, payee uuid references users (id),
    amount_minor bigint not null, currency text not null,
    rate_bp integer not null check (rate_bp between 0 and 65535),
    state text not null check (state in ('no_payee','pending','approved','paid')),
    created_at timestamptz not null, unique (workspace_id, journey_id),
    foreign key (journey_id, workspace_id) references journeys (id, workspace_id)
);
create index if not exists commissions_queue_idx on commissions (workspace_id, state, payee, created_at, id);

create table if not exists erasure_log (
    workspace_id uuid not null references workspaces (id),
    person_id uuid not null, requested_via text not null, at timestamptz not null,
    primary key (workspace_id, person_id),
    foreign key (person_id, workspace_id) references people (id, workspace_id)
);
create table if not exists erased_identities (
    workspace_id uuid not null references workspaces (id),
    channel text not null, value_hash text not null check (value_hash ~ '^[0-9a-f]{64}$'),
    primary key (workspace_id, channel, value_hash)
);

create table if not exists outbound_jobs (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key, capability_id uuid not null, provider_job_id text, message_id uuid,
    state text not null check (state in ('queued','sent','delivered','failed','unknown','refused')),
    last_status jsonb, created_at timestamptz not null, updated_at timestamptz not null,
    unique (workspace_id, capability_id, provider_job_id),
    foreign key (capability_id, workspace_id) references capabilities (id, workspace_id),
    foreign key (message_id, workspace_id) references messages (id, workspace_id)
);
create index if not exists outbound_jobs_pending_idx on outbound_jobs (workspace_id, capability_id, created_at, id)
    where state in ('queued','sent') and provider_job_id is not null;

create table if not exists mail_cursors (
    workspace_id uuid not null references workspaces (id),
    capability_id uuid not null, mailbox text not null,
    uidvalidity bigint not null check (uidvalidity between 0 and 4294967295),
    last_uid bigint not null check (last_uid between 0 and 4294967295),
    primary key (workspace_id, capability_id, mailbox),
    foreign key (capability_id, workspace_id) references capabilities (id, workspace_id)
);
create table if not exists commission_default (
    workspace_id uuid primary key references workspaces (id),
    rate_bp integer not null check (rate_bp between 0 and 65535)
);
create table if not exists commission_user_rates (
    workspace_id uuid not null references workspaces (id),
    user_id uuid not null references users (id), rate_bp integer not null check (rate_bp between 0 and 65535),
    primary key (workspace_id, user_id)
);
create table if not exists journey_attribution (
    workspace_id uuid not null references workspaces (id),
    journey_id uuid primary key, provider text not null, ad_id text, adset_id text,
    campaign_id text, form_id text, leadgen_id text not null, acquired_at timestamptz not null,
    foreign key (journey_id, workspace_id) references journeys (id, workspace_id)
);
create index if not exists journey_attribution_ad_idx on journey_attribution (workspace_id, ad_id, acquired_at);
create or replace function journey_attribution_immutable() returns trigger language plpgsql as $$
begin
    raise exception 'journey_attribution is append-only';
end;
$$;
create or replace trigger journey_attribution_append_only before update or delete on journey_attribution
    for each row execute function journey_attribution_immutable();

-- No runtime event is removed on either upgrade or downgrade.
alter table inbound_events drop constraint if exists inbound_events_provider_check;
alter table inbound_events add constraint inbound_events_provider_check
    check (provider in ('meta','netgsm','x','mail'));

-- The erasure use case sets BOTH settings LOCAL and records its target before scrubbing.
-- This helper is invoker-security: tenant RLS remains in force even during erasure.
create or replace function inbox_erasure_matches(row_workspace uuid, row_person text) returns boolean
language sql stable as $$
    select coalesce(current_setting('jeeta.erasure', true) = 'on'
        and row_person = nullif(current_setting('jeeta.erasure_person_id', true), '')
        and exists (select 1 from erasure_log e
                    where e.workspace_id = row_workspace and e.person_id::text = row_person), false)
$$;

-- Exact recursive read mask; it preserves statistical/financial fields and JSON event tags.
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

-- Match stored adapter shapes against normalized identities BEFORE identities are deleted.
-- No substring searches through bodies: unrelated people's parsed content must survive.
create or replace function inbox_event_person(ws uuid, cap uuid, p jsonb, person uuid)
returns boolean language sql stable as $$
    select p->>'person_id' = person::text or exists (
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

create or replace function journey_events_immutable() returns trigger language plpgsql as $$
begin
    -- Procedural guards matter: PostgreSQL may reorder boolean terms, and unit event
    -- payloads are JSON strings (subtracting object keys from them is an error).
    if tg_op = 'UPDATE'
       and exists (select 1 from journeys j where j.id = old.journey_id
                   and j.workspace_id = old.workspace_id
                   and inbox_erasure_matches(j.workspace_id, j.person_id::text)) then
        -- Unit event kinds have no personal payload, but their label may still need removal.
        if new.payload is not distinct from old.payload
           and (to_jsonb(new) - 'reason_label') is not distinct from
               (to_jsonb(old) - 'reason_label') then
            return new;
        end if;
        if jsonb_typeof(new.payload) = 'object' and jsonb_typeof(old.payload) = 'object' then
            -- Financial/statistical identity, time, transition and idempotency remain intact.
            if (to_jsonb(new) - 'payload' - 'reason_label') is not distinct from
               (to_jsonb(old) - 'payload' - 'reason_label')
               and (new.payload - array['name','phone','email','body','text','product']::text[] #- '{won,product}')
                   is not distinct from
                   (old.payload - array['name','phone','email','body','text','product']::text[] #- '{won,product}') then
                return new;
            end if;
        end if;
    end if;
    raise exception 'journey_events is append-only';
end;
$$;

create or replace function inbound_events_guard() returns trigger language plpgsql as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'inbound_events rows are never deleted';
    end if;
    if inbox_erasure_matches(old.workspace_id, nullif(current_setting('jeeta.erasure_person_id', true), ''))
       and inbox_event_person(old.workspace_id, old.capability_id, old.payload,
            nullif(current_setting('jeeta.erasure_person_id', true), '')::uuid)
       and new.raw is null
       and (new.payload = inbox_mask_personal(old.payload) || jsonb_build_object('person_id', current_setting('jeeta.erasure_person_id', true))
            or (old.payload->>'person_id' = current_setting('jeeta.erasure_person_id', true)
                and new.payload - array['name','display_name','phone','email','body','text','from','to','recipient','subject','attachments','file_ref']::text[]
                    = old.payload - array['name','display_name','phone','email','body','text','from','to','recipient','subject','attachments','file_ref']::text[]))
       and (to_jsonb(new) - 'payload' - 'raw' - 'call_unique_id') is not distinct from
           (to_jsonb(old) - 'payload' - 'raw' - 'call_unique_id') then
        return new;
    end if;
    if (to_jsonb(new) - 'raw' - 'processed_at' - 'call_unique_id') is distinct from
       (to_jsonb(old) - 'raw' - 'processed_at' - 'call_unique_id') then
        raise exception 'inbound_events is append-only: only raw and processed_at may change';
    end if;
    if new.raw is not null and new.raw is distinct from old.raw then
        raise exception 'inbound_events.raw may only be removed';
    end if;
    return new;
end;
$$;

create or replace function probe_runs_immutable() returns trigger language plpgsql as $$
begin
    if inbox_erasure_matches(old.workspace_id, old.facts->>'person_id') then
        if tg_op = 'DELETE' then return old; end if;
        if new.facts->>'person_id' = old.facts->>'person_id'
           and (to_jsonb(new) - 'facts') is not distinct from (to_jsonb(old) - 'facts') then
            return new;
        end if;
    end if;
    if tg_op = 'DELETE' and old.at < now() - interval '30 days' then return old; end if;
    raise exception 'probe_runs is append-only: a run is never changed, and deleted only once older than 30 days';
end;
$$;

-- Explicit declarations keep tenant isolation auditable by the architecture scanner.
-- Each policy remains idempotent, with ENABLE/FORCE and identical tenant/platform semantics.

alter table consents enable row level security;
alter table consents force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema()
                   and tablename = 'consents' and policyname = 'consents_ws') then
        create policy consents_ws on consents
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table suppressions enable row level security;
alter table suppressions force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema()
                   and tablename = 'suppressions' and policyname = 'suppressions_ws') then
        create policy suppressions_ws on suppressions
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table quotes enable row level security;
alter table quotes force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema()
                   and tablename = 'quotes' and policyname = 'quotes_ws') then
        create policy quotes_ws on quotes
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table appointments enable row level security;
alter table appointments force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema()
                   and tablename = 'appointments' and policyname = 'appointments_ws') then
        create policy appointments_ws on appointments
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table commissions enable row level security;
alter table commissions force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema()
                   and tablename = 'commissions' and policyname = 'commissions_ws') then
        create policy commissions_ws on commissions
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table erasure_log enable row level security;
alter table erasure_log force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema()
                   and tablename = 'erasure_log' and policyname = 'erasure_log_ws') then
        create policy erasure_log_ws on erasure_log
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table erased_identities enable row level security;
alter table erased_identities force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema()
                   and tablename = 'erased_identities' and policyname = 'erased_identities_ws') then
        create policy erased_identities_ws on erased_identities
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table outbound_jobs enable row level security;
alter table outbound_jobs force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema()
                   and tablename = 'outbound_jobs' and policyname = 'outbound_jobs_ws') then
        create policy outbound_jobs_ws on outbound_jobs
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table mail_cursors enable row level security;
alter table mail_cursors force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema()
                   and tablename = 'mail_cursors' and policyname = 'mail_cursors_ws') then
        create policy mail_cursors_ws on mail_cursors
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table commission_default enable row level security;
alter table commission_default force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema()
                   and tablename = 'commission_default' and policyname = 'commission_default_ws') then
        create policy commission_default_ws on commission_default
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table commission_user_rates enable row level security;
alter table commission_user_rates force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema()
                   and tablename = 'commission_user_rates' and policyname = 'commission_user_rates_ws') then
        create policy commission_user_rates_ws on commission_user_rates
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table journey_attribution enable row level security;
alter table journey_attribution force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema()
                   and tablename = 'journey_attribution' and policyname = 'journey_attribution_ws') then
        create policy journey_attribution_ws on journey_attribution
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;
