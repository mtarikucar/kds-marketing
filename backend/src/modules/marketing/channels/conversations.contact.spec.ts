import { ConversationsService } from './conversations.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

/**
 * WHICH ADDRESS DOES THIS THREAD ACTUALLY REACH?
 *
 * `Conversation.contactIdentityId` is the threading and dedup key: inbound mail
 * is matched to a thread by it, and an outbound reply leaves for it. It is also
 * free to drift from `lead.email` — a rep edits the lead, the thread keeps
 * mailing the address the customer wrote from — and until now nothing in the
 * API said so, so the composer showed the lead's address and the mail went
 * somewhere else.
 *
 * Both readers carry it: the list (the composer picks a thread from there) and
 * the thread itself. It is ONE batched query for the whole page, not one per
 * row, and it names the workspace like every other read in this service.
 */
describe('ConversationsService — the thread says which identity it reaches', () => {
  const WS = 'ws-1';
  let prisma: MockPrismaClient;
  let svc: ConversationsService;

  beforeEach(() => {
    prisma = mockPrismaClient();
    svc = new ConversationsService(prisma as any, {} as any, {} as any, {} as any);
    prisma.lead.findMany.mockResolvedValue([] as any);
    prisma.channel.findMany.mockResolvedValue([] as any);
    prisma.$queryRaw.mockResolvedValue([] as any);
    prisma.contactIdentity.findMany.mockResolvedValue([] as any);
  });

  describe('list()', () => {
    it('attaches the identity each thread reaches, in one workspace-scoped query', async () => {
      prisma.conversation.findMany.mockResolvedValue([
        { id: 'c1', leadId: 'l1', channelId: 'ch1', contactIdentityId: 'id-1' },
        { id: 'c2', leadId: 'l1', channelId: 'ch1', contactIdentityId: 'id-2' },
        // Same identity twice: the query must ask for it once.
        { id: 'c3', leadId: 'l2', channelId: 'ch1', contactIdentityId: 'id-1' },
      ] as any);
      prisma.contactIdentity.findMany.mockResolvedValue([
        { id: 'id-1', value: 'ali@acme.com', kind: 'EMAIL' },
        { id: 'id-2', value: '+905551112233', kind: 'PHONE' },
      ] as any);

      const rows: any[] = await svc.list(WS);

      expect(prisma.contactIdentity.findMany).toHaveBeenCalledTimes(1);
      const arg = prisma.contactIdentity.findMany.mock.calls[0][0] as any;
      expect(arg.where.workspaceId).toBe(WS);
      expect([...arg.where.id.in].sort()).toEqual(['id-1', 'id-2']);

      expect(rows[0].contact).toEqual({ value: 'ali@acme.com', kind: 'EMAIL' });
      expect(rows[1].contact).toEqual({ value: '+905551112233', kind: 'PHONE' });
      expect(rows[2].contact).toEqual({ value: 'ali@acme.com', kind: 'EMAIL' });
    });

    it('is null — never undefined — on a thread with no identity, and asks for nothing', async () => {
      prisma.conversation.findMany.mockResolvedValue([
        { id: 'c1', leadId: 'l1', channelId: 'ch1', contactIdentityId: null },
      ] as any);

      const rows: any[] = await svc.list(WS);

      // An `id: { in: [] }` would be a full-table read dressed as a filter.
      expect(prisma.contactIdentity.findMany).not.toHaveBeenCalled();
      expect(rows[0].contact).toBeNull();
    });

    it('is null when the identity row has gone, rather than omitting the key', async () => {
      prisma.conversation.findMany.mockResolvedValue([
        { id: 'c1', leadId: 'l1', channelId: 'ch1', contactIdentityId: 'id-gone' },
      ] as any);
      prisma.contactIdentity.findMany.mockResolvedValue([] as any);

      const rows: any[] = await svc.list(WS);
      expect(rows[0].contact).toBeNull();
    });
  });

  describe('thread()', () => {
    beforeEach(() => {
      prisma.message.findMany.mockResolvedValue([] as any);
      prisma.lead.findFirst.mockResolvedValue({ id: 'l1', email: 'lead@acme.com' } as any);
      prisma.channel.findFirst.mockResolvedValue({ id: 'ch1', type: 'EMAIL' } as any);
    });

    it('carries the identity beside the lead', async () => {
      prisma.conversation.findFirst.mockResolvedValue({
        id: 'c1',
        leadId: 'l1',
        channelId: 'ch1',
        contactIdentityId: 'id-1',
      } as any);
      prisma.contactIdentity.findFirst.mockResolvedValue({
        id: 'id-1',
        value: 'ali@acme.com',
        kind: 'EMAIL',
      } as any);

      const out: any = await svc.thread(WS, 'c1');

      expect(prisma.contactIdentity.findFirst.mock.calls[0][0]).toMatchObject({
        where: { id: 'id-1', workspaceId: WS },
      });
      expect(out.contact).toEqual({ value: 'ali@acme.com', kind: 'EMAIL' });
      // The lead's own address is untouched — the point is that the two can differ.
      expect(out.lead.email).toBe('lead@acme.com');
    });

    it('does not look one up for a thread that has none', async () => {
      prisma.conversation.findFirst.mockResolvedValue({
        id: 'c1',
        leadId: 'l1',
        channelId: 'ch1',
        contactIdentityId: null,
      } as any);

      const out: any = await svc.thread(WS, 'c1');
      expect(prisma.contactIdentity.findFirst).not.toHaveBeenCalled();
      expect(out.contact).toBeNull();
    });
  });
});
