import { describe, it, expect } from 'vitest';
import { CONFIG_TABS } from './InboxPage';
import { TASK_TABS } from '../tasks/TasksPage';

/**
 * `?tab=` is read by TWO pages, and they must never mean the same value.
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
 * The fix if this ever fails is NOT to edit the expectation: rename the
 * colliding value, or give one of the two pages a parameter of its own.
 */
describe('the ?tab= parameter, shared by two pages', () => {
  it('has two vocabularies that do not overlap', () => {
    // Positive anchor: both lists really arrived. An empty import would satisfy
    // an intersection assertion for entirely the wrong reason.
    expect(CONFIG_TABS.length).toBeGreaterThan(0);
    expect(TASK_TABS.length).toBeGreaterThan(0);

    const tasks = new Set<string>(TASK_TABS);
    expect(CONFIG_TABS.filter((t) => tasks.has(t))).toEqual([]);
  });

  it('still holds the values the rest of the app deep-links to', () => {
    // The two links in the wild, so a rename cannot pass this file by simply
    // emptying one of the lists.
    expect(TASK_TABS).toContain('overdue'); // dashboard hero + NeedsAttention
    expect(CONFIG_TABS).toContain('channels'); // the Inbox gear menu
  });
});
