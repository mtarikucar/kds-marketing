import { describe, expect, it } from 'vitest';
import { DAY, HOUR, at, connection, key } from '@/test/agents';
import { perAgent } from './AgentsCard';

describe('the home page’s agents strip', () => {
  it('is one line per agent (its key), spoken for by its latest connection, never one per old client', () => {
    const content = key({ name: 'content-routine' });
    const codex = key({ name: 'codex' });
    const live = connection(content, { last_seen_at: at(-HOUR) });
    const old = connection(content, { client_name: 'ops', last_seen_at: at(-2 * DAY), overdue: true });
    const stale = [1, 2, 3].map((n) => connection(codex, { client_version: `0.6${n}.0`, last_seen_at: at(-n * 10 * DAY), overdue: true }));
    const lines = perAgent([old, ...stale, live]);
    expect(lines.map((l) => l.agent)).toEqual([live, stale[0]]);
    expect(lines[0].ids.sort()).toEqual([live.id, old.id].sort());
    // The agent on time is not "late" because an old connection of its key is.
    expect(lines[0].agent.overdue).toBe(false);
  });
});
