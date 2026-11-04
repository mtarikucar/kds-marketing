-- A probe run keeps why it failed: the bounded failure line (`kind: provider: reason`, at most
-- 300 characters, already redacted by the adapter's error constructors). And `unknown` (the
-- outcome of a write that may have reached the provider) becomes a legal error kind, so a probe
-- an adapter answers with it is stored instead of failing the whole probe on the check.
-- Repeatable: the column is added once, the check is replaced by name.
alter table probe_runs add column if not exists reason text
    constraint probe_runs_reason_check check (char_length(reason) <= 300);
alter table probe_runs drop constraint if exists probe_runs_error_kind_check;
alter table probe_runs add constraint probe_runs_error_kind_check
    check (error_kind in ('auth', 'permission', 'throttle', 'transient', 'unknown', 'permanent'));
