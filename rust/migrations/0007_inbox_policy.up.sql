-- Response deadlines and reachability settings; existing labels remain in their constrained column.
alter table workspace_policies add column if not exists inbox_policy jsonb not null default '{}' check (jsonb_typeof(inbox_policy) = 'object');
