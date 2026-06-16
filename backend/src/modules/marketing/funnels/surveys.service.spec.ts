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

  it('submit records a response when the survey is published', async () => {
    const { prisma, svc } = makeSvc();
    prisma.survey.findUnique.mockResolvedValue({ id: 's1', workspaceId: WS, status: 'PUBLISHED', redirectUrl: 'https://x' } as any);
    (prisma.surveyResponse.create as jest.Mock).mockResolvedValue({});
    const out = await svc.submit('s1', { score: 9 }, 'lead-1');
    expect(out).toEqual({ redirectUrl: 'https://x' });
    expect((prisma.surveyResponse.create as jest.Mock).mock.calls[0][0].data).toMatchObject({ surveyId: 's1', leadId: 'lead-1' });
  });

  it('submit 404s a non-published survey', async () => {
    const { prisma, svc } = makeSvc();
    prisma.survey.findUnique.mockResolvedValue({ id: 's1', status: 'DRAFT' } as any);
    await expect(svc.submit('s1', {})).rejects.toBeInstanceOf(NotFoundException);
  });
});
