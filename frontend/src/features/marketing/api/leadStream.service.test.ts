import { describe, it, expect, vi, beforeEach } from 'vitest';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('./marketingApi', () => ({ default: { get } }));

import { getLeadStream } from './leadStream.service';

/**
 * The URL is the whole service. `marketingApi` already carries
 * `${API_URL}/marketing` as its baseURL, so the path here is the tail only —
 * and the backend deliberately named the route `/timeline`, NOT `/stream`,
 * because this API already has a `/stream` and it is Server-Sent Events
 * (lead-stream.service.ts's own note). A component cannot catch that mistake:
 * a wrong tail 404s into the same "Akış yüklenemedi." the component would show
 * for any other failure.
 */
describe('getLeadStream', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockResolvedValue({
      data: { leadId: 'l1', items: [], unread: [], truncated: [], gated: [] },
    });
  });

  it('reads THIS lead’s timeline, not the SSE /stream route', async () => {
    await getLeadStream('l1');
    expect(get).toHaveBeenCalledWith('/leads/l1/timeline');
  });

  it('returns the response body unwrapped', async () => {
    get.mockResolvedValue({
      data: { leadId: 'l9', items: [], unread: ['mesajlar'], truncated: [], gated: ['mesajlar'] },
    });
    await expect(getLeadStream('l9')).resolves.toEqual({
      leadId: 'l9',
      items: [],
      unread: ['mesajlar'],
      truncated: [],
      gated: ['mesajlar'],
    });
  });
});
