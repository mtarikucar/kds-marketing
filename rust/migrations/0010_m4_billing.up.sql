-- M4 durable evidence and permanent entitlement history. No billing secrets in projections.
create table if not exists payment_notifications (
    id uuid primary key,
    workspace_id uuid not null references workspaces(id),
    reported_by uuid not null references users(id),
    reference_sealed bytea not null,
    request_key text not null,
    amount_minor bigint not null check (amount_minor > 0),
    currency text not null check (currency ~ '^[A-Z]{3}$'),
    paid_at timestamptz not null,
    reported_at timestamptz not null,
    unique (workspace_id,id),
    unique (workspace_id,request_key)
);
create table if not exists workspace_entitlements (
    id uuid primary key,
    workspace_id uuid not null references workspaces(id),
    source text not null check (source in ('paid','grandfathered')),
    payment_id uuid,
    confirmed_by uuid references platform_operators(id),
    confirmed_at timestamptz not null,
    activated_at timestamptz,
    redeemed_by uuid references users(id),
    revoked_at timestamptz,
    reason text,
    unique (workspace_id,id),
    foreign key (workspace_id,payment_id) references payment_notifications(workspace_id,id),
    check ((source='paid' and payment_id is not null and confirmed_by is not null)
        or (source='grandfathered' and payment_id is null and confirmed_by is null)),
    check ((revoked_at is null and reason is null) or (revoked_at is not null and length(btrim(reason)) > 0 and reason is not null)),
    check ((activated_at is null and redeemed_by is null) or
           (activated_at is not null and (source='grandfathered' or redeemed_by is not null)))
);
create unique index if not exists workspace_entitlements_one_open on workspace_entitlements(workspace_id) where revoked_at is null;
create table if not exists workspace_billing (
    workspace_id uuid primary key references workspaces(id),
    reference text not null unique check (reference ~ '^JEETA-[0-9A-F]{8}-[0-9]{6}$')
);
-- This manifest is migration-owned, never an application repository. Full row images let the
-- data down remove only unchanged seed rows; the watermark protects later runtime history.
create table if not exists m4_grandfathered_manifest (
    entitlement_id uuid primary key,
    seed_workspace_id uuid not null references workspaces(id),
    original_row jsonb not null,
    ledger_watermark bigint not null
);
alter table m4_grandfathered_manifest enable row level security;
alter table m4_grandfathered_manifest force row level security;
do $$ begin
    if not exists (select 1 from pg_policies where tablename='m4_grandfathered_manifest' and policyname='m4_manifest_platform') then
        create policy m4_manifest_platform on m4_grandfathered_manifest
            using (current_setting('app.platform',true)='on')
            with check (current_setting('app.platform',true)='on');
    end if;
end $$;
alter table payment_notifications enable row level security;
alter table payment_notifications force row level security;
do $$ begin
    if not exists (select 1 from pg_policies where schemaname='public' and tablename='payment_notifications' and policyname='payment_notifications_ws') then
        create policy payment_notifications_ws on payment_notifications
        using (workspace_id = nullif(current_setting('app.workspace_id', true),'')::uuid or current_setting('app.platform',true)='on')
        with check (workspace_id = nullif(current_setting('app.workspace_id', true),'')::uuid or current_setting('app.platform',true)='on');
    end if;
end $$;
alter table workspace_entitlements enable row level security;
alter table workspace_entitlements force row level security;
do $$ begin
    if not exists (select 1 from pg_policies where schemaname='public' and tablename='workspace_entitlements' and policyname='workspace_entitlements_ws') then
        create policy workspace_entitlements_ws on workspace_entitlements
        using (workspace_id = nullif(current_setting('app.workspace_id', true),'')::uuid or current_setting('app.platform',true)='on')
        with check (workspace_id = nullif(current_setting('app.workspace_id', true),'')::uuid or current_setting('app.platform',true)='on');
    end if;
end $$;
alter table workspace_billing enable row level security;
alter table workspace_billing force row level security;
do $$ begin
    if not exists (select 1 from pg_policies where schemaname='public' and tablename='workspace_billing' and policyname='workspace_billing_ws') then
        create policy workspace_billing_ws on workspace_billing
        using (workspace_id = nullif(current_setting('app.workspace_id', true),'')::uuid or current_setting('app.platform',true)='on')
        with check (workspace_id = nullif(current_setting('app.workspace_id', true),'')::uuid or current_setting('app.platform',true)='on');
    end if;
end $$;
