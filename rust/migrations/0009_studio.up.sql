-- Growth Studio: 48 baseline tables + 14 tenant tables. No provider I/O in transactions.
-- Unreleased M3 migration; 0001–0008 remain immutable.
alter table budget_items add column if not exists unit_cost_minor bigint
    check (unit_cost_minor is null or unit_cost_minor >= 0);
alter table strategy_hypotheses add column if not exists cadence jsonb not null default '{}'
    check (jsonb_typeof(cadence) = 'object');
do $$ begin
    if exists (select 1 from information_schema.columns where table_schema = 'public'
               and table_name = 'strategy_hypotheses' and column_name = 'confidence') then
        alter table strategy_hypotheses rename column confidence to prior_confidence;
    end if;
end $$;

create unique index if not exists studio_hypothesis_tenant_identity
    on strategy_hypotheses(workspace_id, version_id, hypothesis_id);
create table if not exists studio_control (
    workspace_id uuid primary key references workspaces(id),
    data jsonb not null,
    seed_grants jsonb not null default '[]'
);
create table if not exists studio_arms (
    workspace_id uuid not null references workspaces(id), id uuid not null,
    hypothesis_id uuid not null, born_version_id uuid not null, content_type text not null, channel text not null,
    foreign key(workspace_id,born_version_id,hypothesis_id) references strategy_hypotheses(workspace_id,version_id,hypothesis_id),
    lane text not null check (lane in ('organic','paid')), data jsonb not null,
    primary key(workspace_id,id), unique(workspace_id,id,hypothesis_id),
    unique(workspace_id,hypothesis_id,content_type,channel,lane)
);
create table if not exists studio_slots (
    workspace_id uuid not null references workspaces(id), id uuid not null,
    data jsonb not null, primary key(workspace_id,id),
    capability_id uuid not null, scheduled_at timestamptz not null,
    state text not null check(state in ('planned','ready','published','measured','retired')),
    revision bigint not null check(revision >= 0), run_key text not null, ordinal int not null check(ordinal >= 0),
    unique(workspace_id,run_key,ordinal), unique(workspace_id,id,born_version_id,hypothesis_id,arm_id),
    foreign key(workspace_id,capability_id) references capabilities(workspace_id,id),
    born_version_id uuid not null, hypothesis_id uuid not null, arm_id uuid not null,
    foreign key(workspace_id,born_version_id,hypothesis_id)
        references strategy_hypotheses(workspace_id,version_id,hypothesis_id),
    foreign key(workspace_id,arm_id,hypothesis_id) references studio_arms(workspace_id,id,hypothesis_id)
);
create table if not exists studio_files (
    workspace_id uuid not null references workspaces(id), id uuid not null,
    data jsonb not null, primary key(workspace_id,id),
    size_bytes bigint not null check(size_bytes > 0)
);
create table if not exists studio_pieces (
    workspace_id uuid not null references workspaces(id), id uuid not null,
    data jsonb not null, primary key(workspace_id,id),
    slot_id uuid not null, revision bigint not null check(revision > 0),
    unique(workspace_id,slot_id,revision), unique(workspace_id,id,slot_id),
    foreign key(workspace_id,slot_id,born_version_id,hypothesis_id,arm_id)
        references studio_slots(workspace_id,id,born_version_id,hypothesis_id,arm_id),
    born_version_id uuid not null, hypothesis_id uuid not null, arm_id uuid not null,
    foreign key(workspace_id,born_version_id,hypothesis_id)
        references strategy_hypotheses(workspace_id,version_id,hypothesis_id),
    foreign key(workspace_id,arm_id,hypothesis_id) references studio_arms(workspace_id,id,hypothesis_id)
);
create table if not exists studio_publish_attempts (
    workspace_id uuid not null references workspaces(id), id uuid not null,
    data jsonb not null, primary key(workspace_id,id),
    slot_id uuid not null, piece_id uuid not null, executed_version_id uuid not null,
    state text not null check(state in ('sending','succeeded','failed','unknown','refused')),
    unique(workspace_id,slot_id), unique(workspace_id,id,slot_id),
    foreign key(workspace_id,slot_id) references studio_slots(workspace_id,id),
    foreign key(workspace_id,piece_id,slot_id) references studio_pieces(workspace_id,id,slot_id),
    foreign key(executed_version_id,workspace_id) references strategy_versions(id,workspace_id)
);
create table if not exists studio_publications (
    workspace_id uuid not null references workspaces(id), id uuid not null,
    data jsonb not null, primary key(workspace_id,id),
    slot_id uuid not null, attempt_id uuid not null, piece_id uuid not null,
    capability_id uuid not null, external_id text not null check(length(external_id)>0), executed_version_id uuid not null,
    unique(workspace_id,slot_id), unique(workspace_id,capability_id,external_id),
    foreign key(workspace_id,slot_id,born_version_id,hypothesis_id,arm_id)
        references studio_slots(workspace_id,id,born_version_id,hypothesis_id,arm_id),
    foreign key(workspace_id,attempt_id,slot_id) references studio_publish_attempts(workspace_id,id,slot_id),
    foreign key(workspace_id,piece_id,slot_id) references studio_pieces(workspace_id,id,slot_id),
    foreign key(workspace_id,capability_id) references capabilities(workspace_id,id),
    foreign key(executed_version_id,workspace_id) references strategy_versions(id,workspace_id),
    born_version_id uuid not null, hypothesis_id uuid not null, arm_id uuid not null,
    foreign key(workspace_id,born_version_id,hypothesis_id)
        references strategy_hypotheses(workspace_id,version_id,hypothesis_id),
    foreign key(workspace_id,arm_id,hypothesis_id) references studio_arms(workspace_id,id,hypothesis_id)
);
create table if not exists studio_adset_bindings (
    workspace_id uuid not null references workspaces(id), id uuid not null,
    data jsonb not null, primary key(workspace_id,id),
    capability_id uuid not null, adset_id text not null check(length(adset_id)>0),
    control jsonb, unique(workspace_id,capability_id,adset_id),
    foreign key(workspace_id,capability_id) references capabilities(workspace_id,id),
    born_version_id uuid not null, hypothesis_id uuid not null, arm_id uuid not null,
    foreign key(workspace_id,born_version_id,hypothesis_id)
        references strategy_hypotheses(workspace_id,version_id,hypothesis_id),
    foreign key(workspace_id,arm_id,hypothesis_id) references studio_arms(workspace_id,id,hypothesis_id)
);
create table if not exists studio_measurements (
    workspace_id uuid not null references workspaces(id), id uuid not null,
    data jsonb not null, primary key(workspace_id,id),
    publication_id uuid, binding_id uuid, measurement_window text not null,
    date date, metric_scope text not null, evidence_key text not null,
    status text not null check(status in ('complete','missing','failed')),
    check((publication_id is not null and binding_id is null and metric_scope='post') or
          (binding_id is not null and publication_id is null and date is not null and metric_scope='adset')),
    -- Immutable revisions; application serializes target/window/revision under Studio control.
    unique(workspace_id,evidence_key),
    foreign key(workspace_id,publication_id) references studio_publications(workspace_id,id),
    foreign key(workspace_id,binding_id) references studio_adset_bindings(workspace_id,id),
    born_version_id uuid not null, hypothesis_id uuid not null, arm_id uuid not null,
    foreign key(workspace_id,born_version_id,hypothesis_id)
        references strategy_hypotheses(workspace_id,version_id,hypothesis_id),
    foreign key(workspace_id,arm_id,hypothesis_id) references studio_arms(workspace_id,id,hypothesis_id)
);
create table if not exists studio_learning_applications (
    workspace_id uuid not null references workspaces(id), hypothesis_id uuid not null,
    born_version_id uuid not null, arm_id uuid, data jsonb,
    evidence_key text not null check(length(evidence_key)>0),
    derived_confidence real not null check(derived_confidence between 0 and 1),
    applied_order bigint generated always as identity,
    primary key(workspace_id,hypothesis_id,evidence_key),
    foreign key(workspace_id,born_version_id,hypothesis_id) references strategy_hypotheses(workspace_id,version_id,hypothesis_id),
    foreign key(workspace_id,arm_id,hypothesis_id) references studio_arms(workspace_id,id,hypothesis_id)
);
create table if not exists studio_trends (
    workspace_id uuid not null references workspaces(id), id uuid not null,
    data jsonb not null, primary key(workspace_id,id),
    born_version_id uuid not null, hypothesis_id uuid not null,
    foreign key(workspace_id,born_version_id,hypothesis_id) references strategy_hypotheses(workspace_id,version_id,hypothesis_id)
);
create table if not exists studio_spend_reservations (
    workspace_id uuid not null references workspaces(id), id uuid not null,
    data jsonb not null, primary key(workspace_id,id),
    capability_id uuid not null, executed_version_id uuid not null,
    evidence_key text not null, at timestamptz not null, amount_minor bigint not null check(amount_minor>=0),
    outcome jsonb, unique(workspace_id,evidence_key),
    foreign key(workspace_id,capability_id) references capabilities(workspace_id,id),
    foreign key(executed_version_id,workspace_id) references strategy_versions(id,workspace_id)
);
create table if not exists studio_budget_moves (
    workspace_id uuid not null references workspaces(id), id uuid not null,
    data jsonb not null, primary key(workspace_id,id),
    binding_id uuid not null, reservation_id uuid, executed_version_id uuid,
    foreign key(workspace_id,binding_id) references studio_adset_bindings(workspace_id,id),
    foreign key(workspace_id,reservation_id) references studio_spend_reservations(workspace_id,id),
    foreign key(executed_version_id,workspace_id) references strategy_versions(id,workspace_id),
    born_version_id uuid not null, hypothesis_id uuid not null, arm_id uuid not null,
    foreign key(workspace_id,born_version_id,hypothesis_id)
        references strategy_hypotheses(workspace_id,version_id,hypothesis_id),
    foreign key(workspace_id,arm_id,hypothesis_id) references studio_arms(workspace_id,id,hypothesis_id)
);
create table if not exists studio_request_keys (
    workspace_id uuid not null references workspaces(id), action text not null, key text not null check(length(key)>0),
    payload_digest text not null, response jsonb not null,
    primary key(workspace_id,action,key)
);
create index if not exists studio_slots_due on studio_slots(workspace_id,scheduled_at,id) where state='ready';
-- RLS is forced even for the owner. Platform transactions are for migration/seeding only.
alter table studio_arms enable row level security;
alter table studio_arms force row level security;
drop policy if exists tenant_isolation on studio_arms;
create policy tenant_isolation on studio_arms
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');
alter table studio_slots enable row level security;
alter table studio_slots force row level security;
drop policy if exists tenant_isolation on studio_slots;
create policy tenant_isolation on studio_slots
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');
alter table studio_pieces enable row level security;
alter table studio_pieces force row level security;
drop policy if exists tenant_isolation on studio_pieces;
create policy tenant_isolation on studio_pieces
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');
alter table studio_files enable row level security;
alter table studio_files force row level security;
drop policy if exists tenant_isolation on studio_files;
create policy tenant_isolation on studio_files
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');
alter table studio_publications enable row level security;
alter table studio_publications force row level security;
drop policy if exists tenant_isolation on studio_publications;
create policy tenant_isolation on studio_publications
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');
alter table studio_publish_attempts enable row level security;
alter table studio_publish_attempts force row level security;
drop policy if exists tenant_isolation on studio_publish_attempts;
create policy tenant_isolation on studio_publish_attempts
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');
alter table studio_measurements enable row level security;
alter table studio_measurements force row level security;
drop policy if exists tenant_isolation on studio_measurements;
create policy tenant_isolation on studio_measurements
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');
alter table studio_learning_applications enable row level security;
alter table studio_learning_applications force row level security;
drop policy if exists tenant_isolation on studio_learning_applications;
create policy tenant_isolation on studio_learning_applications
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');
alter table studio_trends enable row level security;
alter table studio_trends force row level security;
drop policy if exists tenant_isolation on studio_trends;
create policy tenant_isolation on studio_trends
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');
alter table studio_adset_bindings enable row level security;
alter table studio_adset_bindings force row level security;
drop policy if exists tenant_isolation on studio_adset_bindings;
create policy tenant_isolation on studio_adset_bindings
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');
alter table studio_budget_moves enable row level security;
alter table studio_budget_moves force row level security;
drop policy if exists tenant_isolation on studio_budget_moves;
create policy tenant_isolation on studio_budget_moves
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');
alter table studio_spend_reservations enable row level security;
alter table studio_spend_reservations force row level security;
drop policy if exists tenant_isolation on studio_spend_reservations;
create policy tenant_isolation on studio_spend_reservations
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');
alter table studio_control enable row level security;
alter table studio_control force row level security;
drop policy if exists tenant_isolation on studio_control;
create policy tenant_isolation on studio_control
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');
alter table studio_request_keys enable row level security;
alter table studio_request_keys force row level security;
drop policy if exists tenant_isolation on studio_request_keys;
create policy tenant_isolation on studio_request_keys
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');
-- Remember only keys actually inserted by this migration, including the role UUID. An
-- already-present grant and roles created by normal registration are never rollback targets.
do $$ declare r record; g text; previous text; begin
    previous := current_setting('app.platform',true);
    perform set_config('app.platform','on',true);
    for r in select id,workspace_id,permissions from roles where is_system and key in ('owner','manager') for update loop
        foreach g in array array['studio.work','studio.manage'] loop
            if not g = any(r.permissions) then
                insert into studio_control(workspace_id,data) values(r.workspace_id,
                    jsonb_build_object('workspace_id',r.workspace_id,'brake_engaged',false,'revision',0,'lanes','{}'::jsonb))
                    on conflict do nothing;
                update studio_control set seed_grants=seed_grants || jsonb_build_array(jsonb_build_object('role_id',r.id,'permission',g)) where workspace_id=r.workspace_id;
                update roles set permissions=array_append(permissions,g) where workspace_id=r.workspace_id and id=r.id and not g=any(permissions);
            end if;
        end loop;
    end loop;
    perform set_config('app.platform',coalesce(previous,''),true);
end $$;
