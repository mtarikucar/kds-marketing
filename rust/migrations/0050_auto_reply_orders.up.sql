-- The orders the inbox's automatic replies ask of the workspace's own shop
-- (`usecases::inbox::autoreply`): when a customer accepts the automatic quote and gives what the
-- order needs, the server shows them a summary to confirm; after an explicit yes it creates an
-- order draft in the shop and sends the payment link. One row per order: its state, the amount,
-- a keyed hash of the confirmed details, the shop's reference and the payment link. Never the
-- customer's name, email, phone or address: those exist in memory only, between the model's
-- answer and the shop's call (and in the conversation's own messages).
--
-- Additive: a new table, and the runs' outcome check widened by one value (`ordered`); no
-- existing row is read or changed, and every existing outcome stays allowed. Repeatable: every
-- statement is guarded.
alter table auto_reply_runs drop constraint if exists auto_reply_runs_outcome_check;
alter table auto_reply_runs add constraint auto_reply_runs_outcome_check
    check (outcome in ('replied', 'quoted', 'handed_over', 'skipped', 'failed', 'ordered'));

create table if not exists auto_reply_orders (
    workspace_id uuid not null references workspaces (id) on delete cascade,
    -- Also the order's reference at the shop (`jeeta_ref`), fixed per quote.
    id uuid not null,
    -- No foreign keys to the inbox's tables: their own downs drop them, and erasure clears a
    -- person's links (`inbox/erasure.rs`).
    journey_id uuid not null,
    conversation_id uuid not null,
    quote_id uuid not null,
    shop_capability_id uuid not null,
    run_id uuid not null,
    -- `confirming` while the customer is to confirm the summary; `calling` from just before the
    -- shop is asked until its answer is stored (a row left `calling`, a crash in between, becomes
    -- `unknown` and goes to a person).
    state text not null check (state in ('confirming', 'calling', 'created', 'failed', 'unknown')),
    -- Why it failed or is unknown (an `order_*` code).
    reason text,
    amount_minor bigint not null check (amount_minor >= 0),
    currency text not null,
    -- The shop's reference of the order, and the payment link it gave (cleared on erasure).
    reference text,
    pay_url text,
    created_at timestamptz not null,
    finished_at timestamptz,
    -- A keyed hash (HMAC-SHA256, a per-workspace key) of the details and the amount the customer
    -- was shown; never the details themselves.
    confirm_hash text,
    -- The outbox row of the summary the customer is to confirm, and how many the journey was
    -- shown.
    summary_outbox_id uuid,
    summaries integer not null default 0 check (summaries >= 0),
    -- When the shop was asked, and the conversation's executor generation then.
    called_at timestamptz,
    generation integer check (generation >= 0),
    primary key (workspace_id, id),
    -- One order per quote and one per journey.
    unique (workspace_id, quote_id),
    unique (workspace_id, journey_id)
);

create index if not exists auto_reply_orders_created on auto_reply_orders (workspace_id, created_at);

alter table auto_reply_orders enable row level security;
alter table auto_reply_orders force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'auto_reply_orders' and policyname = 'auto_reply_orders_ws') then
        create policy auto_reply_orders_ws on auto_reply_orders
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;
