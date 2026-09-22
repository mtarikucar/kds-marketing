import * as fs from 'fs';
import * as path from 'path';
import { mockPrismaClient } from '../../../common/test/prisma-mock.service';
import { ConsentLedgerService } from './consent-ledger.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma = mockPrismaClient();
  (prisma.consentRecord.createMany as unknown as jest.Mock).mockResolvedValue({ count: 0 });
  return { prisma, svc: new ConsentLedgerService(prisma as any) };
}

describe('ConsentLedgerService', () => {
  it('writes one workspace-scoped row per lead', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.consentRecord.createMany as unknown as jest.Mock).mockResolvedValue({ count: 2 });

    const written = await svc.record({
      workspaceId: WS,
      leadIds: ['a', 'b'],
      type: 'MARKETING_EMAIL',
      granted: false,
      source: 'lead-token',
    });

    expect(written).toBe(2);
    expect(prisma.consentRecord.createMany).toHaveBeenCalledWith({
      data: [
        { workspaceId: WS, leadId: 'a', type: 'MARKETING_EMAIL', granted: false, source: 'lead-token', ipAddress: null },
        { workspaceId: WS, leadId: 'b', type: 'MARKETING_EMAIL', granted: false, source: 'lead-token', ipAddress: null },
      ],
    });
  });

  it('collapses duplicate and empty lead ids', async () => {
    // One physical click on an address held by the same lead twice is still one
    // withdrawal; N rows would read as N separate decisions.
    const { prisma, svc } = makeSvc();
    await svc.record({ workspaceId: WS, leadIds: ['a', 'a', '', null as any, 'b'], type: 'MARKETING_EMAIL', granted: true });
    const arg = (prisma.consentRecord.createMany as unknown as jest.Mock).mock.calls[0][0];
    expect(arg.data.map((r: any) => r.leadId)).toEqual(['a', 'b']);
  });

  it('writes nothing — and asks the database nothing — for an empty list', async () => {
    const { prisma, svc } = makeSvc();
    expect(await svc.record({ workspaceId: WS, leadIds: [], type: 'MARKETING_EMAIL', granted: false })).toBe(0);
    expect(prisma.consentRecord.createMany).not.toHaveBeenCalled();
  });

  it('writes nothing without a workspace', async () => {
    const { prisma, svc } = makeSvc();
    expect(await svc.record({ workspaceId: '', leadIds: ['a'], type: 'MARKETING_EMAIL', granted: false })).toBe(0);
    expect(prisma.consentRecord.createMany).not.toHaveBeenCalled();
  });

  it('uses the caller’s transaction when one is passed', async () => {
    const { prisma, svc } = makeSvc();
    const tx = { consentRecord: { createMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    await svc.record({ workspaceId: WS, leadIds: ['a'], type: 'MARKETING_EMAIL', granted: false }, tx as any);
    expect(tx.consentRecord.createMany).toHaveBeenCalled();
    expect(prisma.consentRecord.createMany).not.toHaveBeenCalled();
  });

  /**
   * `optout-per-lead-row`: the SMS branch of ComplianceService.recordConsent
   * appends an outbox row and an İYS job under its own idempotency key, so
   * calling it once per same-address lead enqueues N blacklist syncs and N İYS
   * jobs for ONE physical click. This service exists to be the side-effect-free
   * writer, and the guarantee is worth a static check.
   */
  it('touches nothing but consent_records — no outbox, no İYS, no flags', () => {
    const src = fs.readFileSync(path.join(__dirname, 'consent-ledger.service.ts'), 'utf8');
    expect(src).not.toMatch(/OutboxService|IysSyncService|iysSync|outbox\./);
    expect(src).not.toMatch(/\.lead\.|emailOptOut|smsOptOut|waOptOut/);
    const delegates = [...src.matchAll(/(?:prisma|db|tx)\.([a-zA-Z]+)\./g)].map((m) => m[1]);
    expect([...new Set(delegates)]).toEqual(['consentRecord']);
  });
});
