import { OnboardingService } from './onboarding.service';

const WS = 'ws-1';

function makeSvc(settings: unknown) {
  const prisma = {
    workspace: {
      findUnique: jest.fn().mockResolvedValue({ settings }),
      update: jest.fn().mockResolvedValue({}),
    },
  } as any;
  return { svc: new OnboardingService(prisma), prisma };
}

describe('OnboardingService', () => {
  it('reads dismissed=false for a workspace that has never dismissed', async () => {
    const { svc } = makeSvc(null);
    expect(await svc.get(WS)).toEqual({ dismissed: false });
  });

  it('reads the stored flag', async () => {
    const { svc } = makeSvc({ onboarding: { dismissed: true } });
    expect(await svc.get(WS)).toEqual({ dismissed: true });
  });

  /**
   * `settings` is a shared free-shape bag (businessTypes and whatever else has
   * been parked there). Writing the onboarding flag must MERGE — replacing the
   * object would silently wipe unrelated workspace configuration, and nothing
   * in the schema would complain.
   */
  it('preserves the rest of settings when writing the flag', async () => {
    const { svc, prisma } = makeSvc({
      businessTypes: ['restaurant'],
      somethingElse: { a: 1 },
      onboarding: { dismissed: false, other: 'keep me' },
    });

    await svc.setDismissed(WS, true);

    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: WS },
      data: {
        settings: {
          businessTypes: ['restaurant'],
          somethingElse: { a: 1 },
          onboarding: { dismissed: true, other: 'keep me' },
        },
      },
    });
  });

  it('creates the settings bag when the workspace has none', async () => {
    const { svc, prisma } = makeSvc(null);
    await svc.setDismissed(WS, true);
    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: WS },
      data: { settings: { onboarding: { dismissed: true } } },
    });
  });

  it('can un-dismiss (the header\'s "show setup guide" path)', async () => {
    const { svc, prisma } = makeSvc({ onboarding: { dismissed: true } });
    expect(await svc.setDismissed(WS, false)).toEqual({ dismissed: false });
    expect(prisma.workspace.update.mock.calls[0][0].data.settings).toEqual({
      onboarding: { dismissed: false },
    });
  });

  it('treats a non-object settings value as empty rather than throwing', async () => {
    const { svc } = makeSvc('corrupt');
    expect(await svc.get(WS)).toEqual({ dismissed: false });
  });
});
