# Epic B4 — Slack notifications — design

**Date:** 2026-06-16 · autonomous (no-ask) · independent off main

## Goal
Slack notifications via **incoming webhooks (no OAuth)**. `SlackIntegration`
(webhookUrl + subscribed events + status). `SlackService` subscribes to a
whitelist of domain events (lead.created/converted, form.submitted,
booking.created) on the DomainEventBus and POSTs a formatted message to each
ACTIVE integration whose `events` matches (best-effort, never throws into the bus).
Management `/marketing/integrations/slack` (OWNER/MANAGER); webhook URL never
echoed back; a test-message action.

## Testing
Unit: fanOut posts/skip/no-workspace; create masks URL. E2E: create (masked),
test message, REP-forbidden. Full suite green (633 unit + 58 e2e).
