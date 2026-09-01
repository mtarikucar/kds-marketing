import { describe, it, expect } from 'vitest';
import { notificationRoute } from './notificationRoute';

/**
 * One case per kind a producer ACTUALLY emits (backend grep: TASK_ASSIGNED,
 * INACTIVE_LEAD, FOLLOW_UP_REMINDER, CONVERSATION_ASSIGNED, WORKFLOW,
 * COMMISSION_EARNED) plus the guard cases. The metadata literals below are
 * copied from the producers, not invented.
 */
describe('notificationRoute — kinds that are actually produced', () => {
  it('TASK_ASSIGNED goes to the task list, without inventing a per-task param', () => {
    const to = notificationRoute({ type: 'TASK_ASSIGNED', metadata: { taskId: 't1' } });
    expect(to).toBe('/tasks');
    // TasksPage reads only ?tab= — pin the choice not to fabricate ?task=.
    expect(to).not.toContain('t1');
  });

  it('INACTIVE_LEAD opens the lead', () => {
    expect(
      notificationRoute({ type: 'INACTIVE_LEAD', metadata: { leadId: 'l1', from: 'NEW', to: 'WON' } }),
    ).toBe('/leads/l1');
  });

  it('FOLLOW_UP_REMINDER opens the lead — scheduler shape', () => {
    expect(
      notificationRoute({
        type: 'FOLLOW_UP_REMINDER',
        metadata: { leadId: 'l1', dueAt: '2026-01-01T00:00:00.000Z' },
      }),
    ).toBe('/leads/l1');
  });

  it('FOLLOW_UP_REMINDER opens the lead — single-assign shape', () => {
    expect(
      notificationRoute({ type: 'FOLLOW_UP_REMINDER', metadata: { leadId: 'l1', assignedBy: 'u9' } }),
    ).toBe('/leads/l1');
  });

  it('FOLLOW_UP_REMINDER from bulkAssign falls back to the list — there is no singular leadId', () => {
    const to = notificationRoute({
      type: 'FOLLOW_UP_REMINDER',
      metadata: { leadIds: ['a', 'b'], assignedBy: 'u9', bulk: true },
    });
    // The case a flat type→path map would have turned into '/leads/undefined'.
    expect(to).toBe('/leads');
  });

  it('legacy settlement rows (still typed FOLLOW_UP_REMINDER) land on their referral lead', () => {
    expect(
      notificationRoute({
        type: 'FOLLOW_UP_REMINDER',
        metadata: { tenantId: 'tenant-1', leadId: 'l1', commissionAmount: '250' },
      }),
    ).toBe('/leads/l1');
  });

  it('COMMISSION_EARNED goes to /commissions only when the workspace is entitled', () => {
    const n = {
      type: 'COMMISSION_EARNED',
      metadata: { tenantId: 'tenant-1', leadId: 'l1', commissionAmount: '250' },
    };
    expect(notificationRoute(n, { hasCommissions: true })).toBe('/commissions');
    // /commissions is @RequiresFeature('commissions') on the backend: without
    // the add-on that page 403s, so the referral lead is the usable landing.
    expect(notificationRoute(n, { hasCommissions: false })).toBe('/leads/l1');
    expect(notificationRoute(n)).toBe('/leads/l1');
  });

  it('an unentitled COMMISSION_EARNED with no lead is a no-op rather than a 403 page', () => {
    expect(notificationRoute({ type: 'COMMISSION_EARNED', metadata: { tenantId: 't' } })).toBeNull();
  });

  it('CONVERSATION_ASSIGNED opens the person when the producer stamped leadId', () => {
    expect(
      notificationRoute({
        type: 'CONVERSATION_ASSIGNED',
        metadata: { conversationId: 'c1', leadId: 'l1', source: 'inbox' },
      }),
    ).toBe('/leads/l1');
  });

  it('CONVERSATION_ASSIGNED rows written before the producer change still open the inbox', () => {
    expect(
      notificationRoute({ type: 'CONVERSATION_ASSIGNED', metadata: { conversationId: 'c1', source: 'inbox' } }),
    ).toBe('/inbox');
  });

  it('WORKFLOW opens the lead the automation fired on', () => {
    expect(notificationRoute({ type: 'WORKFLOW', metadata: { leadId: 'l1' } })).toBe('/leads/l1');
  });

  it('WORKFLOW rows written before the producer stamped leadId are a no-op', () => {
    expect(notificationRoute({ type: 'WORKFLOW' })).toBeNull();
    expect(notificationRoute({ type: 'WORKFLOW', metadata: null })).toBeNull();
  });
});

describe('notificationRoute — guards', () => {
  it('an unknown type is a no-op, not a guess', () => {
    expect(notificationRoute({ type: 'SOMETHING_NEW', metadata: { leadId: 'l1' } })).toBeNull();
  });

  // Named in the schema comment on MarketingNotification.type but emitted by no
  // producer anywhere in the backend — mapping them would invent destinations
  // for kinds that do not exist.
  it.each(['DEMO_REMINDER', 'OFFER_EXPIRING', 'TASK_DUE'])('%s is never produced → no-op', (type) => {
    expect(notificationRoute({ type, metadata: { leadId: 'l1' } })).toBeNull();
  });

  it('a missing type is a no-op', () => {
    expect(notificationRoute({ metadata: { leadId: 'l1' } })).toBeNull();
    expect(notificationRoute({ type: null, metadata: { leadId: 'l1' } })).toBeNull();
  });

  it('non-object metadata never throws', () => {
    expect(notificationRoute({ type: 'INACTIVE_LEAD', metadata: 'leadId=l1' })).toBeNull();
    expect(notificationRoute({ type: 'INACTIVE_LEAD', metadata: ['l1'] })).toBeNull();
    expect(notificationRoute({ type: 'INACTIVE_LEAD', metadata: 42 })).toBeNull();
    expect(notificationRoute({ type: 'INACTIVE_LEAD' })).toBeNull();
  });

  // metadata is workflow/consumer-authored JSON and the result is handed to
  // navigate(): an id that is a path or a URL must not become one.
  it.each([
    '../../platform/workspaces',
    '/platform/workspaces',
    'https://evil.example',
    'l1?x=1',
    'a'.repeat(65),
    '',
  ])('rejects a leadId that is not id-shaped: %s', (leadId) => {
    expect(notificationRoute({ type: 'INACTIVE_LEAD', metadata: { leadId } })).toBeNull();
  });

  it('a non-string leadId is rejected', () => {
    expect(notificationRoute({ type: 'INACTIVE_LEAD', metadata: { leadId: 7 } })).toBeNull();
    expect(notificationRoute({ type: 'WORKFLOW', metadata: { leadId: { id: 'l1' } } })).toBeNull();
  });

  it('an empty leadIds array does not become the lead list', () => {
    expect(notificationRoute({ type: 'FOLLOW_UP_REMINDER', metadata: { leadIds: [], bulk: true } })).toBeNull();
  });
});
