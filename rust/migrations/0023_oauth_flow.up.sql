-- WhatsApp Business app coexistence (spec 2026-11-03-whatsapp-coexistence-design.md, D3): a
-- started flow keeps the variant of its app's sign-in it runs, from its start to its completion,
-- so the provider's callback exchanges the code and lists the assets as that variant needs.
-- `null` is the app's own sign-in (every flow before this migration); `whatsapp_business_app` is
-- Meta's Embedded Signup for a number already in the WhatsApp Business app. Repeatable: the
-- column is added once, the check is replaced by name.
alter table oauth_pending add column if not exists flow text;
alter table oauth_pending drop constraint if exists oauth_pending_flow_check;
alter table oauth_pending add constraint oauth_pending_flow_check
    check (flow is null or flow in ('whatsapp_business_app'));
