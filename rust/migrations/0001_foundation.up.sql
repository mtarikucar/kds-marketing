-- Foundation: workspaces, users, sessions, roles, memberships, API keys, agent connections, the
-- append-only ledger and platform operators, with row-level tenant isolation.
--
-- Tenant tables carry `workspace_id` and are visible only when the transaction-local setting
-- `app.workspace_id` names their workspace, or `app.platform` is 'on' (platform and trusted
-- internal paths). RLS is forced, so it binds the table owner too; it does not bind superusers or
-- roles with BYPASSRLS, so the application must connect as an ordinary role.
--
-- Every statement is idempotent: running this file twice leaves the same schema.

create table if not exists workspaces (
    id uuid primary key,
    name text not null,
    slug text not null unique,
    status text not null check (status in ('pending_payment', 'active', 'suspended')),
    created_at timestamptz not null default now()
);

create table if not exists users (
    id uuid primary key,
    email text not null,
    password_hash text not null,
    display_name text not null,
    created_at timestamptz not null default now()
);
create unique index if not exists users_email_lower_idx on users (lower(email));

create table if not exists sessions (
    id uuid primary key,
    user_id uuid not null references users (id) on delete cascade,
    token_hash text not null unique,
    current_workspace_id uuid references workspaces (id) on delete set null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    revoked_at timestamptz
);

create table if not exists roles (
    id uuid primary key,
    workspace_id uuid not null references workspaces (id) on delete cascade,
    key text not null,
    name text not null,
    permissions text[] not null,
    is_system boolean not null default false,
    unique (workspace_id, key)
);

create table if not exists memberships (
    id uuid primary key,
    workspace_id uuid not null references workspaces (id) on delete cascade,
    user_id uuid references users (id) on delete cascade,
    role_id uuid not null references roles (id),
    status text not null check (status in ('invited', 'active', 'removed')),
    invited_email text,
    invite_token_hash text unique,
    invite_expires_at timestamptz,
    invited_by uuid references users (id),
    created_at timestamptz not null default now()
);
create unique index if not exists memberships_workspace_user_live_idx
    on memberships (workspace_id, user_id)
    where user_id is not null and status <> 'removed';

create table if not exists api_keys (
    id uuid primary key,
    workspace_id uuid not null references workspaces (id) on delete cascade,
    name text not null,
    prefix text not null,
    key_hash text not null unique,
    scopes text[] not null,
    issued_by uuid not null references users (id),
    status text not null check (status in ('active', 'revoked')),
    created_at timestamptz not null default now(),
    last_used_at timestamptz,
    revoked_at timestamptz
);

create table if not exists agent_connections (
    id uuid primary key,
    workspace_id uuid not null references workspaces (id) on delete cascade,
    api_key_id uuid not null references api_keys (id) on delete cascade,
    client_name text not null,
    client_version text not null default '',
    protocol_version text not null default '',
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    tool_calls bigint not null default 0,
    unique (api_key_id, client_name, client_version)
);

create table if not exists ledger_entries (
    id bigint generated always as identity primary key,
    workspace_id uuid not null references workspaces (id) on delete cascade,
    at timestamptz not null,
    actor_kind text not null check (actor_kind in ('human', 'agent', 'system')),
    actor_user_id uuid,
    agent_connection_id uuid,
    actor_component text,
    action text not null,
    subject_kind text,
    subject_id text,
    payload jsonb not null default '{}'::jsonb,
    strategy_version_id uuid
);
create index if not exists ledger_entries_workspace_at_idx on ledger_entries (workspace_id, at desc);

create or replace function ledger_entries_immutable() returns trigger
language plpgsql as $$
begin
    raise exception 'ledger_entries is append-only';
end;
$$;

create or replace trigger ledger_entries_append_only
    before update or delete on ledger_entries
    for each row execute function ledger_entries_immutable();

create table if not exists platform_operators (
    id uuid primary key,
    email text not null,
    password_hash text not null,
    created_at timestamptz not null default now()
);
create unique index if not exists platform_operators_email_lower_idx on platform_operators (lower(email));

create table if not exists platform_sessions (
    id uuid primary key,
    operator_id uuid not null references platform_operators (id) on delete cascade,
    token_hash text not null unique,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null
);

-- Row-level security. `create policy` has no `if not exists`, hence the guards.

alter table roles enable row level security;
alter table roles force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'roles' and policyname = 'roles_ws') then
        create policy roles_ws on roles
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table memberships enable row level security;
alter table memberships force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'memberships' and policyname = 'memberships_ws') then
        create policy memberships_ws on memberships
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table api_keys enable row level security;
alter table api_keys force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'api_keys' and policyname = 'api_keys_ws') then
        create policy api_keys_ws on api_keys
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table agent_connections enable row level security;
alter table agent_connections force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'agent_connections' and policyname = 'agent_connections_ws') then
        create policy agent_connections_ws on agent_connections
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table ledger_entries enable row level security;
alter table ledger_entries force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'ledger_entries' and policyname = 'ledger_entries_ws') then
        create policy ledger_entries_ws on ledger_entries
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

-- A tenant transaction sees only its own workspace row.
alter table workspaces enable row level security;
alter table workspaces force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'workspaces' and policyname = 'workspaces_ws') then
        create policy workspaces_ws on workspaces
            using (id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;
