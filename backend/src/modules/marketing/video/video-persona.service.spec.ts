import { BadRequestException, NotFoundException } from '@nestjs/common';
import { VideoPersonaService } from './video-persona.service';

function makePrisma(found: any = { id: 'p1' }) {
  const create = jest.fn().mockResolvedValue({ id: 'p1' });
  return {
    prisma: {
      videoPersona: {
        create,
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(found),
      },
    } as any,
    create,
  };
}

describe('VideoPersonaService', () => {
  it('requires a name', async () => {
    const { prisma } = makePrisma();
    await expect(new VideoPersonaService(prisma).create('ws1', { name: '  ' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('caps reference images at 9 (Seedance limit)', async () => {
    const { prisma, create } = makePrisma();
    const refs = Array.from({ length: 15 }, (_, i) => `r${i}.png`);
    await new VideoPersonaService(prisma).create('ws1', { name: 'X', referenceImageUrls: refs, lockedSeed: 7 });
    expect(create.mock.calls[0][0].data.referenceImageUrls).toHaveLength(9);
    expect(create.mock.calls[0][0].data.lockedSeed).toBe(7);
  });

  it('404s a persona from another workspace', async () => {
    const { prisma } = makePrisma(null);
    await expect(new VideoPersonaService(prisma).get('ws1', 'other')).rejects.toBeInstanceOf(NotFoundException);
  });
});
