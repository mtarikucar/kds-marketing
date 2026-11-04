-- Outreach (spec 2026-10-30-leads-pool-outreach-design.md §3.10–§3.14, §4.3): plain-text email
-- templates, campaigns (their definition, approval and state), enrollments (one person in one
-- campaign; at most one active enrollment per person), and one row per outreach email sent
-- through the outbox. The owner and manager system roles gain outreach.work and
-- outreach.manage. Repeatable: every statement is guarded.
--
-- Nothing here sends: the platform switch JEETA_OUTREACH_ENABLED (off by default) is checked by
-- the application at launch, dispatch and claim.

create table if not exists outreach_templates (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key,
    name text not null check (char_length(name) between 1 and 120),
    language text not null check (language in ('tr', 'en')),
    subject text not null check (char_length(subject) between 1 and 200),
    body text not null check (char_length(body) between 1 and 20000),
    revision bigint not null check (revision >= 1),
    archived boolean not null default false,
    created_by jsonb not null check (jsonb_typeof(created_by) = 'object'),
    updated_at timestamptz not null,
    unique (id, workspace_id)
);
-- The workspace's templates, most recently edited first.
create index if not exists outreach_templates_list on outreach_templates
    (workspace_id, updated_at desc, id desc);

-- A campaign; its steps, audience, schedule, throttle and flags are the definition. A pause has
-- its reason; a completion its time.
create table if not exists outreach_campaigns (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key,
    name text not null check (char_length(name) between 1 and 120),
    mailbox_id uuid not null,
    status text not null check (status in ('draft', 'awaiting_approval', 'scheduled', 'running',
                                           'paused', 'completed', 'canceled')),
    definition jsonb not null check (jsonb_typeof(definition) = 'object'),
    revision bigint not null check (revision >= 1),
    approval jsonb check (approval is null or jsonb_typeof(approval) = 'object'),
    pause_reason text check (pause_reason in ('manual', 'bounce_rate', 'complaints',
                                              'mailbox_down', 'strategy_changed')),
    strategy_version_id uuid not null,
    created_by jsonb not null check (jsonb_typeof(created_by) = 'object'),
    created_at timestamptz not null,
    updated_at timestamptz not null,
    launched_at timestamptz,
    completed_at timestamptz,
    unique (id, workspace_id),
    constraint outreach_campaigns_pause_check check ((status = 'paused') = (pause_reason is not null)),
    constraint outreach_campaigns_completed_check check ((status = 'completed') = (completed_at is not null)),
    constraint outreach_campaigns_launched_check check (status <> 'draft' or launched_at is null),
    foreign key (mailbox_id, workspace_id) references capabilities (id, workspace_id),
    foreign key (strategy_version_id, workspace_id) references strategy_versions (id, workspace_id)
);
-- The dispatcher's campaigns, oldest launch first.
create index if not exists outreach_campaigns_running on outreach_campaigns (workspace_id, launched_at)
    where status = 'running';
-- The workspace's campaigns, newest first.
create index if not exists outreach_campaigns_list on outreach_campaigns
    (workspace_id, created_at desc, id desc);

-- One person in one campaign. A stopped or skipped enrollment says why (a stop or skip reason
-- key); an active one has its next send time. A promoted prospect is never deleted (the pool
-- refuses to erase or purge it), so the prospect reference needs no delete action.
create table if not exists outreach_enrollments (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key,
    campaign_id uuid not null,
    person_id uuid not null,
    journey_id uuid,
    prospect_id uuid,
    status text not null check (status in ('active', 'completed', 'stopped', 'skipped')),
    reason text check (char_length(reason) between 1 and 100),
    next_step smallint not null default 1 check (next_step between 1 and 7),
    next_send_at timestamptz,
    personalization jsonb not null default '{}' check (jsonb_typeof(personalization) = 'object'),
    basis text check (basis in ('consent', 'business_recipient')),
    enrolled_at timestamptz not null,
    stopped_at timestamptz,
    last_sent_at timestamptz,
    unique (id, workspace_id),
    unique (workspace_id, campaign_id, person_id),
    constraint outreach_enrollments_reason_check check
        ((status in ('stopped', 'skipped')) = (reason is not null)),
    constraint outreach_enrollments_active_check check (status <> 'active' or next_send_at is not null),
    foreign key (campaign_id, workspace_id) references outreach_campaigns (id, workspace_id),
    foreign key (person_id, workspace_id) references people (id, workspace_id),
    foreign key (journey_id, workspace_id) references journeys (id, workspace_id),
    foreign key (prospect_id, workspace_id) references prospects (id, workspace_id)
);
-- At most one active enrollment per person in the workspace.
create unique index if not exists outreach_enrollments_one_active on outreach_enrollments
    (workspace_id, person_id) where status = 'active';
-- The dispatcher's due enrollments of a campaign.
create index if not exists outreach_enrollments_due on outreach_enrollments
    (workspace_id, campaign_id, next_send_at, id) where status = 'active';

-- One outreach email: a step to an enrollment, through one outbox entry. `outcome` follows the
-- outbox's result and the mail evidence.
create table if not exists outreach_sends (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key,
    enrollment_id uuid not null,
    campaign_id uuid not null,
    mailbox_id uuid not null,
    step smallint not null check (step between 1 and 6),
    outbox_id uuid not null,
    message_id uuid not null,
    recipient_domain text not null check (char_length(recipient_domain) between 1 and 253),
    outcome text not null check (outcome in ('queued', 'sent', 'failed', 'unknown', 'refused',
                                             'bounced', 'complained')),
    created_at timestamptz not null,
    sent_at timestamptz,
    replied_at timestamptz,
    replied_threaded boolean,
    first_clicked_at timestamptz,
    clicks integer not null default 0 check (clicks >= 0),
    automated_clicks integer not null default 0 check (automated_clicks >= 0),
    unsubscribed_at timestamptz,
    unique (id, workspace_id),
    unique (workspace_id, outbox_id),
    constraint outreach_sends_replied_check check ((replied_at is null) = (replied_threaded is null)),
    foreign key (enrollment_id, workspace_id) references outreach_enrollments (id, workspace_id),
    foreign key (campaign_id, workspace_id) references outreach_campaigns (id, workspace_id),
    foreign key (message_id, workspace_id) references messages (id, workspace_id)
);
-- A mailbox's sends of a local day (budgets, warm-up).
create index if not exists outreach_sends_mailbox_day on outreach_sends (workspace_id, mailbox_id, created_at);
-- A campaign's sends (budgets, auto-pause, reports).
create index if not exists outreach_sends_campaign on outreach_sends (workspace_id, campaign_id, created_at);
-- A recipient domain's sends from a mailbox (domain pacing).
create index if not exists outreach_sends_domain on outreach_sends
    (workspace_id, mailbox_id, recipient_domain, created_at);
-- An enrollment's sends (a person's frequency, the latest send of a person).
create index if not exists outreach_sends_enrollment on outreach_sends (workspace_id, enrollment_id, created_at);

alter table outreach_templates enable row level security;
alter table outreach_templates force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'outreach_templates' and policyname = 'outreach_templates_ws') then
        create policy outreach_templates_ws on outreach_templates
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table outreach_campaigns enable row level security;
alter table outreach_campaigns force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'outreach_campaigns' and policyname = 'outreach_campaigns_ws') then
        create policy outreach_campaigns_ws on outreach_campaigns
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table outreach_enrollments enable row level security;
alter table outreach_enrollments force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'outreach_enrollments' and policyname = 'outreach_enrollments_ws') then
        create policy outreach_enrollments_ws on outreach_enrollments
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table outreach_sends enable row level security;
alter table outreach_sends force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'outreach_sends' and policyname = 'outreach_sends_ws') then
        create policy outreach_sends_ws on outreach_sends
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

-- The owner and manager system roles gain outreach.work and outreach.manage; rep holds neither
-- (spec D25). Custom roles are left to their workspaces.
do $$ declare previous text; begin
    previous := current_setting('app.platform', true);
    perform set_config('app.platform', 'on', true);
    update roles set permissions = array_append(permissions, 'outreach.work')
        where is_system and key in ('owner', 'manager')
          and not ('outreach.work' = any (permissions));
    update roles set permissions = array_append(permissions, 'outreach.manage')
        where is_system and key in ('owner', 'manager')
          and not ('outreach.manage' = any (permissions));
    perform set_config('app.platform', coalesce(previous, ''), true);
end $$;
