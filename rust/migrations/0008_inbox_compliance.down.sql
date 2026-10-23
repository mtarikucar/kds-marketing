-- Restore guards before dropping their erasure authorization data. No ledger guard changed.
select set_config('app.platform', 'on', true);
alter table capabilities drop column if exists iys_sealed;
create or replace function journey_events_immutable() returns trigger language plpgsql as $$
begin
    raise exception 'journey_events is append-only';
end;
$$;
create or replace function inbound_events_guard() returns trigger
language plpgsql as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'inbound_events rows are never deleted';
    end if;
    -- call_unique_id is generated exclusively from frozen columns by PostgreSQL after
    -- this BEFORE guard. Exclude only that derived value; all source columns stay frozen.
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

create or replace function probe_runs_immutable() returns trigger
language plpgsql as $$
begin
    -- Past its 30-day retention a run may be deleted (the daily purge); nothing else changes.
    if tg_op = 'DELETE' and old.at < now() - interval '30 days' then
        return old;
    end if;
    raise exception 'probe_runs is append-only: a run is never changed, and deleted only once older than 30 days';
end;
$$;


-- Mail runtime rows survive rollback. Keep the widened constraint when any remain.
do $$
begin
    if not exists (select 1 from inbound_events where provider = 'mail') then
        alter table inbound_events drop constraint if exists inbound_events_provider_check;
        alter table inbound_events add constraint inbound_events_provider_check
            check (provider in ('meta','netgsm','x'));
    end if;
end;
$$;
drop function if exists inbox_erasure_matches(uuid, text);
drop table if exists journey_attribution;
drop function if exists journey_attribution_immutable();
drop table if exists commission_user_rates;
drop table if exists commission_default;
drop table if exists mail_cursors;
drop table if exists outbound_jobs;
drop table if exists erased_identities;
drop table if exists erasure_log;
drop table if exists commissions;
drop table if exists appointments;
drop table if exists quotes;
drop table if exists suppressions;
drop table if exists consents;
