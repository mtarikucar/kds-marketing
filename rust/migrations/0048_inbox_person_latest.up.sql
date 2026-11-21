-- The inbox's automatic replies stay out of a conversation a person wrote in (in the panel, an
-- author `{"human": …}`, or from the phone's WhatsApp Business app, `"business_app"`). This index
-- finds a conversation's latest such message in one indexed step, newest first, instead of reading
-- the conversation's latest messages. Additive: an index on an existing table, no new rows, no
-- policy change (`messages` keeps its row-level security). Repeatable.
create index if not exists messages_person_latest
    on messages (workspace_id, conversation_id, at desc, id desc)
    where author ? 'human' or author = '"business_app"'::jsonb;
