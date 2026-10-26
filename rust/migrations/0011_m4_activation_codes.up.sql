-- No plaintext or recipient binding: current owners redeem a keyed challenge.
create table if not exists activation_codes (
    id uuid primary key,
    workspace_id uuid not null references workspaces(id),
    entitlement_id uuid not null,
    action text not null check (action='billing.activate'),
    digest bytea not null check (octet_length(digest)=32),
    issued_by uuid not null references platform_operators(id),
    created_at timestamptz not null,
    expires_at timestamptz not null check (expires_at > created_at),
    attempts integer not null default 0 check (attempts between 0 and 5),
    invalidated_at timestamptz,
    consumed_at timestamptz,
    redeemed_by uuid references users(id),
    unique(workspace_id,id),
    foreign key (workspace_id,entitlement_id) references workspace_entitlements(workspace_id,id),
    check ((consumed_at is null) = (redeemed_by is null))
);
create unique index if not exists activation_codes_one_current on activation_codes(workspace_id)
    where invalidated_at is null and consumed_at is null;
alter table activation_codes enable row level security;
alter table activation_codes force row level security;
do $$ begin
    if not exists (select 1 from pg_policies where schemaname='public' and tablename='activation_codes' and policyname='activation_codes_ws') then
        create policy activation_codes_ws on activation_codes
        using (workspace_id = nullif(current_setting('app.workspace_id', true),'')::uuid or current_setting('app.platform',true)='on')
        with check (workspace_id = nullif(current_setting('app.workspace_id', true),'')::uuid or current_setting('app.platform',true)='on');
    end if;
end $$;
