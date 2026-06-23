import { Prisma } from '@prisma/client';
import { CertificateService } from './certificate.service';
import { mockPrismaClient } from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma = mockPrismaClient();
  const outbox = { append: jest.fn().mockResolvedValue('evt-1') };
  return { prisma, outbox, svc: new CertificateService(prisma as any, outbox as any) };
}

const ENR = { id: 'e1', workspaceId: WS, courseId: 'c1', leadId: 'lead-1' };

describe('CertificateService', () => {
  describe('issueForEnrollment', () => {
    it('does nothing when the course has certificates disabled', async () => {
      const { prisma, outbox, svc } = makeSvc();
      prisma.course.findFirst.mockResolvedValue({ id: 'c1', certificateEnabled: false } as any);
      const out = await svc.issueForEnrollment(ENR);
      expect(out).toBeNull();
      expect(prisma.certificate.create).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('returns the existing certificate (idempotent on workspace+course+lead)', async () => {
      const { prisma, outbox, svc } = makeSvc();
      prisma.course.findFirst.mockResolvedValue({ id: 'c1', certificateEnabled: true } as any);
      prisma.certificate.findFirst.mockResolvedValue({ id: 'cert-old', serial: 'CERT-OLD' } as any);
      const out = await svc.issueForEnrollment(ENR);
      expect(out).toEqual({ id: 'cert-old', serial: 'CERT-OLD' });
      // dedup keyed on the STABLE identity, not enrollmentId
      expect(prisma.certificate.findFirst.mock.calls[0][0].where).toEqual({ workspaceId: WS, courseId: 'c1', leadId: 'lead-1' });
      expect(prisma.certificate.create).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('mints a certificate + emits the certificate.issued event', async () => {
      const { prisma, outbox, svc } = makeSvc();
      prisma.course.findFirst.mockResolvedValue({ id: 'c1', certificateEnabled: true } as any);
      prisma.certificate.findFirst.mockResolvedValue(null as any);
      (prisma.certificate.create as jest.Mock).mockResolvedValue({ id: 'cert-1', serial: 'CERT-ABC' });
      const out = await svc.issueForEnrollment(ENR);
      expect(out).toEqual({ id: 'cert-1', serial: 'CERT-ABC' });
      const data = (prisma.certificate.create as jest.Mock).mock.calls[0][0].data;
      expect(data).toMatchObject({ workspaceId: WS, enrollmentId: 'e1', courseId: 'c1', leadId: 'lead-1' });
      expect(data.serial).toMatch(/^CERT-[0-9A-F]{16}$/);
      const ev = outbox.append.mock.calls[0][0];
      expect(ev.type).toBe('marketing.certificate.issued.v1');
      expect(ev.idempotencyKey).toBe('certificate-issued:cert-1');
      expect(ev.payload).toMatchObject({ workspaceId: WS, courseId: 'c1', certificateId: 'cert-1' });
    });

    it('collapses a P2002 create race onto the winning certificate', async () => {
      const { prisma, svc } = makeSvc();
      prisma.course.findFirst.mockResolvedValue({ id: 'c1', certificateEnabled: true } as any);
      prisma.certificate.findFirst
        .mockResolvedValueOnce(null as any) // initial check: none
        .mockResolvedValueOnce({ id: 'cert-win', serial: 'CERT-WIN' } as any); // post-conflict re-read
      (prisma.certificate.create as jest.Mock).mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
      );
      const out = await svc.issueForEnrollment(ENR);
      expect(out).toEqual({ id: 'cert-win', serial: 'CERT-WIN' });
    });

    it('still issues even if the event emit fails (best-effort)', async () => {
      const { prisma, outbox, svc } = makeSvc();
      prisma.course.findFirst.mockResolvedValue({ id: 'c1', certificateEnabled: true } as any);
      prisma.certificate.findFirst.mockResolvedValue(null as any);
      (prisma.certificate.create as jest.Mock).mockResolvedValue({ id: 'cert-1', serial: 'CERT-X' });
      outbox.append.mockRejectedValueOnce(new Error('outbox down'));
      const out = await svc.issueForEnrollment(ENR);
      expect(out).toEqual({ id: 'cert-1', serial: 'CERT-X' });
    });
  });

  describe('getForEnrollment', () => {
    it('resolves the cert via the enrollment (course, lead) so it survives re-enroll', async () => {
      const { prisma, svc } = makeSvc();
      prisma.enrollment.findFirst.mockResolvedValue({ courseId: 'c1', leadId: 'lead-1' } as any);
      prisma.certificate.findFirst.mockResolvedValue({ id: 'cert-1', serial: 'CERT-ABC' } as any);
      const out: any = await svc.getForEnrollment(WS, 'e-new');
      expect(out).toMatchObject({ id: 'cert-1' });
      expect(prisma.certificate.findFirst.mock.calls[0][0].where).toEqual({ workspaceId: WS, courseId: 'c1', leadId: 'lead-1' });
    });

    it('returns null when the enrollment is not in the workspace', async () => {
      const { prisma, svc } = makeSvc();
      prisma.enrollment.findFirst.mockResolvedValue(null as any);
      expect(await svc.getForEnrollment(WS, 'ghost')).toBeNull();
    });

    it('lazily self-heals: issues for a COMPLETED enrollment with no cert', async () => {
      const { prisma, svc } = makeSvc();
      prisma.enrollment.findFirst.mockResolvedValue({ id: 'e1', workspaceId: WS, courseId: 'c1', leadId: 'lead-1', status: 'COMPLETED' } as any);
      // first lookup (none), issueForEnrollment's internal lookup (none), final re-fetch (the new cert)
      prisma.certificate.findFirst
        .mockResolvedValueOnce(null as any)
        .mockResolvedValueOnce(null as any)
        .mockResolvedValueOnce({ id: 'cert-new', serial: 'CERT-NEW' } as any);
      prisma.course.findFirst.mockResolvedValue({ id: 'c1', certificateEnabled: true } as any);
      (prisma.certificate.create as jest.Mock).mockResolvedValue({ id: 'cert-new', serial: 'CERT-NEW' });
      const out: any = await svc.getForEnrollment(WS, 'e1');
      expect(out).toMatchObject({ id: 'cert-new' });
      expect(prisma.certificate.create).toHaveBeenCalled();
    });

    it('does not self-heal an ACTIVE (incomplete) enrollment', async () => {
      const { prisma, svc } = makeSvc();
      prisma.enrollment.findFirst.mockResolvedValue({ id: 'e1', workspaceId: WS, courseId: 'c1', leadId: 'lead-1', status: 'ACTIVE' } as any);
      prisma.certificate.findFirst.mockResolvedValue(null as any);
      expect(await svc.getForEnrollment(WS, 'e1')).toBeNull();
      expect(prisma.certificate.create).not.toHaveBeenCalled();
    });
  });

  describe('backfillForCourse', () => {
    it('issues for each completed enrollment (idempotent)', async () => {
      const { prisma, svc } = makeSvc();
      prisma.enrollment.findMany.mockResolvedValue([
        { id: 'e1', workspaceId: WS, courseId: 'c1', leadId: 'l1' },
        { id: 'e2', workspaceId: WS, courseId: 'c1', leadId: 'l2' },
      ] as any);
      prisma.course.findFirst.mockResolvedValue({ id: 'c1', certificateEnabled: true } as any);
      prisma.certificate.findFirst.mockResolvedValue(null as any);
      (prisma.certificate.create as jest.Mock)
        .mockResolvedValueOnce({ id: 'cert-1', serial: 'CERT-1' })
        .mockResolvedValueOnce({ id: 'cert-2', serial: 'CERT-2' });
      const n = await svc.backfillForCourse(WS, 'c1');
      expect(n).toBe(2);
      expect(prisma.enrollment.findMany.mock.calls[0][0].where).toMatchObject({ workspaceId: WS, courseId: 'c1', status: 'COMPLETED' });
    });
  });

  describe('renderBySerial', () => {
    it('returns null for an unknown serial', async () => {
      const { prisma, svc } = makeSvc();
      prisma.certificate.findUnique.mockResolvedValue(null as any);
      expect(await svc.renderBySerial('CERT-NOPE')).toBeNull();
    });

    it('renders escaped, printable HTML with the recipient + course', async () => {
      const { prisma, svc } = makeSvc();
      prisma.certificate.findUnique.mockResolvedValue({
        id: 'cert-1', serial: 'CERT-ABC', leadId: 'lead-1', workspaceId: WS, issuedAt: new Date('2026-06-10T00:00:00Z'),
        course: { title: 'Onboarding <101>', certificateTemplate: { title: 'Diploma', signature: 'Jane', logoUrl: 'javascript:alert(1)' } },
      } as any);
      prisma.lead.findFirst.mockResolvedValue({ contactPerson: 'A&B "Co"', businessName: null } as any);
      const html = (await svc.renderBySerial('CERT-ABC'))!;
      expect(html).toContain('Diploma');
      expect(html).toContain('Onboarding &lt;101&gt;'); // course title escaped
      expect(html).toContain('A&amp;B &quot;Co&quot;'); // recipient escaped
      expect(html).toContain('CERT-ABC');
      // unsafe logo URL is dropped (only http(s) allowed)
      expect(html).not.toContain('javascript:alert');
      expect(html).not.toContain('<img');
    });
  });
});
