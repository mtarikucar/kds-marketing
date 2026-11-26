-- While the agent keeps every conversation (`knowledge_settings.auto_reply.keeps_conversations`,
-- `usecases::inbox::autoreply`), what the automatic replies would have handed to a person is asked
-- of the owner instead: the conversation stays the agent's, and the open item for the owner is a
-- task on the person's journey (`tasks`, the inbox's own follow-up work). This table ties each such
-- task to its conversation and reason, so one reason asks the owner once until the task is done
-- (one row per conversation and reason, claimed before the task is made, so two runs at once ask
-- once), and remembers the line that told the customer the team will get back to them
-- (`line_outbox_id`). The inbox's default queue shows a conversation the agent holds while one of
-- its items is open. Codes and ids only: never a customer's text or the model's summary (that is
-- the journey note's, which erasure clears).
--
-- Additive: a new table; no existing row is read or changed. Repeatable: every statement is
-- guarded.
create table if not exists auto_reply_owner_items (
    workspace_id uuid not null references workspaces (id) on delete cascade,
    -- No foreign keys to the inbox's tables: their own downs drop them, and erasure removes a
    -- person's rows (`inbox/erasure.rs`).
    conversation_id uuid not null,
    reason text not null check (char_length(reason) between 1 and 64),
    -- The owner's task on the person's journey; none when the person had no journey (such an
    -- item stays open until a person takes the conversation over, hands it back or closes it).
    task_id uuid,
    created_at timestamptz not null,
    -- The outbox row of the line that told the customer, once one was queued.
    line_outbox_id uuid,
    primary key (workspace_id, conversation_id, reason)
);

-- The owner's open tasks among them, by task (the home list's tasks).
create index if not exists auto_reply_owner_items_task on auto_reply_owner_items (workspace_id, task_id);

alter table auto_reply_owner_items enable row level security;
alter table auto_reply_owner_items force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'auto_reply_owner_items' and policyname = 'auto_reply_owner_items_ws') then
        create policy auto_reply_owner_items_ws on auto_reply_owner_items
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;
