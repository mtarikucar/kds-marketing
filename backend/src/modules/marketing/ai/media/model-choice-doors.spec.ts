import {
  assertModelOffersAspect,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
} from './media-models.config';
import { MediaModelDefaultsService } from './media-model-defaults.service';
import { SocialCampaignsService } from '../../social-campaigns/social-campaigns.service';
import { DEFAULT_SHOT_ASPECT } from '../../video/video-pipeline.service';

/**
 * The catalogue is REAL except for the one rule under test, which is replaced so
 * the door can be observed asking its question.
 *
 * Why it has to be replaced: every served video model in the catalogue today
 * publishes 9:16, so nothing real triggers the refusal — and a door that is only
 * exercised on the passing branch is a door that can be deleted without a test
 * noticing. The RULE itself is tested against the real catalogue in
 * `media-models.config.spec.ts` (Veo 3.1 does not publish 1:1); this file tests
 * that the two doors that STORE a model id actually ask it.
 */
jest.mock('./media-models.config', () => {
  const actual = jest.requireActual('./media-models.config');
  return { ...actual, assertModelOffersAspect: jest.fn() };
});

const asked = assertModelOffersAspect as unknown as jest.Mock;

const REFUSED = new Error('this model cannot shoot 9:16');

function campaignsService(prisma: unknown) {
  // create()/update() touch prisma and the model guards and nothing else; the
  // remaining collaborators exist only to satisfy the constructor.
  return new SocialCampaignsService(
    prisma as never,
    { schedule: jest.fn() } as never,
    { registerHandler: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

beforeEach(() => asked.mockReset());

/**
 * A model id is stored in exactly two places — the campaign override and the
 * workspace default — and BOTH are where a person is choosing between a handful
 * of options on a screen. Everywhere downstream of the choice, a refusal arrives
 * after a human has approved work that can no longer be taken back.
 */
describe('the campaign override asks whether the model can shoot this line frame', () => {
  it('create: refuses, and asks about the frame the content line plans in', async () => {
    asked.mockImplementation(() => {
      throw REFUSED;
    });
    const svc = campaignsService({ socialCampaign: { create: jest.fn() } });

    await expect(
      svc.create('ws-1', {
        name: 'Launch',
        brief: {},
        automationMode: 'FULL_AUTO',
        planningMode: 'AI_FULL',
        cadence: { daysOfWeek: [1], timeOfDay: '09:00' } as never,
        startDate: new Date(),
        targetAccountIds: [],
        mediaKinds: ['VIDEO'],
        defaultVideoModel: 'fal-ai/veo3.1',
        createdById: 'u-1',
      } as never),
    ).rejects.toThrow(REFUSED);

    expect(asked).toHaveBeenCalledWith('fal-ai/veo3.1', DEFAULT_SHOT_ASPECT);
  });

  it('update: the same question at the same door', async () => {
    asked.mockImplementation(() => {
      throw REFUSED;
    });
    const svc = campaignsService({
      socialCampaign: { findFirst: jest.fn().mockResolvedValue({ id: 'c-1', status: 'DRAFT' }), update: jest.fn() },
    });

    await expect(svc.update('ws-1', 'c-1', { defaultVideoModel: 'fal-ai/veo3.1' })).rejects.toThrow(REFUSED);
    expect(asked).toHaveBeenCalledWith('fal-ai/veo3.1', DEFAULT_SHOT_ASPECT);
  });

  it('an IMAGE model is not asked a video question', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'c-1' });
    const svc = campaignsService({ socialCampaign: { create } });

    await svc.create('ws-1', {
      name: 'Launch',
      brief: {},
      automationMode: 'APPROVAL',
      planningMode: 'AI_FULL',
      cadence: { daysOfWeek: [1], timeOfDay: '09:00' } as never,
      startDate: new Date(),
      targetAccountIds: [],
      mediaKinds: ['IMAGE'],
      defaultImageModel: DEFAULT_IMAGE_MODEL,
      createdById: 'u-1',
    } as never);

    expect(asked).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalled();
  });
});

describe('the workspace default asks the same question', () => {
  it('set: refuses a video default that cannot shoot the frame', async () => {
    asked.mockImplementation(() => {
      throw REFUSED;
    });
    const prisma = { workspace: { update: jest.fn() } };
    const svc = new MediaModelDefaultsService(prisma as never);

    await expect(svc.set('ws-1', { defaultVideoModel: DEFAULT_VIDEO_MODEL })).rejects.toThrow(REFUSED);
    expect(asked).toHaveBeenCalledWith(DEFAULT_VIDEO_MODEL, DEFAULT_SHOT_ASPECT);
    // Nothing stored: the card refuses before the write, so the workspace is
    // never left believing it chose a model it cannot generate with.
    expect(prisma.workspace.update).not.toHaveBeenCalled();
  });

  it('set: an IMAGE default is not asked a video question', async () => {
    const prisma = {
      workspace: {
        update: jest.fn().mockResolvedValue({ defaultImageModel: DEFAULT_IMAGE_MODEL, defaultVideoModel: null }),
      },
    };
    const svc = new MediaModelDefaultsService(prisma as never);

    await svc.set('ws-1', { defaultImageModel: DEFAULT_IMAGE_MODEL });
    expect(asked).not.toHaveBeenCalled();
  });

  it('set: clearing a choice back to the platform default asks nothing', async () => {
    const prisma = {
      workspace: { update: jest.fn().mockResolvedValue({ defaultImageModel: null, defaultVideoModel: null }) },
    };
    const svc = new MediaModelDefaultsService(prisma as never);

    await svc.set('ws-1', { defaultVideoModel: null });
    expect(asked).not.toHaveBeenCalled();
  });
});
