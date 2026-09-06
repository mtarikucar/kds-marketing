import { RoutingMediaProvider, RUNWARE_REQUEST_PREFIX } from './routing.provider';
import { DEFAULT_IMAGE_MODEL } from '../media/media-models.config';

function makeRouter(runwareOn: boolean, falOn = true) {
  const fal: any = {
    name: 'fal',
    isConfigured: jest.fn().mockReturnValue(falOn),
    submit: jest.fn().mockResolvedValue({ providerRequestId: 'fal-1' }),
    getResult: jest.fn().mockResolvedValue({ status: 'IN_PROGRESS' }),
  };
  const runware: any = {
    name: 'runware',
    isConfigured: jest.fn().mockReturnValue(runwareOn),
    submit: jest.fn().mockResolvedValue({ providerRequestId: 'uuid-1' }),
    getResult: jest.fn().mockResolvedValue({ status: 'COMPLETED', outputs: [] }),
  };
  return { router: new RoutingMediaProvider(fal, runware), fal, runware };
}
const BOUND = 'bytedance/seedance-2.5/text-to-video';
const SUBMIT = { type: 'VIDEO' as const, prompt: 'x' };

describe('RoutingMediaProvider', () => {
  it('is configured exactly when fal is (fal is the base every model can run on)', () => {
    expect(makeRouter(true, false).router.isConfigured()).toBe(false);
    expect(makeRouter(false, true).router.isConfigured()).toBe(true);
  });

  it('names runware for a bound model only while runware is configured', () => {
    expect(makeRouter(true).router.resolveName(BOUND)).toBe('runware');
    expect(makeRouter(false).router.resolveName(BOUND)).toBe('fal');
    expect(makeRouter(true).router.resolveName(DEFAULT_IMAGE_MODEL)).toBe('fal');
  });

  it('submits a bound model to runware and prefixes the request id', async () => {
    const { router, runware, fal } = makeRouter(true);
    await expect(router.submit({ ...SUBMIT, model: BOUND }))
      .resolves.toEqual({ providerRequestId: `${RUNWARE_REQUEST_PREFIX}uuid-1` });
    expect(runware.submit).toHaveBeenCalledTimes(1);
    expect(fal.submit).not.toHaveBeenCalled();
  });

  it('submits everything else to fal with a bare id', async () => {
    const { router, fal, runware } = makeRouter(true);
    await expect(router.submit({ ...SUBMIT, type: 'IMAGE', model: DEFAULT_IMAGE_MODEL }))
      .resolves.toEqual({ providerRequestId: 'fal-1' });
    expect(fal.submit).toHaveBeenCalledTimes(1);
    expect(runware.submit).not.toHaveBeenCalled();
  });

  it('keeps a bound model on fal while runware is unconfigured (ships dark)', async () => {
    const { router, fal, runware } = makeRouter(false);
    await router.submit({ ...SUBMIT, model: BOUND });
    expect(fal.submit).toHaveBeenCalledTimes(1);
    expect(runware.submit).not.toHaveBeenCalled();
  });

  it('polls by request-id prefix, not by model — an in-flight fal job stays on fal after the key appears', async () => {
    const { router, fal, runware } = makeRouter(true);
    await router.getResult('fal-abc', BOUND);
    expect(fal.getResult).toHaveBeenCalledWith('fal-abc', BOUND);
    await router.getResult(`${RUNWARE_REQUEST_PREFIX}uuid-9`, BOUND);
    expect(runware.getResult).toHaveBeenCalledWith('uuid-9', BOUND);
  });
});
