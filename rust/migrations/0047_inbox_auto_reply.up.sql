-- The inbox's automatic replies (`usecases::inbox::autoreply`): the owner's setting, the debounced
-- work list and one row per model call. Additive: a nullable column and two new tables, nothing an
-- existing row holds is read or changed (every workspace's `auto_reply` starts null, which is
-- off), so it is safe on a live database. Repeatable: every statement is guarded.
--
-- `knowledge_settings.auto_reply`: the capabilities the replies answer on, the price range of
-- their quotes and how long a quote is valid; null (never set up) or an empty list is off.
alter table knowledge_settings add column if not exists auto_reply jsonb
    check (auto_reply is null or jsonb_typeof(auto_reply) = 'object');

-- One row per conversation waiting for an automatic reply: the customer's first message of the
-- burst (`first_at`), when the reply is due (`due_at`, after the last message, never later than
-- a bound after the first; null while a run holds it), the run's lease, and how many model calls
-- failed for it.
create table if not exists auto_reply_queue (
    workspace_id uuid not null references workspaces (id) on delete cascade,
    conversation_id uuid not null,
    first_at timestamptz not null,
    due_at timestamptz,
    lease_until timestamptz,
    attempts integer not null default 0 check (attempts >= 0),
    primary key (workspace_id, conversation_id),
    foreign key (conversation_id, workspace_id) references conversations (id, workspace_id)
        on delete cascade
);

create index if not exists auto_reply_queue_due on auto_reply_queue (due_at) where due_at is not null;
create index if not exists auto_reply_queue_lease on auto_reply_queue (lease_until)
    where lease_until is not null;

-- One row per model call: codes and numbers only (never a customer's text, the model's answer,
-- a quote's basis or a hand-over's summary). The day's limits are counted from it; the model's
-- cost (`cost_micro_usd`, millionths of a US dollar) lives here, never in `messages.cost_minor`,
-- which is a channel's price in the tenant's own budget currency.
create table if not exists auto_reply_runs (
    workspace_id uuid not null references workspaces (id) on delete cascade,
    id uuid not null,
    conversation_id uuid not null,
    capability_id uuid not null,
    at timestamptz not null,
    model text not null,
    outcome text not null check (outcome in ('replied', 'quoted', 'handed_over', 'skipped', 'failed')),
    reason text,
    input_tokens bigint not null default 0 check (input_tokens >= 0),
    output_tokens bigint not null default 0 check (output_tokens >= 0),
    cache_write_tokens bigint not null default 0 check (cache_write_tokens >= 0),
    cache_read_tokens bigint not null default 0 check (cache_read_tokens >= 0),
    cost_micro_usd bigint not null default 0 check (cost_micro_usd >= 0),
    outbox_id uuid,
    quote_id uuid,
    primary key (workspace_id, id)
);

create index if not exists auto_reply_runs_at on auto_reply_runs (workspace_id, at);
create index if not exists auto_reply_runs_conversation on auto_reply_runs (workspace_id, conversation_id, at);

alter table auto_reply_queue enable row level security;
alter table auto_reply_queue force row level security;
alter table auto_reply_runs enable row level security;
alter table auto_reply_runs force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'auto_reply_queue' and policyname = 'auto_reply_queue_ws') then
        create policy auto_reply_queue_ws on auto_reply_queue
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
    if not exists (select 1 from pg_policies where tablename = 'auto_reply_runs' and policyname = 'auto_reply_runs_ws') then
        create policy auto_reply_runs_ws on auto_reply_runs
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;
