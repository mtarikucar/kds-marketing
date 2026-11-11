-- A TikTok ad account connects through TikTok's API for Business, with another app than the one
-- TikTok accounts post through (design 2026-11-11-reklam-platformlari-design.md §3.3): a started
-- flow of it is a pending connection kept under the provider `tiktok` and the app (redirect
-- callback) `tiktok_ads`. Only the app CHECK changes; the provider was already allowed.
-- Re-running this file changes nothing.
alter table oauth_pending drop constraint if exists oauth_pending_app_check;
alter table oauth_pending add constraint oauth_pending_app_check
    check (app in ('meta', 'instagram', 'x', 'tiktok', 'linkedin', 'google', 'tiktok_ads'));
