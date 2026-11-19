-- An agent's wake address and its outbox (design: a person's request wakes the agent at once,
-- `usecases::wake`): one row per API key at most, created when the key's agent first checks in
-- after this release or when a person sets an address. Additive: a new table only, nothing an
-- existing row holds is read or changed, so it is safe on a live database. Repeatable: every
-- statement is guarded.
--
-- `data` is the row as the application keeps it (address, pending wake, recent fires, last
-- outcome, recent check-ins); `sealed` the address's token or secret, sealed for the workspace
-- (never in `data`, never read but by the job that sends the wake); `due_at` when the pending
-- wake goes out, kept beside the document so the job finds the workspaces with one due without
-- opening each.
create table if not exists agent_wakes (
    workspace_id uuid not null references workspaces (id) on delete cascade,
    api_key_id uuid not null references api_keys (id) on delete cascade,
    data jsonb not null,
    sealed bytea,
    due_at timestamptz,
    primary key (workspace_id, api_key_id)
);

create index if not exists agent_wakes_due on agent_wakes (due_at) where due_at is not null;

alter table agent_wakes enable row level security;
alter table agent_wakes force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'agent_wakes' and policyname = 'agent_wakes_ws') then
        create policy agent_wakes_ws on agent_wakes
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;
