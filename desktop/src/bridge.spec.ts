import { Bridge, ClaimedCommand } from './bridge';

jest.mock('./adb', () => ({
  AdbError: class AdbError extends Error {},
  describeDevice: jest.fn(async (serial: string) => ({ serial, model: 'Pixel 7' })),
  execute: jest.fn(async () => ({})),
  listDevices: jest.fn(async () => ({ ready: [], unauthorized: [] })),
}));

const adb = jest.requireMock('./adb') as {
  execute: jest.Mock;
  describeDevice: jest.Mock;
};

const CFG = { baseUrl: 'https://jeeta.test', apiKey: 'k-1', deviceId: 'dev-1', serial: 'X1' };

const cmd = (over: Partial<ClaimedCommand> = {}): ClaimedCommand => ({
  id: 'cmd-1',
  kind: 'OPEN_URL',
  args: { url: 'https://wa.me/905551112233?text=Merhaba' },
  description: 'Aç: https://wa.me/905551112233?text=Merhaba',
  requiresApproval: true,
  ...over,
});

/** Serve one claim, then nothing, and record every call. */
function server(first: ClaimedCommand | null) {
  const calls: Array<{ path: string; body: any; headers: Record<string, string> }> = [];
  let served = false;
  const fetchMock = jest.fn(async (url: string, init: any) => {
    const path = String(url).replace(CFG.baseUrl, '');
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ path, body, headers: init?.headers ?? {} });
    if (path.endsWith('/claim')) {
      if (served || !first) return res(null);
      served = true;
      return res(first);
    }
    return res({ ok: true });
  });
  (globalThis as any).fetch = fetchMock;
  return { calls, fetchMock };
}

const res = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, text: async () => (payload === null ? '' : JSON.stringify(payload)) }) as never;

/** Run the loop just long enough to process what the server offered. */
async function runBriefly(bridge: Bridge, ms = 60) {
  const done = bridge.start();
  await new Promise((r) => setTimeout(r, ms));
  bridge.stop();
  await Promise.race([done, new Promise((r) => setTimeout(r, 200))]);
}

beforeEach(() => {
  jest.clearAllMocks();
  adb.execute.mockResolvedValue({});
});

describe('Bridge — the phone on the desk', () => {
  it('asks the person BEFORE it touches the phone, using the sentence the server queued', async () => {
    const { calls } = server(cmd());
    const asked: string[] = [];
    const bridge = new Bridge(CFG, async (c) => {
      asked.push(c.description);
      // The phone must not have been touched yet at the moment of the question.
      expect(adb.execute).not.toHaveBeenCalled();
      return true;
    });
    await runBriefly(bridge);

    expect(asked).toEqual(['Aç: https://wa.me/905551112233?text=Merhaba']);
    expect(adb.execute).toHaveBeenCalledWith('X1', 'OPEN_URL', {
      url: 'https://wa.me/905551112233?text=Merhaba',
    });
    expect(calls.find((c) => c.path.includes('/complete'))?.body).toMatchObject({ status: 'DONE' });
  });

  it('reports a decline as REFUSED — a person saying no is not a failure', async () => {
    const { calls } = server(cmd());
    await runBriefly(new Bridge(CFG, async () => false));

    expect(adb.execute).not.toHaveBeenCalled();
    expect(calls.find((c) => c.path.includes('/complete'))?.body).toEqual({ status: 'REFUSED' });
  });

  it('does not ask on a device the workspace deliberately set to AUTO', async () => {
    server(cmd({ requiresApproval: false }));
    const approve = jest.fn(async () => true);
    await runBriefly(new Bridge(CFG, approve));

    expect(approve).not.toHaveBeenCalled();
    expect(adb.execute).toHaveBeenCalled();
  });

  it('keeps polling after one command fails, instead of stopping the queue', async () => {
    adb.execute.mockRejectedValueOnce(new Error('device offline'));
    const { calls } = server(cmd({ requiresApproval: false }));
    await runBriefly(new Bridge(CFG, async () => true));

    expect(calls.find((c) => c.path.includes('/complete'))?.body).toMatchObject({
      status: 'FAILED',
      error: 'device offline',
    });
    // …and it asked for more work afterwards.
    expect(calls.filter((c) => c.path.endsWith('/claim')).length).toBeGreaterThan(1);
  });

  it('stops knocking when the key is revoked', async () => {
    // A revoked key is somebody deliberately cutting this laptop off. A bridge
    // that retries every ten seconds is the opposite of honouring that.
    (globalThis as any).fetch = jest.fn(async () => res({ message: 'nope' }, 403));
    const errors: string[] = [];
    const bridge = new Bridge(CFG, async () => true, { onError: (m) => errors.push(m) });
    await runBriefly(bridge, 40);

    expect(errors.some((e) => /erişimi kaldırılmış/i.test(e))).toBe(true);
  });

  it('sends the api key on every call and never in the URL', async () => {
    const { calls } = server(null);
    await runBriefly(new Bridge(CFG, async () => true), 30);

    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect((c.headers as Record<string, string>)['X-Api-Key']).toBe('k-1');
      expect(c.path).not.toContain('k-1');
    }
  });

  it('tells the server which handset is on the cable', async () => {
    const { calls } = server(null);
    await runBriefly(new Bridge(CFG, async () => true), 30);

    expect(calls.find((c) => c.path.includes('/heartbeat'))?.body).toMatchObject({
      properties: { serial: 'X1', model: 'Pixel 7' },
    });
  });
});
