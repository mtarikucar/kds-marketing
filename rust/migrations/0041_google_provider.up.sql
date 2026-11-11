-- Google Ads accounts connect through OAuth (design 2026-11-11-reklam-platformlari-design.md):
-- a started Google flow is a pending connection, kept under its provider and the app (redirect
-- callback) it signs in with. Nothing else names a provider in a CHECK that the Google adapter
-- writes (it receives no webhooks: inbound_events is untouched). Re-running this file changes
-- nothing.
alter table oauth_pending drop constraint if exists oauth_pending_provider_check;
alter table oauth_pending add constraint oauth_pending_provider_check
    check (provider in ('meta', 'netgsm', 'x', 'tiktok', 'linkedin', 'google'));
alter table oauth_pending drop constraint if exists oauth_pending_app_check;
alter table oauth_pending add constraint oauth_pending_app_check
    check (app in ('meta', 'instagram', 'x', 'tiktok', 'linkedin', 'google'));
