-- Chat media (`ports::message_media`): one row per image or document a chat message carries (a
-- WhatsApp Cloud message today; any channel whose sender implements `fetch_media`). A customer's
-- file is recorded `pending` with the provider's media id when its message is consumed, fetched
-- by the `inbox_media` job through the provider's media API with the capability's own credential,
-- checked by its bytes and kept in the file store (`stored`), or recorded `failed` with why. Its
-- bytes go after the retention (180 days, design 2026-10-30 D21/D26 for inbound attachments) or
-- with the person's erasure: the row stays, `deleted`, without its name or media id. The bytes
-- live in the file store, never here. Additive: a new table, nothing an existing row holds is
-- read or changed. Repeatable: every statement is guarded.

create table if not exists message_media (
    workspace_id uuid not null references workspaces (id),
    id uuid primary key,
    message_id uuid not null,
    -- The file's place among its message's files, from 0.
    position smallint not null check (position between 0 and 9),
    capability_id uuid not null,
    direction text not null check (direction in ('inbound', 'outbound')),
    kind text not null check (kind in ('image', 'document')),
    -- Where the bytes come from: the provider (a customer's file), an upload of the team's, or a
    -- material of the library (whose file is the library's, never deleted from here).
    source text not null check (source in ('provider', 'upload', 'material')),
    material_id uuid,
    -- The file store's id of the bytes, once held.
    file_id uuid,
    -- The provider's id of the file, while it may still be fetched; cleared once it is held,
    -- refused or erased.
    provider_media_id text check (provider_media_id is null or char_length(provider_media_id) between 1 and 256),
    -- The type the provider (or the uploader) named; `mime` the type its bytes are.
    declared_mime text not null check (char_length(declared_mime) <= 255),
    mime text check (mime is null or char_length(mime) <= 255),
    -- A document's name (blank for an image, and once erased).
    filename text not null check (char_length(filename) <= 255),
    size_bytes bigint check (size_bytes is null or size_bytes >= 0),
    sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
    width integer check (width is null or width > 0),
    height integer check (height is null or height > 0),
    state text not null check (state in ('pending', 'stored', 'failed', 'deleted')),
    reason text check (reason is null or reason in (
        'expired', 'too_large', 'not_allowed', 'too_many_pixels', 'unavailable', 'daily_limit',
        'erased', 'retention')),
    attempts integer not null default 0 check (attempts >= 0),
    -- When a pending file may be fetched (again): null at once.
    next_attempt_at timestamptz,
    created_at timestamptz not null,
    stored_at timestamptz,
    deleted_at timestamptz,
    foreign key (message_id, workspace_id) references messages (id, workspace_id),
    foreign key (capability_id, workspace_id) references capabilities (id, workspace_id),
    unique (workspace_id, message_id, position),
    -- A customer's file comes from the provider; one of ours from an upload or the library.
    constraint message_media_source_rule check (
        (direction = 'inbound' and source = 'provider')
        or (direction = 'outbound' and source in ('upload', 'material'))),
    constraint message_media_material_rule check ((source = 'material') = (material_id is not null)),
    -- A pending file names what to fetch; a stored one its bytes; a failed or deleted one why.
    constraint message_media_pending_rule check (state <> 'pending' or provider_media_id is not null),
    constraint message_media_stored_rule check (state <> 'stored' or (file_id is not null
        and sha256 is not null and size_bytes is not null and mime is not null and stored_at is not null)),
    constraint message_media_reason_rule check (
        (state in ('pending', 'stored') and reason is null)
        or (state = 'failed' and reason in ('expired', 'too_large', 'not_allowed', 'too_many_pixels', 'unavailable', 'daily_limit'))
        or (state = 'deleted' and reason in ('erased', 'retention'))),
    constraint message_media_deleted_rule check ((state = 'deleted') = (deleted_at is not null))
);
create index if not exists message_media_message on message_media (workspace_id, message_id);
create index if not exists message_media_pending on message_media (workspace_id, next_attempt_at) where state = 'pending';
create index if not exists message_media_stored on message_media (workspace_id, stored_at) where state = 'stored';
create index if not exists message_media_file on message_media (workspace_id, file_id) where file_id is not null;

alter table message_media enable row level security;
alter table message_media force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'message_media' and policyname = 'message_media_ws') then
        create policy message_media_ws on message_media
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;
