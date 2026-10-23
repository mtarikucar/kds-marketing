-- M3 controller prerequisites; T2 extends this unreleased pair with remaining Studio tables.
-- Baseline: 48 tables, 106 tools, migrations 0001..0008. This step adds one of the 14 Studio tables.
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
create table if not exists studio_learning_applications (
    workspace_id uuid not null references workspaces(id),
    hypothesis_id uuid not null,
    born_version_id uuid not null,
    evidence_key text not null check (length(evidence_key) > 0),
    derived_confidence real not null check (derived_confidence between 0 and 1),
    applied_order bigint generated always as identity,
    primary key (workspace_id, hypothesis_id, evidence_key),
    foreign key (born_version_id, hypothesis_id) references strategy_hypotheses(version_id, hypothesis_id),
    foreign key (born_version_id, workspace_id) references strategy_versions(id, workspace_id)
);
alter table studio_learning_applications enable row level security;
alter table studio_learning_applications force row level security;
drop policy if exists tenant_isolation on studio_learning_applications;
create policy tenant_isolation on studio_learning_applications
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
