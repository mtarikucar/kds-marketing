-- Recreates the three commission tables exactly as `0008_inbox_compliance` defined them, empty:
-- the rows the up deleted are not restored. Repeating this is a no-op, and it never touches any
-- other table.
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
create table if not exists commission_default (
    workspace_id uuid primary key references workspaces (id),
    rate_bp integer not null check (rate_bp between 0 and 65535)
);
create table if not exists commission_user_rates (
    workspace_id uuid not null references workspaces (id),
    user_id uuid not null references users (id), rate_bp integer not null check (rate_bp between 0 and 65535),
    primary key (workspace_id, user_id)
);

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
