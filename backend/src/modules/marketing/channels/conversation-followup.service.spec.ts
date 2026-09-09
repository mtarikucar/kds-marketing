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
