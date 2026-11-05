-- Mail files (spec 2026-10-30-leads-pool-outreach-design.md §3.15, §4.4): one row per email
-- attachment Jeeta keeps or decided not to keep. An inbound file is stored at poll time as
-- `application/octet-stream` (its declared type kept here) and linked to its message and person
-- when the email is consumed; an outbound file is uploaded `staged`, then `attached` to the one
-- message that carries it. The row's id is the file store's id; the bytes live in the store, never
-- here. A row that held bytes stays, `deleted`, once they are gone (retention, erasure); a
-- `skipped` row never held any (a cap refused the file). Repeatable: every statement is guarded.

create table if not exists mail_files (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key,
    direction text not null check (direction in ('inbound', 'outbound')),
    state text not null check (state in ('stored', 'staged', 'attached', 'skipped', 'deleted')),
    skip_reason text,
    capability_id uuid,
    event_external_id text,
    message_id uuid,
    person_id uuid,
    filename text not null check (char_length(filename) <= 255),
    declared_mime text not null check (char_length(declared_mime) <= 255),
    size_bytes bigint not null check (size_bytes >= 0),
    sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
    created_at timestamptz not null,
    expires_at timestamptz,
    deleted_at timestamptz,
    foreign key (capability_id, workspace_id) references capabilities (id, workspace_id),
    foreign key (message_id, workspace_id) references messages (id, workspace_id),
    foreign key (person_id, workspace_id) references people (id, workspace_id),
    -- An inbound file is stored, skipped or deleted, and names the mailbox and the email it came
    -- in; an outbound one is staged, attached or deleted.
    constraint mail_files_direction_state check (
        (direction = 'inbound' and state in ('stored', 'skipped', 'deleted')
            and capability_id is not null and event_external_id is not null)
        or (direction = 'outbound' and state in ('staged', 'attached', 'deleted'))),
    -- Why a file was not kept, exactly when it was not.
    constraint mail_files_skip_reason check (
        (state = 'skipped') = (skip_reason is not null)
        and (skip_reason is null or skip_reason in ('file_too_large', 'too_many_files', 'daily_limit'))),
    -- A file the store holds has its hash; a staged one its expiry; an attached one its message;
    -- a deleted one the time its bytes went.
    constraint mail_files_held_check check (state in ('skipped', 'deleted') or sha256 is not null),
    constraint mail_files_staged_check check (state <> 'staged' or expires_at is not null),
    constraint mail_files_attached_check check (state <> 'attached' or message_id is not null),
    constraint mail_files_deleted_check check ((state = 'deleted') = (deleted_at is not null))
);
create index if not exists mail_files_message on mail_files (workspace_id, message_id);
create index if not exists mail_files_expiry on mail_files (workspace_id, expires_at) where deleted_at is null;
create index if not exists mail_files_event on mail_files (workspace_id, capability_id, event_external_id);

alter table mail_files enable row level security;
alter table mail_files force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'mail_files' and policyname = 'mail_files_ws') then
        create policy mail_files_ws on mail_files
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;
