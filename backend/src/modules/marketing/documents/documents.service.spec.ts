import { NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { DocumentsService } from './documents.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

describe('DocumentsService', () => {
  let prisma: MockPrismaClient;
  let svc: DocumentsService;
  const WS = 'ws-1';

  beforeEach(() => {
    prisma = mockPrismaClient();
    svc = new DocumentsService(prisma as any);
  });

  describe('update', () => {
    it('refuses to edit a non-draft document', async () => {
      prisma.document.findFirst.mockResolvedValue({ id: 'd1', status: 'SENT' } as any);
      await expect(svc.update(WS, 'd1', { title: 'x' } as any)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('rejects attaching a FOREIGN/unknown lead on edit (mirrors create()\'s ownership check)', async () => {
      prisma.document.findFirst.mockResolvedValue({ id: 'd1', status: 'DRAFT' } as any);
      prisma.lead.findFirst.mockResolvedValue(null as any); // not in this workspace
      await expect(svc.update(WS, 'd1', { leadId: 'foreign-lead' } as any)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.document.update).not.toHaveBeenCalled();
    });

    it('attaches an in-workspace lead, and allows clearing it (null)', async () => {
      prisma.document.findFirst.mockResolvedValue({ id: 'd1', status: 'DRAFT' } as any);
      prisma.lead.findFirst.mockResolvedValue({ id: 'l1' } as any);
      (prisma.document.update as jest.Mock).mockResolvedValue({ id: 'd1' });
      await svc.update(WS, 'd1', { leadId: 'l1' } as any);
      expect((prisma.document.update as jest.Mock).mock.calls[0][0].data).toMatchObject({ leadId: 'l1' });

      // Clearing (explicit null) skips the lookup and writes null.
      (prisma.lead.findFirst as jest.Mock).mockClear();
      await svc.update(WS, 'd1', { leadId: null } as any);
      expect(prisma.lead.findFirst).not.toHaveBeenCalled();
      expect((prisma.document.update as jest.Mock).mock.calls[1][0].data).toMatchObject({ leadId: null });
    });
  });

  describe('send', () => {
    it('freezes the body + consent snapshot and mints a token (DRAFT→SENT, scoped)', async () => {
      prisma.document.findFirst.mockResolvedValue({ id: 'd1', status: 'DRAFT', body: 'Terms…' } as any);
      prisma.document.updateMany.mockResolvedValue({ count: 1 } as any);

      const res = await svc.send(WS, 'd1');

      const arg = prisma.document.updateMany.mock.calls[0][0] as any;
      expect(arg.where).toEqual({ id: 'd1', workspaceId: WS, status: 'DRAFT' });
      expect(arg.data.status).toBe('SENT');
      expect(arg.data.bodySnapshot).toBe('Terms…'); // frozen from body
      expect(arg.data.consentStatement).toContain('electronic signature');
      expect(arg.data.publicToken).toMatch(/^esign_/);
      expect(res.publicToken).toMatch(/^esign_/);
    });

    it('returns the existing token when already SENT (no re-send)', async () => {
      prisma.document.findFirst.mockResolvedValue({ id: 'd1', status: 'SENT', publicToken: 'esign_x' } as any);
      const res = await svc.send(WS, 'd1');
      expect(res).toEqual({ status: 'SENT', publicToken: 'esign_x' });
      expect(prisma.document.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('void / remove', () => {
    it('refuses to void a signed document', async () => {
      prisma.document.findFirst.mockResolvedValue({ id: 'd1', status: 'SIGNED' } as any);
      await expect(svc.void(WS, 'd1')).rejects.toBeInstanceOf(ConflictException);
    });
    it('refuses to delete a signed document (legal record)', async () => {
      prisma.document.findFirst.mockResolvedValue({ id: 'd1', status: 'SIGNED' } as any);
      await expect(svc.remove(WS, 'd1')).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('publicSign (token-gated)', () => {
    it('records the signature + audit trail via an atomic SENT→SIGNED claim', async () => {
      prisma.document.findUnique.mockResolvedValue({ id: 'd1', status: 'SENT' } as any);
      prisma.document.updateMany.mockResolvedValue({ count: 1 } as any);

      const res = await svc.publicSign(
        'esign_tok',
        { signerName: '  Jane Doe ', signerEmail: 'jane@x.com', consent: true },
        { ip: '203.0.113.7', userAgent: 'Mozilla/5.0' },
      );

      expect(res).toEqual({ status: 'SIGNED' });
      const arg = prisma.document.updateMany.mock.calls[0][0] as any;
      expect(arg.where).toEqual({ id: 'd1', status: 'SENT' });
      expect(arg.data).toMatchObject({
        status: 'SIGNED',
        signerName: 'Jane Doe', // trimmed
        signerEmail: 'jane@x.com',
        signerIp: '203.0.113.7',
        signerUserAgent: 'Mozilla/5.0',
      });
      expect(arg.data.signedAt).toBeInstanceOf(Date);
    });

    it('is idempotent — an already-signed document is a no-op', async () => {
      prisma.document.findUnique.mockResolvedValue({ id: 'd1', status: 'SIGNED' } as any);
      const res = await svc.publicSign('esign_tok', { signerName: 'x', consent: true }, {});
      expect(res).toEqual({ status: 'SIGNED' });
      expect(prisma.document.updateMany).not.toHaveBeenCalled();
    });

    it('rejects signing without consent', async () => {
      prisma.document.findUnique.mockResolvedValue({ id: 'd1', status: 'SENT' } as any);
      await expect(
        svc.publicSign('esign_tok', { signerName: 'Jane', consent: false }, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects signing without a name', async () => {
      prisma.document.findUnique.mockResolvedValue({ id: 'd1', status: 'SENT' } as any);
      await expect(
        svc.publicSign('esign_tok', { signerName: '   ', consent: true }, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('on a lost double-sign race (count 0) returns the now-current status, not a false success', async () => {
      prisma.document.findUnique
        .mockResolvedValueOnce({ id: 'd1', status: 'SENT' } as any) // initial read
        .mockResolvedValueOnce({ status: 'DECLINED' } as any); // re-read after losing the claim
      prisma.document.updateMany.mockResolvedValue({ count: 0 } as any);
      const res = await svc.publicSign('esign_tok', { signerName: 'Jane', consent: true }, {});
      expect(res).toEqual({ status: 'DECLINED' });
    });

    it('404s an unknown token', async () => {
      prisma.document.findUnique.mockResolvedValue(null);
      await expect(svc.publicView('nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s (not false SENT) when the doc was hard-deleted during a lost claim', async () => {
      prisma.document.findUnique
        .mockResolvedValueOnce({ id: 'd1', status: 'SENT' } as any) // initial read
        .mockResolvedValueOnce(null); // re-read: row gone
      prisma.document.updateMany.mockResolvedValue({ count: 0 } as any);
      await expect(
        svc.publicSign('esign_tok', { signerName: 'Jane', consent: true }, {}),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('detail (API single read)', () => {
    it('strips the signing token + frozen evidence from the payload', async () => {
      prisma.document.findFirst.mockResolvedValue({
        id: 'd1',
        workspaceId: WS,
        title: 'NDA',
        body: 'Terms',
        status: 'SENT',
        publicToken: 'esign_secret',
        bodySnapshot: 'Terms',
        consentStatement: 'I agree…',
      } as any);
      const res: any = await svc.detail(WS, 'd1');
      expect(res.body).toBe('Terms'); // editable body kept
      expect(res.publicToken).toBeUndefined(); // token stripped
      expect(res.bodySnapshot).toBeUndefined();
      expect(res.consentStatement).toBeUndefined();
    });
  });
});
