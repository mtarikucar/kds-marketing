/**
 * The paired-phone lane, asserted where it actually matters.
 *
 * This is the only tool group in the catalogue whose effect leaves the product:
 * a command here lands on a real handset, in somebody's real WhatsApp, and no
 * compensating row undoes it. So the tests below are not about return shapes.
 * They pin the three things that keep it honest — the approval flag the broker
 * branches on, the tenant boundary, and the refusal to report a queued command
 * as a done one.
 */
process.env.MCP_DEVICE_WAIT_MS = '1200';

import { McpToolRegistry } from '../mcp-tool-registry';
// Required, not imported: `WAIT_MS` is read once at module load, and an
// `import` is hoisted above the assignment above it — the test would then wait
// the real 25 seconds.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { registerDeviceTools } = require('./device.tools') as typeof import('./device.tools');

const CALLER_WS = 'ws-a';
const FOREIGN_WS = 'ws-b';

/** A phone whose desktop bridge was heard from a second ago. The default,
 *  because an OFFLINE bridge short-circuits the wait — a fixture that forgot
 *  the heartbeat would make every "what does it report?" test pass for the
 *  wrong reason. */
const ONLINE_DEVICE = { id: 'd1', label: 'Ofis', mode: 'MANUAL', status: 'ACTIVE', properties: {}, lastSeenAt: new Date() };

function build(over: { command?: Record<string, unknown> | null; devices?: unknown[] } = {}) {
  const registry = new McpToolRegistry();
  const devices = {
    list: jest.fn().mockResolvedValue(over.devices ?? [ONLINE_DEVICE]),
    enqueue: jest.fn().mockResolvedValue({ id: 'cmd-1', status: 'QUEUED' }),
    history: jest.fn().mockResolvedValue([]),
    findCommand: jest.fn().mockResolvedValue(over.command ?? null),
  };
  const principals = { resolve: jest.fn().mockResolvedValue({ id: 'user-1' }) };
  registerDeviceTools(registry, { devices: devices as never, principals: principals as never });
  return { registry, devices, principals };
}

const ctx = { workspaceId: CALLER_WS, grantedScopes: [] as string[] };

describe('device tool declarations', () => {
  it('gates a phone command behind approval, at send scope, and never advertises it', () => {
    const { registry } = build();
    const cmd = registry.get('jeeta.device_command')!;
    // `requiresApproval` is the field McpBrokerService.invoke branches on. It
    // is the whole safety story at this layer: everything else here is a label.
    expect(cmd.requiresApproval).toBe(true);
    expect(cmd.approvalKind).toBe('PUBLISH');
    expect(cmd.scopes).toEqual(['campaigns.send']);
    expect(cmd.risk).toBe('WRITE');
    for (const name of ['jeeta.list_devices', 'jeeta.device_command', 'jeeta.device_command_result']) {
      expect(registry.get(name)!.domain).toBe('devices');
      expect(registry.get(name)!.defer).toBe(true);
    }
  });

  it('offers no way to run a shell command', () => {
    const { registry } = build();
    const kinds = (registry.get('jeeta.device_command')!.inputSchema as never as {
      shape: { kind: { options: string[] } };
    }).shape.kind.options;
    expect(kinds).not.toContain('SHELL');
    expect(kinds).toContain('OPEN_URL');
  });
});

describe('jeeta.list_devices', () => {
  it('reads only the caller workspace and says whether the bridge is actually there', async () => {
    const fresh = new Date(Date.now() - 5_000);
    const stale = new Date(Date.now() - 10 * 60_000);
    const { registry, devices } = build({
      devices: [
        { id: 'd1', label: 'Ofis', mode: 'MANUAL', status: 'ACTIVE', properties: {}, lastSeenAt: fresh },
        { id: 'd2', label: 'Yedek', mode: 'MANUAL', status: 'ACTIVE', properties: {}, lastSeenAt: stale },
        { id: 'd3', label: 'Hiç', mode: 'MANUAL', status: 'ACTIVE', properties: {}, lastSeenAt: null },
      ],
    });
    const out = (await registry.get('jeeta.list_devices')!.handler(ctx as never, {})) as {
      id: string;
      bridgeOnline: boolean;
    }[];
    expect(devices.list).toHaveBeenCalledWith(CALLER_WS);
    expect(out.map((d) => d.bridgeOnline)).toEqual([true, false, false]);
  });
});

describe('jeeta.device_command', () => {
  it('queues under the CALLER workspace even when a foreign one is smuggled into a free-text field', async () => {
    const { registry, devices } = build();
    await registry.get('jeeta.device_command')!.handler(ctx as never, {
      deviceId: `${FOREIGN_WS}-device`,
      kind: 'OPEN_URL',
      url: `https://wa.me/905551112233?text=${FOREIGN_WS}`,
    });
    expect(devices.enqueue.mock.calls[0][0]).toBe(CALLER_WS);
    expect(JSON.stringify(devices.enqueue.mock.calls[0]).includes(`"${FOREIGN_WS}"`)).toBe(false);
  });

  it('forwards only the arguments its kind uses', async () => {
    const { registry, devices } = build();
    await registry.get('jeeta.device_command')!.handler(ctx as never, {
      deviceId: 'd1',
      kind: 'TAP',
      x: 10,
      y: 20,
      // A model that fills every optional field must not smuggle a URL into a
      // tap: the queue would validate a TAP and the phone would open a link.
      url: 'https://example.com/evil',
      text: 'hello',
    });
    expect(devices.enqueue).toHaveBeenCalledWith(CALLER_WS, 'd1', 'TAP', { x: 10, y: 20 }, expect.anything());
  });

  it('does not sit out the wait for a phone whose bridge is not connected', async () => {
    const started = Date.now();
    const { registry } = build({ devices: [{ ...ONLINE_DEVICE, lastSeenAt: new Date(Date.now() - 10 * 60_000) }] });
    const out = (await registry.get('jeeta.device_command')!.handler(ctx as never, {
      deviceId: 'd1',
      kind: 'SCREENSHOT',
    })) as { status: string; note?: string };
    expect(out.status).toBe('QUEUED');
    expect(out.note).toMatch(/not connected/i);
    // The point of the check: no poll loop at all, so this returns at once.
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('folds a named tap into one selector, and drops the fields that kind does not use', async () => {
    const { registry, devices } = build();
    await registry.get('jeeta.device_command')!.handler(ctx as never, {
      deviceId: 'd1',
      kind: 'TAP_ON',
      element: 'Gönder',
      elementBy: 'desc',
      occurrence: 2,
      // A model that fills in every optional field must not turn a named tap
      // into a link-opening command.
      url: 'https://example.com/evil',
      x: 10,
    });
    expect(devices.enqueue).toHaveBeenCalledWith(
      CALLER_WS,
      'd1',
      'TAP_ON',
      { desc: 'Gönder', occurrence: 2 },
      expect.anything(),
    );
  });

  it('defaults a named tap to matching on visible text', async () => {
    const { registry, devices } = build();
    await registry.get('jeeta.device_command')!.handler(ctx as never, {
      deviceId: 'd1',
      kind: 'TAP_ON',
      element: 'Ayşe Yılmaz',
    });
    expect(devices.enqueue.mock.calls[0][3]).toEqual({ text: 'Ayşe Yılmaz' });
  });

  it('teaches the look-then-tap loop in its own description', () => {
    // The only place a model learns this. A tool that offers TAP and TAP_ON
    // side by side without saying which to reach for gets coordinate-tapping
    // by default, which is the failure mode TAP_ON exists to remove.
    const desc = build().registry.get('jeeta.device_command')!.description;
    expect(desc).toMatch(/UI_DUMP first/i);
    expect(desc).toMatch(/Prefer TAP_ON over TAP/i);
  });

  it('reports a command nobody has run as QUEUED rather than as a result', async () => {
    const { registry } = build({ command: null });
    const out = (await registry.get('jeeta.device_command')!.handler(ctx as never, {
      deviceId: 'd1',
      kind: 'SCREENSHOT',
    })) as { status: string; commandId: string; note?: string };
    expect(out.status).toBe('QUEUED');
    expect(out.commandId).toBe('cmd-1');
    expect(out.note).toMatch(/device_command_result/);
  });

  it('reports a refusal as a refusal, and tells the caller not to retry it', async () => {
    const { registry } = build({
      command: { id: 'cmd-1', status: 'REFUSED', result: null, error: null },
    });
    const out = (await registry.get('jeeta.device_command')!.handler(ctx as never, {
      deviceId: 'd1',
      kind: 'OPEN_URL',
      url: 'https://wa.me/905551112233',
    })) as { status: string; note?: string };
    expect(out.status).toBe('REFUSED');
    expect(out.note).toMatch(/normal outcome/i);
  });

  it('waits out a command still being claimed instead of calling it done', async () => {
    // CLAIMED means the bridge has it and a human is looking at the approval
    // card. Treating that as settled is how "we queued it" becomes "we did it".
    const { registry } = build({ command: { id: 'cmd-1', status: 'CLAIMED', result: null, error: null } });
    const out = (await registry.get('jeeta.device_command')!.handler(ctx as never, {
      deviceId: 'd1',
      kind: 'SCREENSHOT',
    })) as { status: string };
    expect(out.status).toBe('QUEUED');
  });
});

describe('jeeta.device_command_result', () => {
  it('scopes its read to the caller workspace and admits when it has nothing', async () => {
    const { registry, devices } = build({ command: null });
    const out = (await registry.get('jeeta.device_command_result')!.handler(ctx as never, {
      deviceId: 'd1',
      commandId: 'cmd-404',
    })) as { status: string };
    expect(devices.findCommand).toHaveBeenCalledWith(CALLER_WS, 'cmd-404');
    expect(out.status).toBe('NOT_FOUND');
  });

  it('will not answer with a command that belongs to a different phone', async () => {
    // The id is enough to fetch the row; the deviceId in the call is what the
    // caller BELIEVES it is asking about. Returning the row regardless would
    // answer a question nobody asked.
    const { registry } = build({
      command: { id: 'cmd-1', deviceId: 'd-other', status: 'DONE', kind: 'TAP', result: null, error: null },
    });
    const out = (await registry.get('jeeta.device_command_result')!.handler(ctx as never, {
      deviceId: 'd1',
      commandId: 'cmd-1',
    })) as { status: string };
    expect(out.status).toBe('NOT_FOUND');
  });

  it('returns the row when it does belong to that phone', async () => {
    const { registry } = build({
      command: { id: 'cmd-1', deviceId: 'd1', status: 'DONE', kind: 'TAP', result: { ok: true }, error: null },
    });
    const out = (await registry.get('jeeta.device_command_result')!.handler(ctx as never, {
      deviceId: 'd1',
      commandId: 'cmd-1',
    })) as { status: string; kind: string };
    expect(out.status).toBe('DONE');
    expect(out.kind).toBe('TAP');
  });
});
