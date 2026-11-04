-- The Growth Studio materials library (spec 2026-11-03-studio-materials-design.md §6): olays (the
-- real context of a material), materials (a Studio file with its olay or genel, its origin, share
-- permission and tags), what each piece revision shows, the workspace's calendar rows, the çekim
-- listesi, the materials policy and the caption-check releases. Seven tenant tables, forced RLS.
-- Records keep Studio's `data jsonb`; the columns below are what the rules and indexes need.
-- Repeatable: every statement is guarded.

create table if not exists studio_olays (
    workspace_id uuid not null references workspaces (id),
    id uuid not null,
    data jsonb not null check (jsonb_typeof(data) = 'object'),
    kind text not null
        check (kind in ('workshop', 'order', 'season', 'special_day', 'product_shoot', 'other')),
    -- An agent's olay is proposed until a human confirms it; only a confirmed one makes a
    -- material eligible.
    status text not null check (status in ('proposed', 'confirmed')),
    starts_on date not null,
    ends_on date not null,
    occasion text check (occasion is null or occasion ~ '^[a-z0-9_]{1,40}$'),
    revision bigint not null check (revision > 0),
    primary key (workspace_id, id),
    constraint studio_olays_dates_rule check (starts_on <= ends_on and ends_on - starts_on < 366),
    -- A season or special day names its calendar occasion; no other kind does.
    constraint studio_olays_occasion_rule
        check ((occasion is not null) = (kind in ('season', 'special_day')))
);
create index if not exists studio_olays_dates on studio_olays (workspace_id, starts_on);

create table if not exists studio_materials (
    workspace_id uuid not null references workspaces (id),
    id uuid not null,
    data jsonb not null check (jsonb_typeof(data) = 'object'),
    file_id uuid not null,
    binding text not null check (binding in ('olay', 'genel')),
    olay_id uuid,
    origin text not null check (origin in ('real', 'ai_generated')),
    generator text check (generator is null or generator ~ '^[a-z0-9_.-]{1,40}$'),
    share text check (share is null or share in ('shareable', 'not_shareable', 'product_only')),
    freed_at timestamptz,
    erased_at timestamptz,
    revision bigint not null check (revision > 0),
    created_at timestamptz not null,
    primary key (workspace_id, id),
    -- One material per file.
    constraint studio_materials_file_key unique (workspace_id, file_id),
    constraint studio_materials_file_fkey foreign key (workspace_id, file_id)
        references studio_files (workspace_id, id),
    constraint studio_materials_olay_fkey foreign key (workspace_id, olay_id)
        references studio_olays (workspace_id, id),
    constraint studio_materials_binding_rule check ((binding = 'olay') = (olay_id is not null)),
    constraint studio_materials_generator_rule
        check ((origin = 'ai_generated') = (generator is not null)),
    -- A real genel material is one a human freed.
    constraint studio_materials_genel_rule
        check (binding <> 'genel' or origin = 'ai_generated' or freed_at is not null)
);
create index if not exists studio_materials_olay on studio_materials (workspace_id, olay_id);

-- A material's identity, file, origin and generator are fixed when it is created: an AI image is
-- never made real. Materials are redacted, never deleted, so what a post showed stays known; an
-- erased one never changes again (the redaction itself, which sets `erased_at`, passes).
create or replace function studio_materials_fixed() returns trigger language plpgsql as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'studio_materials: a material is redacted, never deleted';
    end if;
    if old.erased_at is not null then
        raise exception 'studio_materials: an erased material never changes';
    end if;
    if new.workspace_id <> old.workspace_id or new.id <> old.id or new.file_id <> old.file_id
       or new.origin <> old.origin or new.generator is distinct from old.generator then
        raise exception 'studio_materials: file, origin and generator never change';
    end if;
    return new;
end;
$$;
create or replace trigger studio_materials_fixed before update or delete on studio_materials
    for each row execute function studio_materials_fixed();

-- What one piece revision shows, each material with its role, and the piece's subject. Written
-- once with the piece; never changed or removed.
create table if not exists studio_piece_materials (
    workspace_id uuid not null references workspaces (id),
    piece_id uuid not null,
    material_id uuid not null,
    slot_id uuid not null,
    revision bigint not null check (revision > 0),
    role text not null check (role in ('anchor', 'support')),
    subject jsonb not null check (jsonb_typeof(subject) = 'object'),
    primary key (workspace_id, piece_id, material_id),
    constraint studio_piece_materials_piece_fkey foreign key (workspace_id, piece_id, slot_id)
        references studio_pieces (workspace_id, id, slot_id),
    constraint studio_piece_materials_material_fkey foreign key (workspace_id, material_id)
        references studio_materials (workspace_id, id)
);
create index if not exists studio_piece_materials_slot
    on studio_piece_materials (workspace_id, slot_id, revision);
create index if not exists studio_piece_materials_material
    on studio_piece_materials (workspace_id, material_id);

create or replace function studio_piece_materials_insert_only() returns trigger language plpgsql as $$
begin
    raise exception 'studio_piece_materials: what a piece showed is never changed or removed';
end;
$$;
create or replace trigger studio_piece_materials_insert_only
    before update or delete on studio_piece_materials
    for each row execute function studio_piece_materials_insert_only();

-- The workspace's calendar rows: its edits of the computed defaults and the dates it entered.
create table if not exists studio_calendar_entries (
    workspace_id uuid not null references workspaces (id),
    key text not null check (key ~ '^[a-z0-9_]{1,40}$'),
    year int not null check (year between 2000 and 2100),
    data jsonb not null check (jsonb_typeof(data) = 'object'),
    kind text not null check (kind in ('season', 'special_day')),
    window_start date,
    window_end date,
    lead_days int check (lead_days is null or lead_days between 0 and 90),
    enabled boolean not null,
    primary key (workspace_id, key, year),
    constraint studio_calendar_entries_window_rule check (
        (window_start is null) = (window_end is null)
        and (window_start is null or (window_start <= window_end and window_end - window_start < 120))
    )
);

-- The çekim listesi: one request per key.
create table if not exists studio_shoot_requests (
    workspace_id uuid not null references workspaces (id),
    id uuid not null,
    key text not null check (char_length(key) between 1 and 240),
    data jsonb not null check (jsonb_typeof(data) = 'object'),
    status text not null check (status in ('open', 'done', 'dismissed')),
    week_start date not null,
    created_at timestamptz not null,
    primary key (workspace_id, id),
    constraint studio_shoot_requests_key unique (workspace_id, key)
);
create index if not exists studio_shoot_requests_week
    on studio_shoot_requests (workspace_id, status, week_start);

-- The workspace's materials settings; absent: the defaults (21, 14, 30).
create table if not exists studio_material_policy (
    workspace_id uuid primary key references workspaces (id),
    lead_days int not null check (lead_days between 0 and 90),
    reuse_days int not null check (reuse_days between 0 and 365),
    recap_days int not null check (recap_days between 0 and 365)
);

-- A human's release of one slot revision's caption findings, while their digest is the same.
create table if not exists studio_material_releases (
    workspace_id uuid not null references workspaces (id),
    slot_id uuid not null,
    revision bigint not null check (revision > 0),
    digest text not null check (digest ~ '^[0-9a-f]{64}$'),
    released_by uuid not null,
    released_at timestamptz not null,
    primary key (workspace_id, slot_id, revision),
    constraint studio_material_releases_slot_fkey foreign key (workspace_id, slot_id)
        references studio_slots (workspace_id, id)
);

-- Every table is the tenant's alone (forced RLS, the policy of 0009_studio).
alter table studio_olays enable row level security;
alter table studio_olays force row level security;
drop policy if exists tenant_isolation on studio_olays;
create policy tenant_isolation on studio_olays
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');
alter table studio_materials enable row level security;
alter table studio_materials force row level security;
drop policy if exists tenant_isolation on studio_materials;
create policy tenant_isolation on studio_materials
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');
alter table studio_piece_materials enable row level security;
alter table studio_piece_materials force row level security;
drop policy if exists tenant_isolation on studio_piece_materials;
create policy tenant_isolation on studio_piece_materials
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');
alter table studio_calendar_entries enable row level security;
alter table studio_calendar_entries force row level security;
drop policy if exists tenant_isolation on studio_calendar_entries;
create policy tenant_isolation on studio_calendar_entries
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');
alter table studio_shoot_requests enable row level security;
alter table studio_shoot_requests force row level security;
drop policy if exists tenant_isolation on studio_shoot_requests;
create policy tenant_isolation on studio_shoot_requests
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');
alter table studio_material_policy enable row level security;
alter table studio_material_policy force row level security;
drop policy if exists tenant_isolation on studio_material_policy;
create policy tenant_isolation on studio_material_policy
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');
alter table studio_material_releases enable row level security;
alter table studio_material_releases force row level security;
drop policy if exists tenant_isolation on studio_material_releases;
create policy tenant_isolation on studio_material_releases
    using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
           or current_setting('app.platform', true) = 'on')
    with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
                or current_setting('app.platform', true) = 'on');
