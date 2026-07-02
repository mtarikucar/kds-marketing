import { BadRequestException } from '@nestjs/common';
import { AgentProfileService } from './agent-profile.service';

/**
 * The Agent Studio pause/resume control PATCHes only `{ status }`. toData() must
 * treat that as a partial update and leave every other field UNTOUCHED — a prior
 * bug defaulted omitted scalars to null/'tr', so a routine pause toggle wiped the
 * agent's tone/goals/guardrails, reset its language, and unlinked its calendar.
 */
describe('AgentProfileService', () => {
  const WS = 'ws-1';
  let prisma: any;
  let entitlements: any;
  let svc: AgentProfileService;

  beforeEach(() => {
    prisma = {
      agentProfile: {
        findFirst: jest.fn().mockResolvedValue({ id: 'a1' }),
        update: jest.fn().mockResolvedValue({ id: 'a1' }),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockImplementation(async ({ data }: any) => ({ id: 'a1', ...data })),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ locked: 'x' }]),
      $transaction: jest.fn().mockImplementation(async (fn: any) => fn(prisma)),
    };
    entitlements = { getEffective: jest.fn().mockResolvedValue({ limits: { maxAgents: -1 } }) };
    svc = new AgentProfileService(prisma as any, entitlements as any);
  });

  // A bare count-then-create lets two concurrent requests at (limit-1) BOTH pass the
  // cap and exceed maxAgents. create() serializes the check under a per-workspace
  // advisory xact-lock (the ai-credits / message-quota / research quota pattern).
  describe('create — quota-race safety', () => {
    const DTO = { name: 'A', persona: 'P' } as any;
    it('serializes the count-check + create under a per-workspace advisory lock', async () => {
      entitlements.getEffective.mockResolvedValue({ limits: { maxAgents: 3 } });
      prisma.agentProfile.count.mockResolvedValue(2);
      await svc.create(WS, DTO);
      expect(prisma.$transaction).toHaveBeenCalled();
      const lockSql = prisma.$queryRawUnsafe.mock.calls[0][0] as string;
      expect(lockSql).toContain('pg_advisory_xact_lock');
      expect(lockSql).toContain('agent-profiles:ws-1');
      expect(prisma.agentProfile.create).toHaveBeenCalled();
    });

    it('rejects at the cap without creating (checked inside the lock)', async () => {
      entitlements.getEffective.mockResolvedValue({ limits: { maxAgents: 3 } });
      prisma.agentProfile.count.mockResolvedValue(3);
      await expect(svc.create(WS, DTO)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.agentProfile.create).not.toHaveBeenCalled();
    });

    it('skips the lock/count on an unlimited (-1) plan', async () => {
      await svc.create(WS, DTO); // default maxAgents: -1
      expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
      expect(prisma.agentProfile.create).toHaveBeenCalled();
    });
  });

  it('a status-only PATCH does NOT overwrite unspecified config fields', async () => {
    await svc.update(WS, 'a1', { status: 'PAUSED' });
    const data = prisma.agentProfile.update.mock.calls[0][0].data;
    expect(data.status).toBe('PAUSED');
    // Omitted from the PATCH → must be ABSENT (left untouched), not null/'tr'.
    for (const k of ['tone', 'goals', 'guardrails', 'language', 'bookingCalendarId', 'name', 'persona']) {
      expect(data).not.toHaveProperty(k);
    }
  });

  it('still updates the fields that ARE provided in a partial PATCH', async () => {
    await svc.update(WS, 'a1', { tone: 'formal', language: 'en' });
    const data = prisma.agentProfile.update.mock.calls[0][0].data;
    expect(data.tone).toBe('formal');
    expect(data.language).toBe('en');
    expect(data).not.toHaveProperty('goals');
  });

  it('create applies defaults (language tr, nullable scalars null)', async () => {
    await svc.create(WS, { name: 'A', persona: 'P' } as any);
    const data = prisma.agentProfile.create.mock.calls[0][0].data;
    expect(data.language).toBe('tr');
    expect(data.tone).toBeNull();
    expect(data.bookingCalendarId).toBeNull();
  });
});
