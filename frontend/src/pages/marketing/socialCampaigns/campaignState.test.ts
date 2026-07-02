import { describe, it, expect } from 'vitest';
import { deriveCampaignState } from './campaignState';

const NOW = new Date('2026-07-10T12:00:00Z');
const future = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString();
const past = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const item = (status: string, scheduledFor: string) => ({ status, scheduledFor }) as any;

describe('deriveCampaignState', () => {
  it('DRAFT → phase draft, empty counts', () => {
    const s = deriveCampaignState({ status: 'DRAFT', planningMode: 'AI_FULL' }, [], NOW);
    expect(s.phase).toBe('draft');
    expect(s.total).toBe(0);
    expect(s.publishedPct).toBe(0);
  });

  it('ACTIVE with no items yet → planning (background composing first slot)', () => {
    const s = deriveCampaignState({ status: 'ACTIVE', planningMode: 'AI_FULL' }, [], NOW);
    expect(s.phase).toBe('planning');
  });

  it('AI_PROPOSE with PLANNED items → awaiting_confirm (needs the user to confirm)', () => {
    const s = deriveCampaignState(
      { status: 'ACTIVE', planningMode: 'AI_PROPOSE' },
      [item('PLANNED', future(24)), item('PLANNED', future(48))],
      NOW,
    );
    expect(s.phase).toBe('awaiting_confirm');
    expect(s.awaitingConfirm).toBe(true);
  });

  it('PLANNED items but NOT AI_PROPOSE → generating (queued to create), not running', () => {
    const s = deriveCampaignState({ status: 'ACTIVE', planningMode: 'AI_FULL' }, [item('PLANNED', future(24))], NOW);
    expect(s.awaitingConfirm).toBe(false);
    // A PLANNED slot is pre-generation work — must read as "creating", never as
    // "running smoothly" (which would hide a stalled generation pipeline).
    expect(s.phase).toBe('generating');
  });

  it('AI_PROPOSE: a pending review is NOT masked by a freshly proposed PLANNED slot', () => {
    // AI_PROPOSE + APPROVAL: item0 already reviewed→NEEDS_APPROVAL while planTick
    // mints item1 as PLANNED. The hero must surface the review, not a Confirm-plan
    // CTA that cannot resolve it.
    const s = deriveCampaignState(
      { status: 'ACTIVE', planningMode: 'AI_PROPOSE' },
      [item('NEEDS_APPROVAL', future(2)), item('PLANNED', future(24))],
      NOW,
    );
    expect(s.phase).toBe('needs_approval');
    expect(s.awaitingConfirm).toBe(false);
  });

  it('AI_PROPOSE: active generation is NOT masked by a freshly proposed PLANNED slot', () => {
    const s = deriveCampaignState(
      { status: 'ACTIVE', planningMode: 'AI_PROPOSE' },
      [item('GENERATING', future(2)), item('PLANNED', future(24))],
      NOW,
    );
    expect(s.phase).toBe('generating');
    expect(s.awaitingConfirm).toBe(false);
  });

  it('needs_approval takes priority over generating', () => {
    const s = deriveCampaignState(
      { status: 'ACTIVE', planningMode: 'AI_FULL' },
      [item('NEEDS_APPROVAL', future(2)), item('GENERATING', future(4))],
      NOW,
    );
    expect(s.phase).toBe('needs_approval');
    expect(s.needsApproval).toBe(1);
    expect(s.generating).toBe(1);
  });

  it('all scheduled/published upcoming → running with the earliest next post', () => {
    const s = deriveCampaignState(
      { status: 'ACTIVE', planningMode: 'AI_FULL' },
      [item('PUBLISHED', past(24)), item('SCHEDULED', future(48)), item('SCHEDULED', future(6))],
      NOW,
    );
    expect(s.phase).toBe('running');
    expect(s.nextScheduledFor).toBe(future(6)); // earliest upcoming, ignoring the far one
    expect(s.published).toBe(1);
  });

  it('nextScheduledFor ignores PAST and terminal items', () => {
    const s = deriveCampaignState(
      { status: 'ACTIVE', planningMode: 'AI_FULL' },
      [item('SCHEDULED', past(2)), item('FAILED', future(1)), item('SCHEDULED', future(10))],
      NOW,
    );
    // past scheduled + failed(future) excluded → the future SCHEDULED is next
    expect(s.nextScheduledFor).toBe(future(10));
  });

  it('counts + publishedPct are accurate', () => {
    const s = deriveCampaignState(
      { status: 'ACTIVE', planningMode: 'AI_FULL' },
      [item('PUBLISHED', past(1)), item('PUBLISHED', past(2)), item('SCHEDULED', future(1)), item('FAILED', past(3))],
      NOW,
    );
    expect(s.counts.PUBLISHED).toBe(2);
    expect(s.counts.FAILED).toBe(1);
    expect(s.total).toBe(4);
    expect(s.publishedPct).toBe(50); // 2/4
    expect(s.inFlight).toBe(1); // only the SCHEDULED
    expect(s.failed).toBe(1);
  });

  it('SKIPPED is excluded from the progress denominator so the bar can reach 100%', () => {
    const s = deriveCampaignState(
      { status: 'ACTIVE', planningMode: 'AI_FULL' },
      [item('PUBLISHED', past(1)), item('PUBLISHED', past(2)), item('SKIPPED', past(3))],
      NOW,
    );
    expect(s.total).toBe(3);
    expect(s.skipped).toBe(1);
    expect(s.publishableTotal).toBe(2); // total − skipped
    expect(s.publishedPct).toBe(100); // 2 published of 2 publishable
  });

  it('PAUSED / CANCELLED / COMPLETED map straight through', () => {
    expect(deriveCampaignState({ status: 'PAUSED', planningMode: 'AI_FULL' }, [], NOW).phase).toBe('paused');
    expect(deriveCampaignState({ status: 'CANCELLED', planningMode: 'AI_FULL' }, [], NOW).phase).toBe('cancelled');
    expect(deriveCampaignState({ status: 'COMPLETED', planningMode: 'AI_FULL' }, [], NOW).phase).toBe('completed');
  });
});
