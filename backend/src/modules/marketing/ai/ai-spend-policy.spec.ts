import { AI_CREDIT_COSTS } from './ai-credit-costs';
import {
  ACTION_CATEGORY,
  AI_SPEND_CATEGORIES,
  spendAllowed,
  uncategorisedActions,
} from './ai-spend-policy';

/**
 * A switch per job, and no job that cannot be switched off.
 *
 * Measured on this deployment over 90 days: $15.97 of AI spend, of which
 * research was $15.84 — 99% — while answering customers was $0.00 because it
 * never ran. A credit cap cannot express that: it stops everything at once,
 * after the money is gone, and cannot say which job spent it.
 */
describe('AI spend policy', () => {
  it('leaves NO metered action uncategorised', () => {
    // An action in no category is spend nobody can switch off — the exact hole
    // this feature exists to close. Named out loud rather than counted, so the
    // failure tells you which action to place.
    expect(uncategorisedActions()).toEqual([]);
  });

  it('claims every action it lists, and invents none', () => {
    // The reverse direction: a category listing an action that no longer
    // exists would render a switch for spend that cannot happen, and quietly
    // stop covering whatever replaced it.
    const priced = new Set(Object.keys(AI_CREDIT_COSTS));
    const listed = Object.values(AI_SPEND_CATEGORIES).flatMap((c) => [...c.actions]);
    expect(listed.filter((a) => !priced.has(a))).toEqual([]);
  });

  it('never files one action under two jobs', () => {
    // Double-counting would inflate a category's share of the bill and send
    // the owner to switch off the wrong one.
    const listed = Object.values(AI_SPEND_CATEGORIES).flatMap((c) => [...c.actions]);
    expect(listed).toHaveLength(new Set(listed).size);
  });

  it('defaults to ON, so upgrading changes nothing', () => {
    // No existing workspace may go quiet because a column was added.
    expect(spendAllowed(null, 'conversation.reply')).toBe(true);
    expect(spendAllowed(undefined, 'research.turn')).toBe(true);
    expect(spendAllowed({}, 'research.turn')).toBe(true);
    // A category present but not this one.
    expect(spendAllowed({ content: false }, 'research.turn')).toBe(true);
  });

  it('only an explicit false switches a job off', () => {
    expect(spendAllowed({ research: false }, 'research.turn')).toBe(false);
    expect(spendAllowed({ research: false }, 'research.native_search')).toBe(false);
    // Truthy-but-not-true values are not "off".
    expect(spendAllowed({ research: 0 }, 'research.turn')).toBe(true);
    expect(spendAllowed({ research: null }, 'research.turn')).toBe(true);
  });

  it('switching research off does not touch answering customers', () => {
    // The whole point: the expensive job stops, the customer-facing one does
    // not. These two must never share a switch.
    const policy = { research: false };
    expect(spendAllowed(policy, 'research.turn')).toBe(false);
    expect(spendAllowed(policy, 'conversation.reply')).toBe(true);
    expect(spendAllowed(policy, 'conversation.followup')).toBe(true);
    expect(ACTION_CATEGORY['research.turn']).not.toBe(ACTION_CATEGORY['conversation.reply']);
  });

  it('allows an action nobody has categorised yet', () => {
    // A new action must not be silently blocked in production. CI is where
    // that mistake belongs, and the first test above is the one that catches it.
    expect(spendAllowed({ research: false }, 'some.brand.new.action')).toBe(true);
    expect(spendAllowed({ research: false }, undefined)).toBe(true);
  });

  it('keeps the 99% job on its own switch', () => {
    // research was $15.84 of a $15.97 bill. If it ever shares a category with
    // something customer-facing, turning it off costs the customer.
    for (const action of ['research.turn', 'research.qualify', 'research.native_search', 'research.native_scrape']) {
      expect(ACTION_CATEGORY[action]).toBe('research');
    }
  });
});
