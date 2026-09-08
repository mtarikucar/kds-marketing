import { z } from 'zod';
import { DevicesService } from '../../devices/devices.service';
import { DEVICE_COMMAND_KINDS, ALLOWED_KEYS } from '../../devices/device-commands';
import { McpPrincipalService } from '../mcp-principal.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface DeviceToolDeps {
  devices: DevicesService;
  principals: McpPrincipalService;
}

/**
 * How long `jeeta.device_command` waits for the phone before answering.
 *
 * A bounded wait rather than fire-and-forget, because an agent that has to
 * poll for every tap writes six turns where one would do — and rather than an
 * unbounded one, because the thing it is waiting for is a human deciding, and
 * a human may be at lunch. When the wait runs out the answer is "still
 * waiting", which is true, and the id is returned so the outcome can be read
 * later.
 */
const WAIT_MS = Number(process.env.MCP_DEVICE_WAIT_MS ?? 25_000);
const POLL_MS = 750;

export function registerDeviceTools(registry: McpToolRegistry, deps: DeviceToolDeps): void {
  registry.register({
    name: 'jeeta.list_devices',
    description:
      'List the phones this workspace has paired, with their mode (MANUAL = a person approves every command; AUTO = they do not), their status, and when the desktop bridge was last seen. A device whose bridge has not been seen for minutes is a laptop that is closed or a cable that is out — nothing queued for it will run until it is back. Read-only.',
    domain: 'devices',
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    // Every device tool is DEFERRED, and unlike every other domain none of
    // them is advertised. Two reasons, and the second is the one that makes it
    // safe. First: a paired phone is opt-in hardware, so for essentially every
    // workspace this domain is three tools that can only ever answer "no
    // phone" — the exact per-session cost the advertised ceiling exists to
    // stop. Second: the domain word itself ships advertised regardless, inside
    // `jeeta.find_tools`'s own `domain` enum, so `find_tools({domain:
    // 'devices'})` reaches all three without any of them holding a slot. The
    // usual "keep one advertised member per domain" rule buys reachability we
    // already have here.
    defer: true,
    inputSchema: z.object({}),
    handler: async (ctx) => {
      const devices = await deps.devices.list(ctx.workspaceId);
      const now = Date.now();
      return devices.map((d) => ({
        id: d.id,
        label: d.label,
        mode: d.mode,
        status: d.status,
        properties: d.properties,
        lastSeenAt: d.lastSeenAt,
        // Stated rather than left to the caller's arithmetic: "online" is the
        // question every use of this list is really asking.
        bridgeOnline: Boolean(d.lastSeenAt && now - new Date(d.lastSeenAt).getTime() < 90_000),
      }));
    },
  });

  registry.register({
    name: 'jeeta.device_command',
    description:
      'Ask a paired phone to do ONE thing: open a link (https or tel — this is how a WhatsApp click-to-chat draft is put on screen), launch an app, tap, swipe, type, press a key, take a screenshot, or read the on-screen elements. ' +
      'IMPORTANT: this QUEUES the command. It has not happened when this returns. The phone is on somebody\'s desk behind a cable, the laptop may be closed, and on a MANUAL device a person must approve it — they may refuse, which is a normal outcome and not an error. This waits a short while for a result and then reports honestly whether one arrived. ' +
      'There is no shell command and there never will be.',
    domain: 'devices',
    // The same scope that gates sending on a customer's behalf. Making a
    // phone act under the workspace's name belongs in that class, not in the
    // read class, whatever the individual command happens to be.
    scopes: ['campaigns.send'],
    // WRITE, not SPEND: no money moves. But it is the riskiest WRITE in the
    // product, because the effect is outside the product — on a real handset,
    // in someone's real WhatsApp — and cannot be undone by a compensating row.
    risk: 'WRITE',
    requiresApproval: true,
    approvalKind: 'PUBLISH',
    defer: true,
    inputSchema: z.object({
      deviceId: z.string().min(1).describe('From jeeta.list_devices.'),
      kind: z.enum(DEVICE_COMMAND_KINDS).describe('What to do.'),
      url: z
        .string()
        .max(4000)
        .optional()
        .describe('OPEN_URL only. https or tel. e.g. https://wa.me/905551112233?text=<url-encoded>'),
      package: z.string().max(200).optional().describe('LAUNCH_APP only, e.g. com.whatsapp'),
      text: z.string().max(4000).optional().describe('TEXT only — the characters to type.'),
      key: z.enum(ALLOWED_KEYS).optional().describe('KEY only.'),
      x: z.number().optional(),
      y: z.number().optional(),
      x1: z.number().optional(),
      y1: z.number().optional(),
      x2: z.number().optional(),
      y2: z.number().optional(),
      durationMs: z.number().optional().describe('SWIPE only. Default 300.'),
    }),
    handler: async (ctx, args) => {
      const actor = await deps.principals.resolve(ctx);
      // The flat argument list is folded into the shape the queue validates,
      // rather than the tool taking a free-form `args` object: a schema the
      // model can read wrong in one place is better than one it can read wrong
      // in any place.
      const byKind: Record<string, Record<string, unknown>> = {
        TAP: { x: args.x, y: args.y },
        SWIPE: { x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2, durationMs: args.durationMs },
        TEXT: { value: args.text },
        KEY: { key: args.key },
        OPEN_URL: { url: args.url },
        LAUNCH_APP: { package: args.package },
        SCREENSHOT: {},
        UI_DUMP: {},
      };

      const queued = await deps.devices.enqueue(
        ctx.workspaceId,
        String(args.deviceId),
        String(args.kind),
        byKind[String(args.kind)] ?? {},
        { source: 'mcp', requestedBy: actor?.id ?? undefined },
      );

      // Do not sit out the full wait for a phone that provably cannot answer.
      // The bridge heartbeats every 30s, so silence longer than that means the
      // laptop is closed or the cable is out — waiting 25 seconds to discover
      // it stalls the caller and teaches nothing. The command still STANDS: it
      // has a ten-minute life and runs when the desktop app comes back.
      const online = await bridgeIsOnline(deps, ctx.workspaceId, String(args.deviceId));
      if (!online) {
        return {
          commandId: queued.id,
          status: 'QUEUED',
          note: 'Queued, but the desktop app next to the phone is not connected right now — nothing will run until it is back. The command expires in about ten minutes.',
        };
      }

      const settled = await waitForOutcome(deps, ctx.workspaceId, queued.id);
      if (!settled) {
        return {
          commandId: queued.id,
          status: 'QUEUED',
          note: 'Still waiting — the bridge has not picked this up, or a person has not decided yet. Read it later with jeeta.device_command_result.',
        };
      }
      return {
        commandId: settled.id,
        status: settled.status,
        ...(settled.status === 'REFUSED'
          ? { note: 'The person at the phone declined. This is a normal outcome — do not retry it as if it had failed.' }
          : {}),
        result: settled.result ?? null,
        error: settled.error ?? null,
      };
    },
  });

  registry.register({
    name: 'jeeta.device_command_result',
    description:
      'Read what became of a queued device command — DONE, FAILED, REFUSED (the person said no), EXPIRED (nobody collected it in time) or still QUEUED. Read-only.',
    domain: 'devices',
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    defer: true,
    inputSchema: z.object({
      deviceId: z.string().min(1),
      commandId: z.string().min(1),
    }),
    handler: async (ctx, args) => {
      // Fetched by id, not by scanning a page of history: a phone that has
      // been used for a week pushes the command you asked about off the end of
      // any fixed window, and "NOT_FOUND" for a row that exists is the worst
      // answer this tool could give. `deviceId` stays required — it is what
      // makes the caller name the phone it means, and the row is checked
      // against it rather than trusted.
      const row = await deps.devices.findCommand(ctx.workspaceId, String(args.commandId));
      if (!row || row.deviceId !== String(args.deviceId)) {
        return { commandId: args.commandId, status: 'NOT_FOUND' };
      }
      return {
        commandId: row.id,
        kind: row.kind,
        status: row.status,
        result: row.result ?? null,
        error: row.error ?? null,
        completedAt: row.completedAt,
      };
    },
  });
}

/** Whether the desktop bridge has been heard from recently enough to act.
 *  Same 90s window `jeeta.list_devices` reports, so the two never disagree. */
async function bridgeIsOnline(
  deps: DeviceToolDeps,
  workspaceId: string,
  deviceId: string,
): Promise<boolean> {
  const device = (await deps.devices.list(workspaceId)).find((d) => d.id === deviceId);
  return Boolean(device?.lastSeenAt && Date.now() - new Date(device.lastSeenAt).getTime() < 90_000);
}

/** Poll the row until it leaves the queue, or the wait runs out. */
async function waitForOutcome(
  deps: DeviceToolDeps,
  workspaceId: string,
  commandId: string,
): Promise<{ id: string; status: string; result: unknown; error: string | null } | null> {
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const row = await deps.devices.findCommand(workspaceId, commandId);
    if (row && !['QUEUED', 'CLAIMED'].includes(row.status)) {
      return { id: row.id, status: row.status, result: row.result, error: row.error };
    }
  }
  return null;
}
