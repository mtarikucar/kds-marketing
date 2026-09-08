import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DevicesService } from './devices.service';
import { validateDeviceCommand, describeDeviceCommand } from './device-commands';

const WS = 'ws-1';
const DEV = 'dev-1';

function deps(device: Record<string, unknown> | null = { id: DEV, workspaceId: WS, label: 'Satış telefonu', status: 'ACTIVE', mode: 'MANUAL', pairedAt: null }) {
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
  return { svc: new DevicesService(prisma), prisma, seed: (rows: any[]) => (queued = rows) };
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

  it('is invisible across workspaces', async () => {
    const { svc } = deps(null);
    await expect(svc.enqueue('other-ws', DEV, 'SCREENSHOT', {}, { source: 'ui' })).rejects.toThrow(
      NotFoundException,
    );
  });
});
