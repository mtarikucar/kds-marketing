import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DevicesService } from './devices.service';
import {
  validateDeviceCommand,
  describeDeviceCommand,
  DEVICE_COMMAND_KINDS,
  MIN_BRIDGE_VERSION,
  bridgeIsOutdated,
} from './device-commands';

const WS = 'ws-1';
const DEV = 'dev-1';

function deps(
  device: Record<string, unknown> | null = { id: DEV, workspaceId: WS, label: 'Satış telefonu', status: 'ACTIVE', mode: 'MANUAL', pairedAt: null },
  storageOver: Partial<{ configured: boolean; upload: jest.Mock }> = {},
) {
  // ONE mutable command row behind findMany/updateMany, so a conditional claim
  // can be told apart from an unconditional write — a mock that always reports
  // success cannot distinguish the two, which is the whole property here.
  let queued: any[] = [];
  const prisma: any = {
    device: {
      findFirst: jest.fn(async () => device),
      findMany: jest.fn(async () => (device ? [device] : [])),
      create: jest.fn(async ({ data }: any) => ({ id: DEV, ...data })),
      update: jest.fn(async ({ data }: any) => ({ ...device, ...data })),
    },
    deviceCommand: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `cmd-${queued.length + 1}`, status: 'QUEUED', ...data };
        queued.push(row);
        return row;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        queued.filter((c) => (where.status ? c.status === where.status : true)),
      ),
      findFirst: jest.fn(async ({ where }: any) => queued.find((c) => c.id === where.id) ?? null),
      // Honours `expiresAt` and `claimedAt` as well as id/status: a mock that
      // ignores a predicate makes the expiry and stale-claim sweeps match
      // everything, which is how a test comes to assert the opposite of the
      // rule it was written for.
      updateMany: jest.fn(async ({ where, data }: any) => {
        const lt = (v: unknown, bound: unknown) =>
          v instanceof Date && bound instanceof Date && v < bound;
        const hits = queued.filter(
          (c) =>
            (where.id === undefined || c.id === where.id) &&
            (where.status === undefined ||
              (typeof where.status === 'string'
                ? c.status === where.status
                : where.status.in?.includes(c.status))) &&
            (where.expiresAt === undefined || lt(c.expiresAt, where.expiresAt.lt)) &&
            (where.claimedAt === undefined || lt(c.claimedAt, where.claimedAt.lt)),
        );
        hits.forEach((c) => Object.assign(c, data));
        return { count: hits.length };
      }),
    },
    $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
  };
  const storage: any = {
    isConfigured: jest.fn(() => storageOver.configured ?? false),
    upload:
      storageOver.upload ??
      jest.fn(async () => ({ url: 'https://cdn.test/shot.png', key: 'ws-1/shot.png', mime: 'image/png' })),
  };
  return {
    svc: new DevicesService(prisma, storage),
    prisma,
    storage,
    seed: (rows: any[]) => (queued = rows),
  };
}

describe('device commands — what a phone may be asked to do', () => {
  it('refuses a kind nobody defined, and says what the options are', () => {
    expect(() => validateDeviceCommand('SHELL', { cmd: 'rm -rf /' })).toThrow(BadRequestException);
    expect(() => validateDeviceCommand('SHELL', {})).toThrow(/unknown device command/i);
  });

  it('opens only https and tel links', () => {
    // The point of the allowlist is `intent:`, which can name a component and
    // its extras — a way into parts of an app its own UI never offers.
    expect(validateDeviceCommand('OPEN_URL', { url: 'https://wa.me/905551112233?text=Merhaba' })).toEqual({
      url: 'https://wa.me/905551112233?text=Merhaba',
    });
    expect(validateDeviceCommand('OPEN_URL', { url: 'tel:+905551112233' })).toBeTruthy();
    for (const bad of ['intent://scan#Intent;end', 'file:///sdcard/x', 'content://sms/inbox']) {
      expect(() => validateDeviceCommand('OPEN_URL', { url: bad })).toThrow(BadRequestException);
    }
  });

  it('will not interpolate a shell fragment into an adb argument', () => {
    expect(validateDeviceCommand('LAUNCH_APP', { package: 'com.whatsapp' })).toEqual({
      package: 'com.whatsapp',
    });
    for (const bad of ['com.whatsapp; rm -rf /', '$(whoami)', 'whatsapp', '../etc']) {
      expect(() => validateDeviceCommand('LAUNCH_APP', { package: bad })).toThrow(BadRequestException);
    }
  });

  it('takes a key by NAME, so a typo cannot become a different button', () => {
    expect(validateDeviceCommand('KEY', { key: 'back' })).toEqual({ key: 'BACK' });
    expect(() => validateDeviceCommand('KEY', { key: '26' })).toThrow(BadRequestException);
  });

  it('rejects a coordinate a phone would accept and silently tap nothing at', () => {
    expect(() => validateDeviceCommand('TAP', { x: -5, y: 10 })).toThrow(/outside the screen/i);
    expect(() => validateDeviceCommand('TAP', { x: 10 })).toThrow(/y must be a number/i);
    expect(validateDeviceCommand('TAP', { x: 10.6, y: 20.2 })).toEqual({ x: 11, y: 20 });
  });

  it('treats a bridge that predates the current instruction set as outdated', () => {
    // The whole reason this exists: an old bridge is ONLINE and healthy and
    // will refuse every command added since it shipped. Without a version it
    // looks identical to a current one right up to the refusal.
    expect(bridgeIsOutdated('0.1.0')).toBe(true);
    expect(bridgeIsOutdated(MIN_BRIDGE_VERSION)).toBe(false);
    expect(bridgeIsOutdated('9.0.0')).toBe(false);
    // Silence is not "probably fine": a bridge that reports no version is one
    // built before reporting existed, which is older than the first version
    // that reports.
    expect(bridgeIsOutdated(undefined)).toBe(true);
    expect(bridgeIsOutdated('')).toBe(true);
    expect(bridgeIsOutdated('nightly')).toBe(true);
  });

  it('compares each part as a NUMBER, not as text', () => {
    // "0.10.0" < "0.9.0" is true as strings and false as versions, and the
    // first release past 0.9 is exactly when that would have bitten.
    expect(bridgeIsOutdated('0.10.0')).toBe(false);
  });

  it('gives EVERY kind a sentence, because a blank approval card cannot be consented to', () => {
    // The bridge shows `describeDeviceCommand`'s output and nothing else. A
    // kind added to the vocabulary without a case here does not throw — the
    // switch falls off the end and returns undefined — so the person at the
    // phone is asked to approve an empty box.
    const sample: Record<string, Record<string, unknown>> = {
      TAP: { x: 1, y: 2 },
      TAP_ON: { text: 'Gönder', occurrence: 1 },
      SWIPE: { x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 300 },
      TEXT: { value: 'merhaba' },
      KEY: { key: 'BACK' },
      OPEN_URL: { url: 'https://wa.me/9055' },
      LAUNCH_APP: { package: 'com.whatsapp' },
      SCREENSHOT: {},
      UI_DUMP: {},
    };
    for (const kind of DEVICE_COMMAND_KINDS) {
      expect(Object.keys(sample)).toContain(kind);
      const sentence = describeDeviceCommand(kind, sample[kind]);
      expect(typeof sentence).toBe('string');
      expect(sentence.length).toBeGreaterThan(3);
    }
  });

  it('takes exactly one selector for a named tap, and defaults the occurrence', () => {
    expect(validateDeviceCommand('TAP_ON', { text: 'Gönder' })).toEqual({
      text: 'Gönder',
      occurrence: 1,
    });
    expect(validateDeviceCommand('TAP_ON', { desc: 'Ara', occurrence: 3 })).toEqual({
      desc: 'Ara',
      occurrence: 3,
    });
    expect(() => validateDeviceCommand('TAP_ON', { text: 'a', id: 'b' })).toThrow(/exactly one/i);
    expect(() => validateDeviceCommand('TAP_ON', {})).toThrow(/exactly one/i);
  });

  it('refuses text a phone would type WRONG rather than typing it', () => {
    // The failure this prevents is silent: `input text` maps to ASCII
    // keycodes, so "Ayşe" is not typed slowly or partially — it is typed
    // wrong, and the phone reports success either way.
    expect(validateDeviceCommand('TEXT', { value: 'Merhaba' })).toEqual({ value: 'Merhaba' });
    expect(() => validateDeviceCommand('TEXT', { value: 'Merhaba Ayşe' })).toThrow(/plain ASCII/i);
    // And it says what DOES work, because a refusal with no route is a dead end.
    expect(() => validateDeviceCommand('TEXT', { value: 'çğıöşü' })).toThrow(/wa\.me|TAP_ON/);
  });

  it('describes a command in words a person can consent to', () => {
    // The bridge shows this to the thumb that approves it. `{"kind":"OPEN_URL"}`
    // is not something anyone can agree to.
    expect(describeDeviceCommand('OPEN_URL', { url: 'https://wa.me/9055' })).toMatch(/Aç: https/);
    expect(describeDeviceCommand('TEXT', { value: 'Merhaba' })).toMatch(/Yaz: "Merhaba"/);
  });
});

describe('DevicesService — the rendezvous', () => {
  it('queues a validated command and stamps who asked', async () => {
    const { svc } = deps();
    const cmd = await svc.enqueue(WS, DEV, 'OPEN_URL', { url: 'https://wa.me/905551112233' }, {
      source: 'mcp',
      requestedBy: 'u1',
    });
    expect(cmd).toMatchObject({ kind: 'OPEN_URL', status: 'QUEUED', source: 'mcp', requestedBy: 'u1' });
    // "the phone opened WhatsApp" is a sentence that needs an actor.
    expect(cmd.expiresAt).toBeInstanceOf(Date);
  });

  it('refuses to queue for a paused device instead of promising it will happen', async () => {
    const { svc } = deps({ id: DEV, workspaceId: WS, label: 'Telefon', status: 'PAUSED', mode: 'MANUAL' });
    await expect(
      svc.enqueue(WS, DEV, 'SCREENSHOT', {}, { source: 'ui' }),
    ).rejects.toThrow(/paused/i);
  });

  it('hands a claim to ONE bridge — the second gets nothing', async () => {
    const { svc, prisma, seed } = deps();
    seed([{ id: 'cmd-1', deviceId: DEV, workspaceId: WS, kind: 'SCREENSHOT', args: {}, status: 'QUEUED' }]);
    const first = await svc.claimNext(WS, DEV);
    expect(first).toMatchObject({ id: 'cmd-1', status: 'CLAIMED' });
    // A laptop at the office and another at home must not both run the tap.
    const second = await svc.claimNext(WS, DEV);
    expect(second).toBeNull();
    expect(prisma.deviceCommand.updateMany).toHaveBeenCalled();
  });

  it('tells the bridge a MANUAL device needs a person, and what to show them', async () => {
    const { svc, seed } = deps();
    seed([
      { id: 'cmd-1', deviceId: DEV, workspaceId: WS, kind: 'OPEN_URL', args: { url: 'https://wa.me/9055' }, status: 'QUEUED' },
    ]);
    const claimed = await svc.claimNext(WS, DEV);
    expect(claimed).toMatchObject({ requiresApproval: true });
    expect(claimed!.description).toMatch(/^Aç: https/);
  });

  it('does not require approval on a device somebody deliberately set to AUTO', async () => {
    const { svc, seed } = deps({ id: DEV, workspaceId: WS, label: 'T', status: 'ACTIVE', mode: 'AUTO' });
    seed([{ id: 'cmd-1', deviceId: DEV, workspaceId: WS, kind: 'SCREENSHOT', args: {}, status: 'QUEUED' }]);
    expect(await svc.claimNext(WS, DEV)).toMatchObject({ requiresApproval: false });
  });

  it('records a REFUSAL as its own outcome, not as a failure', async () => {
    // A person declining is the manual mode working. Folding it into FAILED
    // would make the one signal that proves a human was in the loop look like
    // a malfunction.
    const { svc, seed } = deps();
    seed([{ id: 'cmd-1', deviceId: DEV, workspaceId: WS, status: 'CLAIMED' }]);
    const done = await svc.complete(WS, 'cmd-1', { status: 'REFUSED' });
    expect(done).toMatchObject({ status: 'REFUSED' });
    expect(done!.error).toBeNull();
  });

  it('will not let a retrying bridge overwrite a settled outcome', async () => {
    const { svc, seed } = deps();
    seed([{ id: 'cmd-1', deviceId: DEV, workspaceId: WS, status: 'DONE' }]);
    await expect(svc.complete(WS, 'cmd-1', { status: 'FAILED', error: 'late' })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('empties the queue when the device is stopped', async () => {
    // Otherwise resuming replays whatever was waiting when somebody reached
    // for the stop button — the opposite of stopping.
    const { svc, seed } = deps();
    const rows = [
      { id: 'cmd-1', deviceId: DEV, workspaceId: WS, status: 'QUEUED' },
      { id: 'cmd-2', deviceId: DEV, workspaceId: WS, status: 'CLAIMED' },
    ];
    seed(rows);
    await svc.setStatus(WS, DEV, 'PAUSED');
    expect(rows.every((r) => r.status === 'EXPIRED')).toBe(true);
  });

  it('does not hand over a command nobody collected in time', async () => {
    const { svc, seed } = deps();
    seed([
      {
        id: 'cmd-old',
        deviceId: DEV,
        workspaceId: WS,
        kind: 'TAP',
        args: { x: 1, y: 1 },
        status: 'QUEUED',
        expiresAt: new Date(Date.now() - 1000),
      },
    ]);
    // A phone plugged back in after a week must not replay a day of taps: the
    // screen those commands were written for is gone.
    expect(await svc.claimNext(WS, DEV)).toBeNull();
  });

  it('does not forget the phone because one heartbeat came back thin', async () => {
    // The bridge falls back to just the serial whenever adb hiccups — a
    // sleeping phone, a busy cable. Replacing the blob with that erased the
    // model, the Android version and the screen size from a console that had
    // been showing them, for as long as the hiccup lasted.
    const known = {
      id: DEV,
      workspaceId: WS,
      label: 'T',
      status: 'ACTIVE',
      mode: 'MANUAL',
      properties: { model: 'Pixel 5', androidVersion: '13', serial: 'abc', bridgeVersion: '0.2.0' },
    };
    const { svc, prisma } = deps(known);
    await svc.heartbeat(WS, DEV, { serial: 'abc' });
    const written = (prisma.device.update as jest.Mock).mock.calls.at(-1)[0].data.properties;
    expect(written.model).toBe('Pixel 5');
    expect(written.androidVersion).toBe('13');
  });

  it('lets a newly reported value win over the remembered one', async () => {
    // Merging must not turn into remembering forever: a phone that reports a
    // new Android version has upgraded, and the console should say so.
    const { svc, prisma } = deps({
      id: DEV,
      workspaceId: WS,
      label: 'T',
      status: 'ACTIVE',
      mode: 'MANUAL',
      properties: { model: 'Pixel 5', androidVersion: '13' },
    });
    await svc.heartbeat(WS, DEV, { model: 'Pixel 5', androidVersion: '14' });
    const written = (prisma.device.update as jest.Mock).mock.calls.at(-1)[0].data.properties;
    expect(written.androidVersion).toBe('14');
  });

  it('never lets a screenshot reach the database as text', async () => {
    // Base64 in a JSONB column is megabytes per tap, and the same string is
    // what an MCP caller would then be handed. It must not survive this method
    // under ANY configuration — including the one where there is nowhere to
    // put it.
    const { svc, prisma, seed } = deps();
    seed([{ id: 'cmd-1', workspaceId: WS, deviceId: DEV, status: 'CLAIMED' }]);
    await svc.complete(WS, 'cmd-1', {
      status: 'DONE',
      result: { screenshotBase64: 'AAAABBBBCCCC', tapped: true },
    });
    const written = prisma.deviceCommand.updateMany.mock.calls.at(-1)[0].data.result;
    expect(written.screenshotBase64).toBeUndefined();
    expect(written.tapped).toBe(true);
    expect(written.screenshotUnavailable).toMatch(/no object store/i);
  });

  it('turns a screenshot into a link when there is somewhere to put it', async () => {
    const { svc, prisma } = deps(undefined, { configured: true });
    prisma.deviceCommand.updateMany.mockResolvedValue({ count: 1 });
    await svc.complete(WS, 'cmd-1', {
      status: 'DONE',
      result: { screenshotBase64: Buffer.from('png').toString('base64') },
    });
    const call = prisma.deviceCommand.updateMany.mock.calls.at(-1)[0].data;
    expect(call.result.screenshotUrl).toBe('https://cdn.test/shot.png');
    expect(call.result.screenshotBase64).toBeUndefined();
    expect(call.screenshotKey).toBe('ws-1/shot.png');
  });

  it('still records what the phone did when the upload fails', async () => {
    // The tap happened. Losing the outcome because a bucket was unreachable
    // would turn a missing picture into a missing fact.
    const upload = jest.fn(async () => {
      throw new Error('bucket unreachable');
    });
    const { svc, prisma } = deps(undefined, { configured: true, upload });
    prisma.deviceCommand.updateMany.mockResolvedValue({ count: 1 });
    await svc.complete(WS, 'cmd-1', {
      status: 'DONE',
      result: { screenshotBase64: 'AAAA', tapped: true },
    });
    const written = prisma.deviceCommand.updateMany.mock.calls.at(-1)[0].data;
    expect(written.status).toBe('DONE');
    expect(written.result.tapped).toBe(true);
    expect(written.result.screenshotUnavailable).toMatch(/bucket unreachable/);
  });

  it('is invisible across workspaces', async () => {
    const { svc } = deps(null);
    await expect(svc.enqueue('other-ws', DEV, 'SCREENSHOT', {}, { source: 'ui' })).rejects.toThrow(
      NotFoundException,
    );
  });
});
