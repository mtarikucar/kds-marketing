import { describe, it, expect } from 'vitest';
import { TRIGGER_TYPES } from './constants';

/**
 * `builder-link-clicked`. This array is a hand-kept mirror of the backend's
 * `TRIGGER_TYPES` (workflow-dsl.schema.ts). When the two drift, a workflow the
 * AI drafter or the API accepted becomes uneditable in the builder — the Select
 * has no matching item, so opening it silently shows a blank trigger and saving
 * rewrites it to something else.
 *
 * So the expected set is spelled out in full rather than derived: a new backend
 * trigger type fails HERE, loudly, instead of quietly disappearing from the UI.
 */
const BACKEND_TRIGGER_TYPES = [
  'lead.created',
  'lead.status_changed',
  'form.submitted',
  'conversation.message.received',
  'booking.created',
  'review.received',
  'task.completed',
  'tag.added',
  'opportunity.created',
  'opportunity.stage_changed',
  'opportunity.won',
  'opportunity.lost',
  'link.clicked',
  'webhook.received',
  'certificate.issued',
  'voice_keypress',
  'email.opened',
  'email.clicked',
  'email.unsubscribed',
];

describe('TRIGGER_TYPES', () => {
  it('offers every trigger type the backend accepts', () => {
    expect([...TRIGGER_TYPES].sort()).toEqual([...BACKEND_TRIGGER_TYPES].sort());
  });

  it('offers link.clicked, so a trigger-link automation can be built and edited', () => {
    expect(TRIGGER_TYPES).toContain('link.clicked');
  });

  // The engagement triggers shipped on the backend in the same wave as the
  // honest open/click filter; without them a workflow saved from the API or by
  // the AI drafter opens blank here and a save rewrites its trigger away.
  it('offers the campaign email engagement triggers', () => {
    expect(TRIGGER_TYPES).toContain('email.opened');
    expect(TRIGGER_TYPES).toContain('email.clicked');
    expect(TRIGGER_TYPES).toContain('email.unsubscribed');
  });

  // `email.bounced` exists nowhere on the backend: no writer emits it, so a
  // picker entry would be a trigger that can never fire.
  it('does not offer email.bounced, which has no emitter', () => {
    expect(TRIGGER_TYPES).not.toContain('email.bounced');
  });

  it('has no duplicates (a duplicate key crashes the Select)', () => {
    expect(new Set(TRIGGER_TYPES).size).toBe(TRIGGER_TYPES.length);
  });
});
