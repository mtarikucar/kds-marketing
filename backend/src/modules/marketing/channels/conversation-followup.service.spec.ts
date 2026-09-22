import { ConversationFollowupService, FOLLOWUP_KIND } from './conversation-followup.service';

/**
 * The half of a sale that happens when nobody writes back.
 *
 * A customer asks, gets a good answer, and goes quiet. No inbound-driven lane
 * ever fires for them again — `onInbound` waits for a message that is not
 * coming, and the backfill sweep only looks at threads where the CUSTOMER spoke
 * last. So the deal ends in silence, on our side, by default.
 */
describe('ConversationFollowupService', () => {
  const WS = 'ws-1';
  const CONVO = 'convo-1';

  function build(over: any = {}) {
    const prisma: any = {
      conversation: {
        findFirst: jest.fn(async () =>
          over.convo === null
            ? null
            : { channelId: 'ch-1', followupCount: 0, status: 'OPEN', aiPaused: false, ...over.convo },
        ),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      channel: {
        findFirst: jest.fn(async () =>
          over.channel === null ? null : { agentProfileId: 'agent-1', ...over.channel },
        ),
      },
      agentProfile: {
        findFirst: jest.fn(async () =>
          over.agent === null ? null : { followup: over.followup ?? null },
        ),
      },
      // No send window, which is every workspace today: the nudge lands at the
      // agent-chosen distance and nothing clamps it.
      workspace: {
        findUnique: jest.fn(async () =>
          over.workspace === null ? null : { settings: null, timezone: null, ...over.workspace },
        ),
      },
    };
    const scheduledJobs = {
      schedule: jest.fn(async () => 'job-1'),
      cancel: jest.fn(async () => true),
    };
    return { prisma, scheduledJobs, svc: new ConversationFollowupService(prisma, scheduledJobs as any) };
  }

  const CHASES = { enabled: true, afterHours: 24, maxFollowups: 2 };

  describe('policyFor', () => {
    it('is off unless the agent says otherwise', () => {
      const { svc } = build();
      expect(svc.policyFor(null)).toBeNull();
      expect(svc.policyFor({ followup: null })).toBeNull();
      expect(svc.policyFor({ followup: { enabled: false, afterHours: 24, maxFollowups: 3 } })).toBeNull();
    });

    it('clamps a policy that would pester or never fire', () => {
      const { svc } = build();
      // A week is the ceiling and an hour the floor; five nudges is as far as
      // following up goes before it is something else.
      expect(svc.policyFor({ followup: { enabled: true, afterHours: 9999, maxFollowups: 99 } })).toEqual({
        enabled: true,
        afterHours: 168,
        maxFollowups: 5,
      });
      expect(svc.policyFor({ followup: { enabled: true, afterHours: 0, maxFollowups: 1 } })?.afterHours).toBe(24);
    });
  });

  describe('scheduleNext', () => {
    it('queues the nudge at the agent-chosen distance', async () => {
      const { svc, scheduledJobs } = build({ followup: CHASES });
      const before = Date.now();
      expect(await svc.scheduleNext(WS, CONVO)).toBe(true);
      const arg = scheduledJobs.schedule.mock.calls[0][0];
      expect(arg).toMatchObject({ workspaceId: WS, kind: FOLLOWUP_KIND, dedupKey: CONVO });
      expect(arg.runAt.getTime()).toBeGreaterThanOrEqual(before + 23 * 3600_000);
    });

    /**
     * A nudge is the proactive CONVERSATIONAL lane, which the gate matrix marks
     * quiet-hours-bound — but the reply path deliberately does not run through
     * the gateway, so the schedule is the only place the window can be applied
     * (`no-send-window`). The clamp is at queue time, never at send time: a
     * deferral there would re-run the whole generation.
     */
    it('pushes a nudge that would land at 03:00 to the next opening of the window', async () => {
      const { svc, scheduledJobs } = build({
        followup: CHASES,
        workspace: { settings: { email: { sendWindow: { from: 9, to: 21 } } }, timezone: 'Europe/Istanbul' },
      });
      // 24h from 03:30 local is 03:30 local, which is outside 09:00-21:00.
      jest.useFakeTimers().setSystemTime(new Date('2027-03-10T00:30:00.000Z'));
      try {
        expect(await svc.scheduleNext(WS, CONVO)).toBe(true);
        const at: Date = scheduledJobs.schedule.mock.calls[0][0].runAt;
        const localHour = Number(
          new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Istanbul', hour: '2-digit', hour12: false }).format(at),
        ) % 24;
        expect(localHour).toBe(9);
        // Never earlier than the policy asked for — a clamp may delay a nudge,
        // never bring it forward onto a customer who has just been answered.
        expect(at.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
      } finally {
        jest.useRealTimers();
      }
    });

    it('leaves a nudge that already lands inside the window exactly where it was', async () => {
      const { svc, scheduledJobs } = build({
        followup: CHASES,
        workspace: { settings: { email: { sendWindow: { from: 9, to: 21 } } }, timezone: 'Europe/Istanbul' },
      });
      jest.useFakeTimers().setSystemTime(new Date('2027-03-10T09:00:00.000Z')); // 12:00 local
      try {
        await svc.scheduleNext(WS, CONVO);
        const at: Date = scheduledJobs.schedule.mock.calls[0][0].runAt;
        expect(at.getTime()).toBe(Date.now() + 24 * 3600_000);
      } finally {
        jest.useRealTimers();
      }
    });

    it('never lets the window read stop a nudge being queued', async () => {
      const { svc, prisma, scheduledJobs } = build({ followup: CHASES });
      prisma.workspace.findUnique.mockRejectedValue(new Error('pool timeout'));
      expect(await svc.scheduleNext(WS, CONVO)).toBe(true);
      expect(scheduledJobs.schedule).toHaveBeenCalled();
    });

    it('resolves the agent itself when the caller has only a conversation', async () => {
      // The connector lane holds a conversation id and nothing else. Making it
      // fetch the channel and the profile first would put the same three
      // queries in two places and let them drift.
      const { svc, prisma } = build({ followup: CHASES });
      await svc.scheduleNext(WS, CONVO);
      expect(prisma.channel.findFirst).toHaveBeenCalled();
      expect(prisma.agentProfile.findFirst).toHaveBeenCalled();
    });

    it('takes the agent the caller already has, without re-reading it', async () => {
      const { svc, prisma, scheduledJobs } = build();
      await svc.scheduleNext(WS, CONVO, { followup: CHASES });
      expect(prisma.channel.findFirst).not.toHaveBeenCalled();
      expect(scheduledJobs.schedule).toHaveBeenCalled();
    });

    it('stops at the allowance instead of queueing a nudge that will be dropped', async () => {
      // A job scheduled past the cap sits in the queue for hours and is then
      // thrown away on arrival — which reads as a pending nudge to anyone
      // looking at the queue, and is not one.
      const { svc, scheduledJobs } = build({ followup: CHASES, convo: { followupCount: 2 } });
      expect(await svc.scheduleNext(WS, CONVO)).toBe(false);
      expect(scheduledJobs.schedule).not.toHaveBeenCalled();
    });

    it('does not chase for an agent that does not chase', async () => {
      const { svc, scheduledJobs } = build({ followup: { enabled: true, afterHours: 24, maxFollowups: 0 } });
      expect(await svc.scheduleNext(WS, CONVO)).toBe(false);
      expect(scheduledJobs.schedule).not.toHaveBeenCalled();
    });

    it('leaves a closed thread, a paused one, and one with no agent alone', async () => {
      for (const over of [
        { convo: { status: 'CLOSED' } },
        { convo: { aiPaused: true } },
        { channel: null },
        { agent: null },
      ]) {
        const { svc, scheduledJobs } = build({ followup: CHASES, ...over });
        expect(await svc.scheduleNext(WS, CONVO)).toBe(false);
        expect(scheduledJobs.schedule).not.toHaveBeenCalled();
      }
    });

    it('treats a duplicate as one nudge already waiting, not a failure', async () => {
      const { svc, scheduledJobs } = build({ followup: CHASES });
      scheduledJobs.schedule.mockRejectedValue(new Error('duplicate dedupKey'));
      await expect(svc.scheduleNext(WS, CONVO)).resolves.toBe(false);
    });
  });

  it('cancels the nudge when the customer writes back', async () => {
    const { svc, scheduledJobs } = build();
    await svc.cancelFor(CONVO);
    expect(scheduledJobs.cancel).toHaveBeenCalledWith(FOLLOWUP_KIND, CONVO);
  });

  it('counts a nudge with an increment, not a read-then-write', async () => {
    // Two lanes can complete work on the same conversation; a count computed
    // from a stale read would lose one and chase the customer an extra time.
    const { svc, prisma } = build();
    await svc.countFollowup(WS, CONVO);
    expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: CONVO, workspaceId: WS },
      data: { followupCount: { increment: 1 } },
    });
  });
});
