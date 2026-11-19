-- The knowledge base (design 2026-11-19 "Paylaşımlar and Bilgi bankası" §4.2): what the owner
-- tells the agents in their own words. One settings row per workspace (the knowledge base's
-- revisions, its rules and goals, the caps and the post approval the system enforces, and what
-- the frame was last derived from), the free cards, every change of a card, the rules and the
-- goals as it was (append-only), the notes a person wrote to the agents, and the agents'
-- proposals. Additive: new tables and one new index only, nothing an existing row holds is read
-- or changed (every backfill is the application's), so it is safe on a live database and quick.
-- Repeatable: every statement is guarded. No foreign key to or from `strategy_*` (the frame stays
-- its own, append-only), and no `studio_` prefix.

create table if not exists knowledge_settings (
    workspace_id uuid primary key references workspaces (id) on delete cascade,
    -- +1 on every knowledge change.
    revision bigint not null default 0 check (revision >= 0),
    changed_at timestamptz,
    -- The person whose change it was.
    changed_by uuid,
    -- The revision of the last change of a posting card, of a prospecting card, and the
    -- revisions each part of the frame was last derived from.
    posting_revision bigint not null default 0,
    prospecting_revision bigint not null default 0,
    posting_derived bigint not null default 0,
    prospecting_derived bigint not null default 0,
    prohibitions jsonb not null default '[]'
        check (jsonb_typeof(prohibitions) = 'array' and jsonb_array_length(prohibitions) <= 100),
    goals jsonb not null default '[]'
        check (jsonb_typeof(goals) = 'array' and jsonb_array_length(goals) <= 20),
    -- {amount_minor, period: weekly|monthly, currency}; null: no ads.
    ad_cap jsonb check (ad_cap is null or jsonb_typeof(ad_cap) = 'object'),
    -- {amount_minor, period, currency}: paid messages (SMS, metered sends); null: no limit of
    -- its own.
    message_cap jsonb check (message_cap is null or jsonb_typeof(message_cap) = 'object'),
    -- "Her paylaşım onayıma gelsin", and the capability ids whose posts wait for the owner.
    post_approval boolean not null default false,
    post_approval_accounts jsonb not null default '[]'
        check (jsonb_typeof(post_approval_accounts) = 'array'
               and jsonb_array_length(post_approval_accounts) <= 200),
    -- When the accounts' stored approval flags were copied into the list.
    post_gate_seeded_at timestamptz,
    -- Topics a derivation left out, kept for the posts that still name them.
    closing_topic_ids jsonb not null default '[]'
        check (jsonb_typeof(closing_topic_ids) = 'array'
               and jsonb_array_length(closing_topic_ids) <= 200),
    rules_revision bigint not null default 1 check (rules_revision > 0),
    goals_revision bigint not null default 1 check (goals_revision > 0),
    frame_applied_at timestamptz,
    seeded_at timestamptz not null,
    seed_source text not null check (seed_source in ('approved', 'draft', 'empty'))
);

create table if not exists knowledge_cards (
    workspace_id uuid not null references workspaces (id) on delete cascade,
    id uuid not null,
    -- A seed card's fixed key; null for the owner's own cards.
    key text check (key is null or key ~ '^[a-z][a-z0-9_]{1,39}$'),
    title text not null check (char_length(title) between 1 and 80),
    body text not null default '' check (char_length(body) <= 8000),
    attachments jsonb not null default '[]'
        check (jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) <= 10),
    position integer not null check (position >= 0),
    revision bigint not null check (revision > 0),
    created_at timestamptz not null,
    created_by_user uuid,
    created_by_connection uuid,
    created_by_component text,
    updated_at timestamptz not null,
    updated_by_user uuid,
    updated_by_connection uuid,
    updated_by_component text,
    archived_at timestamptz,
    primary key (workspace_id, id)
);
create unique index if not exists knowledge_cards_one_key
    on knowledge_cards (workspace_id, key) where key is not null;
create index if not exists knowledge_cards_list
    on knowledge_cards (workspace_id, archived_at, position);

-- Every change of a card, of the rules and of the goals, as it was. Append-only.
create table if not exists knowledge_revisions (
    workspace_id uuid not null references workspaces (id) on delete cascade,
    id uuid not null,
    subject text not null check (subject in ('card', 'rules', 'goals')),
    card_id uuid,
    revision bigint not null check (revision > 0),
    kb_revision bigint not null check (kb_revision >= 0),
    content jsonb not null check (jsonb_typeof(content) = 'object'),
    cause text not null
        check (cause in ('seed', 'backfill', 'resync', 'owner', 'proposal', 'note', 'system')),
    -- The proposal or the note it came from.
    source_id uuid,
    at timestamptz not null,
    by_user uuid,
    by_connection uuid,
    by_component text,
    primary key (workspace_id, id),
    constraint knowledge_revisions_subject_rule check ((subject = 'card') = (card_id is not null)),
    constraint knowledge_revisions_card_fkey foreign key (workspace_id, card_id)
        references knowledge_cards (workspace_id, id)
);
create unique index if not exists knowledge_revisions_one
    on knowledge_revisions (workspace_id, subject,
        coalesce(card_id, '00000000-0000-0000-0000-000000000000'::uuid), revision);
create index if not exists knowledge_revisions_at on knowledge_revisions (workspace_id, at desc);

create or replace function knowledge_revisions_immutable() returns trigger
language plpgsql as $$
begin
    raise exception 'knowledge_revisions is append-only';
end;
$$;

create or replace trigger knowledge_revisions_append_only
    before update or delete on knowledge_revisions
    for each row execute function knowledge_revisions_immutable();

-- "Ajanlara bir şey anlat": what a person told the agents, until an agent files it.
create table if not exists knowledge_notes (
    workspace_id uuid not null references workspaces (id) on delete cascade,
    id uuid not null,
    text text not null check (char_length(text) between 1 and 4000),
    links jsonb not null default '[]'
        check (jsonb_typeof(links) = 'array' and jsonb_array_length(links) <= 10),
    file_ids jsonb not null default '[]'
        check (jsonb_typeof(file_ids) = 'array' and jsonb_array_length(file_ids) <= 10),
    status text not null check (status in ('open', 'filed', 'dismissed', 'withdrawn')),
    -- {connection_id, token_hash, until}
    claim jsonb check (claim is null or jsonb_typeof(claim) = 'object'),
    revision bigint not null check (revision > 0),
    created_at timestamptz not null,
    created_by_user uuid not null,
    closed_at timestamptz,
    closed_by_user uuid,
    closed_by_connection uuid,
    -- filed: {cards: [{card_id, revision}], rules: [line], goals: [line], post_request:
    -- {area_id} | null, proposals: [proposal_id], summary}; dismissed: {dismissed: reason}
    outcome jsonb check (outcome is null or jsonb_typeof(outcome) = 'object'),
    primary key (workspace_id, id),
    constraint knowledge_notes_closed_rule check ((closed_at is null) = (status = 'open'))
);
create index if not exists knowledge_notes_list
    on knowledge_notes (workspace_id, status, created_at desc);

-- "Ajanın önerileri".
create table if not exists knowledge_proposals (
    workspace_id uuid not null references workspaces (id) on delete cascade,
    id uuid not null,
    kind text not null check (kind in ('card_new', 'card_edit', 'rule_add', 'goal_add')),
    card_id uuid,
    title text check (title is null or char_length(title) between 1 and 80),
    body text not null check (char_length(body) between 1 and 8000),
    reason text not null check (char_length(reason) between 1 and 300),
    status text not null
        check (status in ('pending', 'accepted', 'skipped', 'expired', 'superseded')),
    -- card_edit: the card revision it was written against.
    base_revision bigint,
    proposed_at timestamptz not null,
    -- An agent, or the system: 'knowledge_backfill' (seeding), 'strategy_resync' (an old
    -- approval).
    proposed_by_connection uuid,
    proposed_by_component text,
    expires_at timestamptz not null,
    decided_at timestamptz,
    decided_by_user uuid,
    applied_revision bigint,
    primary key (workspace_id, id),
    constraint knowledge_proposals_card_rule check ((kind = 'card_edit') = (card_id is not null)),
    constraint knowledge_proposals_card_fkey foreign key (workspace_id, card_id)
        references knowledge_cards (workspace_id, id),
    constraint knowledge_proposals_decided_rule check ((decided_at is null) = (status = 'pending'))
);
create unique index if not exists knowledge_proposals_one_pending on knowledge_proposals
    (workspace_id, kind, coalesce(card_id, '00000000-0000-0000-0000-000000000000'::uuid), md5(body))
    where status = 'pending';
create index if not exists knowledge_proposals_list
    on knowledge_proposals (workspace_id, status, proposed_at desc);

-- Read-model support for the posts page: every live area of a workspace, newest first.
create index if not exists studio_production_projects_live
    on studio_production_projects (workspace_id, archived, updated_at desc);

-- Row-level security, as every tenant table. `create policy` has no `if not exists`, hence the
-- guards.

alter table knowledge_settings enable row level security;
alter table knowledge_settings force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'knowledge_settings' and policyname = 'knowledge_settings_ws') then
        create policy knowledge_settings_ws on knowledge_settings
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table knowledge_cards enable row level security;
alter table knowledge_cards force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'knowledge_cards' and policyname = 'knowledge_cards_ws') then
        create policy knowledge_cards_ws on knowledge_cards
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table knowledge_revisions enable row level security;
alter table knowledge_revisions force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'knowledge_revisions' and policyname = 'knowledge_revisions_ws') then
        create policy knowledge_revisions_ws on knowledge_revisions
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table knowledge_notes enable row level security;
alter table knowledge_notes force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'knowledge_notes' and policyname = 'knowledge_notes_ws') then
        create policy knowledge_notes_ws on knowledge_notes
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;

alter table knowledge_proposals enable row level security;
alter table knowledge_proposals force row level security;
do $$
begin
    if not exists (select 1 from pg_policies where tablename = 'knowledge_proposals' and policyname = 'knowledge_proposals_ws') then
        create policy knowledge_proposals_ws on knowledge_proposals
            using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                   or current_setting('app.platform', true) = 'on')
            with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                        or current_setting('app.platform', true) = 'on');
    end if;
end;
$$;
