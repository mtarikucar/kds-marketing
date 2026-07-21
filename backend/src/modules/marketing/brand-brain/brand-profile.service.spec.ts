import { BrandProfileService } from './brand-profile.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma: any = {
    brandProfile: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  };
  const context: any = { invalidate: jest.fn() };
  return { svc: new BrandProfileService(prisma, context), prisma, context };
}

describe('BrandProfileService', () => {
  it('upsert creates with brandName + DRAFT, only touching sent fields', async () => {
    const { svc, prisma, context } = makeSvc();
    (prisma.brandProfile.upsert as jest.Mock).mockImplementation(({ create }) => Promise.resolve({ id: 'b1', ...create }));
    const res = await svc.upsert('ws-1', { brandName: 'Acme', valueProps: ['fast', 'cheap'] });
    const call = (prisma.brandProfile.upsert as jest.Mock).mock.calls[0][0];
    expect(call.where).toEqual({ workspaceId: 'ws-1' });
    expect(call.create).toMatchObject({ workspaceId: 'ws-1', brandName: 'Acme', valueProps: ['fast', 'cheap'], status: 'DRAFT' });
    // A field not sent must not appear in the update payload (partial-safe).
    expect('tagline' in call.update).toBe(false);
    expect(res).toMatchObject({ id: 'b1', brandName: 'Acme' });
    // Every write path invalidates the cached brand-context block.
    expect(context.invalidate).toHaveBeenCalledWith('ws-1');
  });

  it('get returns the workspace profile', async () => {
    const { svc, prisma } = makeSvc();
    (prisma.brandProfile.findUnique as jest.Mock).mockResolvedValue({ id: 'b1', brandName: 'Acme' });
    expect(await svc.get('ws-1')).toMatchObject({ brandName: 'Acme' });
    expect(prisma.brandProfile.findUnique).toHaveBeenCalledWith({ where: { workspaceId: 'ws-1' } });
  });

  it('upsert only touches sent fields on the update payload (partial save)', async () => {
    const { svc, prisma } = makeSvc();
    (prisma.brandProfile.upsert as jest.Mock).mockImplementation(({ update }) => Promise.resolve({ id: 'b1', ...update }));
    await svc.upsert(WS, { tagline: 'Fast & cheap' });
    const call = (prisma.brandProfile.upsert as jest.Mock).mock.calls[0][0];
    expect(call.update).toEqual({ tagline: 'Fast & cheap' });
    expect('brandName' in call.update).toBe(false);
  });
});
