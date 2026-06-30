import { NotFoundException } from '@nestjs/common';
import { SurveysService } from './surveys.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma = mockPrismaClient();
  return { prisma, svc: new SurveysService(prisma as any) };
}

describe('SurveysService', () => {
  it('creates a survey', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.survey.create as jest.Mock).mockImplementation((a: any) => Promise.resolve({ id: 's1', ...a.data }));
    const out: any = await svc.create(WS, { name: 'NPS', questions: [{ key: 'score', type: 'number' }] });
    expect(out).toMatchObject({ workspaceId: WS, name: 'NPS' });
  });

  it('submit records a response and attributes a leadId that resolves in the workspace', async () => {
    const { prisma, svc } = makeSvc();
    prisma.survey.findUnique.mockResolvedValue({ id: 's1', workspaceId: WS, status: 'PUBLISHED', redirectUrl: 'https://x' } as any);
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any); // resolves in-workspace
    (prisma.surveyResponse.create as jest.Mock).mockResolvedValue({});
    const out = await svc.submit('s1', { score: 9 }, 'lead-1');
    expect(out).toEqual({ redirectUrl: 'https://x' });
    expect((prisma.surveyResponse.create as jest.Mock).mock.calls[0][0].data).toMatchObject({ surveyId: 's1', leadId: 'lead-1' });
    // the attribution lookup is scoped to the survey's workspace
    expect((prisma.lead.findFirst as jest.Mock).mock.calls[0][0].where).toMatchObject({ id: 'lead-1', workspaceId: WS });
  });

  it('submit DROPS a leadId that does not resolve in the survey’s workspace (no attribution spoofing)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.survey.findUnique.mockResolvedValue({ id: 's1', workspaceId: WS, status: 'PUBLISHED', redirectUrl: null } as any);
    prisma.lead.findFirst.mockResolvedValue(null as any); // foreign / unknown lead id
    (prisma.surveyResponse.create as jest.Mock).mockResolvedValue({});
    await svc.submit('s1', { score: 1 }, 'foreign-lead');
    // the response is still recorded, but UNattributed (leadId null), not pinned
    // to the attacker-supplied id.
    expect((prisma.surveyResponse.create as jest.Mock).mock.calls[0][0].data).toMatchObject({ surveyId: 's1', leadId: null });
  });

  it('submit 404s a non-published survey', async () => {
    const { prisma, svc } = makeSvc();
    prisma.survey.findUnique.mockResolvedValue({ id: 's1', status: 'DRAFT' } as any);
    await expect(svc.submit('s1', {})).rejects.toBeInstanceOf(NotFoundException);
  });
});
