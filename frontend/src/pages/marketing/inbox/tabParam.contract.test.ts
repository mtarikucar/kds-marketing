import { describe, it, expect } from 'vitest';
import { CONFIG_TABS } from './InboxPage';
import { TASK_TABS } from '../tasks/TasksPage';
import { CALLS_TABS } from '../CallsPage';

/**
 * `?tab=` is read by THREE pages, and they must never mean the same value.
 *
 * InboxPage reads it as a config surface (`channels|snippets|agents|knowledge`)
 * and swaps the WHOLE surface for that page. The Görevler view of that same
 * surface is TasksPage, which reads `?tab=` as a task filter
 * (`all|today|overdue`) — and the dashboard hands out `/tasks?tab=overdue`
 * links that land on it.
 *
 * They do not collide today for two independent reasons, and only one of them
 * is a design: the config branch replaces the surface, so the two are never
 * mounted together; and the value sets happen to be disjoint. InboxPage's own
 * docstring calls the second one "a coincidence of two vocabularies, not a
 * design, and the next value added to either side is where it stops being
 * true."
 *
 * This is that sentence, enforced. Add `today` to the config surfaces (a
 * plausible name for a config page nobody has written yet) and
 * `/tasks?tab=today` from the dashboard would open it instead of the overdue
 * filter — a deep link quietly opening the wrong page, with no type error and
 * no other failing test anywhere in the repo.
 *
 * CallsPage is the THIRD reader as of 2026-09-01: `calls|dialer|voice` on its
 * own `/calls` route. It is also the one page that, when EMBEDDED in the Inbox's
 * left column, writes no parameter at all — the tab becomes local state there,
 * precisely because a third writer on one URL would end the coincidence above.
 * Its vocabulary is pinned here anyway: the standalone route still reads
 * `?tab=`, and a rename that collided with either of the others would send a
 * `/calls?tab=…` deep link to the wrong view.
 *
 * The fix if this ever fails is NOT to edit the expectation: rename the
 * colliding value, or give one of the three pages a parameter of its own.
 */
describe('the ?tab= parameter, shared by three pages', () => {
  it('has three vocabularies, pairwise disjoint', () => {
    // Positive anchor: all three lists really arrived. An empty import would
    // satisfy an intersection assertion for entirely the wrong reason.
    expect(CONFIG_TABS.length).toBeGreaterThan(0);
    expect(TASK_TABS.length).toBeGreaterThan(0);
    expect(CALLS_TABS.length).toBeGreaterThan(0);

    const pairs: Array<[string, readonly string[], string, readonly string[]]> = [
      ['config', CONFIG_TABS, 'tasks', TASK_TABS],
      ['config', CONFIG_TABS, 'calls', CALLS_TABS],
      ['tasks', TASK_TABS, 'calls', CALLS_TABS],
    ];
    for (const [, left, , right] of pairs) {
      const other = new Set<string>(right);
      expect(left.filter((t) => other.has(t))).toEqual([]);
    }
  });

  it('still holds the values the rest of the app deep-links to', () => {
    // The links in the wild, so a rename cannot pass this file by simply
    // emptying one of the lists.
    expect(TASK_TABS).toContain('overdue'); // dashboard hero + NeedsAttention
    expect(CONFIG_TABS).toContain('channels'); // the Inbox gear menu
    expect(CALLS_TABS).toContain('dialer'); // the Power Dialer deep link
  });
});
