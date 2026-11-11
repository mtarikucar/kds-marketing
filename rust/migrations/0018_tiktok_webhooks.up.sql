-- TikTok webhooks (spec 2026-10-27-tiktok-linkedin-connectors-design.md §2, "Webhooks"): the
-- events TikTok sends to /hooks/tiktok (authorization.removed, post.publish.*) are stored as
-- inbound events under their provider, `tiktok`, beside Meta's, NetGSM's, X's and the mailboxes'.
-- Nothing else changes: the events reuse the table, its once-per-provider-id key, its
-- append-only guard and its raw-body purge. Repeatable: the constraint is dropped if it exists
-- and added again.
alter table inbound_events drop constraint if exists inbound_events_provider_check;
alter table inbound_events add constraint inbound_events_provider_check
    check (provider in ('meta', 'netgsm', 'x', 'mail', 'tiktok'));
