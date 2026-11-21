-- The owner's email notices (`usecases::inbox::notices`): one row per thing the owner is told of,
-- by email through the workspace's own verified mailbox: a conversation the automatic replies
-- handed to a person (`handed_over`), and an order they created (`order_created`, written by a
-- later release). Codes and ids only: never a customer's name, text or address. Additive: a new
-- table, nothing an existing row holds is read or changed. Repeatable: every statement is guarded.
create table if not exists owner_notices (
    workspace_id uuid not null references workspaces (id) on delete cascade,
    id uuid not null,
    kind text not null check (kind in ('handed_over', 'order_created')),
    -- No foreign key to `conversations`: the inbox's own downs drop that table.
    conversation_id uuid not null,
    -- One notice per thing told of: `handed_over:{conversation}:{generation}`, `order:{order}`.
    dedupe_key text not null,
    -- The hand-over's reason code (or `daily_cap` for a skipped notice).
    reason text,
    created_at timestamptz not null,
    -- `sending` from just before the mail server is asked until the answer is stored; a row left
    -- `sending` (a crash in between) is taken as sent, never sent again.
    state text not null check (state in ('queued', 'sending', 'sent', 'failed', 'skipped')),
    attempts integer not null default 0 check (attempts >= 0),
    -- When a queued notice may be tried (again): null at once, later after a failed attempt.
    next_at timestamptz,
    -- When it was sent (for `sending`: when the send began).
    sent_at timestamptz,
    -- The mailbox the notice goes out through, chosen when it is sent.
    mailbox_capability_id uuid,
    primary key (workspace_id, id),
    unique (workspace_id, dedupe_key)
);

create index if not exists owner_notices_created on owner_notices (workspace_id, created_at);
create index if not exists owner_notices_queued on owner_notices (next_at) where state in ('queued', 'sending');

alter table owner_notices enable row level security;
alter table owner_notices force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'owner_notices' and policyname = 'owner_notices_ws') then
        create policy owner_notices_ws on owner_notices
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;
