-- TikTok and LinkedIn connect through OAuth: their started flows are pending connections, kept
-- under their provider and the app (redirect callback) they sign in with. Nothing else names a
-- provider in a CHECK that these adapters write (they receive no webhooks: inbound_events is
-- untouched). Re-running this file changes nothing.
alter table oauth_pending drop constraint if exists oauth_pending_provider_check;
alter table oauth_pending add constraint oauth_pending_provider_check
    check (provider in ('meta', 'netgsm', 'x', 'tiktok', 'linkedin'));
alter table oauth_pending drop constraint if exists oauth_pending_app_check;
alter table oauth_pending add constraint oauth_pending_app_check
    check (app in ('meta', 'instagram', 'x', 'tiktok', 'linkedin'));
