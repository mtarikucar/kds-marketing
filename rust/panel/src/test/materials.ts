import { inboxAnswers, inboxMe } from './inbox';
import { WS_ID } from './fixtures';

// Shared fixtures of the Materyaller screens: an owner with Studio permissions, and library rows
// in the server's serde shapes (`jt_studio`).

const day = 86400_000;
/** `YYYY-MM-DD`, `n` days from today (Istanbul). */
export function dayFrom(n: number): string {
  return new Date(Date.now() + n * day + 3 * 3600_000).toISOString().slice(0, 10);
}

export const studioMe = {
  ...inboxMe,
  memberships: [
    {
      ...inboxMe.memberships[0],
      permissions: [...inboxMe.memberships[0].permissions, 'materials.work', 'content.work', 'content.manage', 'social.work', 'social.manage', 'ads.work', 'ads.manage'],
    },
  ],
};
/** A member who works in Studio but is no owner or manager: no consent decisions. */
export const repMe = {
  ...inboxMe,
  memberships: [
    {
      ...inboxMe.memberships[0],
      role_key: 'rep',
      permissions: [...inboxMe.memberships[0].permissions.filter(p => !['content.manage', 'social.manage', 'ads.manage'].includes(p)), 'materials.work', 'content.work', 'social.work', 'ads.work'],
    },
  ],
};

export function olay(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    workspace_id: WS_ID,
    kind: 'workshop',
    title: `Olay ${id}`,
    starts_on: dayFrom(-1),
    ends_on: dayFrom(-1),
    place: null,
    client: null,
    notes: '',
    occasion: null,
    status: 'confirmed',
    confirmed: { by: 'u1', at: '2026-10-01T09:00:00Z' },
    revision: 1,
    created_at: '2026-10-01T09:00:00Z',
    ...patch,
  };
}

export function material(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    workspace_id: WS_ID,
    file_id: `file-${id}`,
    mime: 'image/jpeg',
    title: '',
    origin: { kind: 'real' },
    binding: { kind: 'olay', olay_id: 'o1' },
    freed: null,
    share: { permission: 'shareable', by: 'u1', at: '2026-10-02T09:00:00Z' },
    tags: { product_groups: ['figur'], doors: [], content_types: [], quality: 'publishable', depicts: [] },
    tags_reviewed_by: 'u1',
    people: [],
    captured_at: null,
    created_by: { kind: 'human', user_id: 'u1' },
    revision: 2,
    created_at: '2026-10-02T09:00:00Z',
    erased_at: null,
    ...patch,
  };
}

export function shoot(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    workspace_id: WS_ID,
    key: `human:${id}`,
    reason: { kind: 'requested' },
    text: `İstek ${id}`,
    week_start: dayFrom(0),
    status: 'open',
    created_by: { kind: 'human', user_id: 'u1' },
    created_at: '2026-10-02T09:00:00Z',
    resolved_by: null,
    resolved_at: null,
    ...patch,
  };
}

/** The Studio page's own reads, so a Materyaller test renders the page as it is. */
export const materialsAnswers = {
  ...inboxAnswers,
  'GET /api/auth/me': studioMe,
  'GET /api/capabilities': [],
  'GET /api/studio/ledger': { entries: [], next_before: null },
  'GET /api/studio/olays': [],
  'GET /api/studio/materials': [],
  'GET /api/studio/shoot-requests': [],
};
