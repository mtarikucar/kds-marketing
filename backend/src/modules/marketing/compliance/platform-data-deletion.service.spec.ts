import { createHmac } from 'node:crypto';
import { ForbiddenException, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { PlatformDataDeletionService } from './platform-data-deletion.service';

const SECRET = 'meta-app-secret-under-test';
const BASE = 'https://jeetagrowth.com';

/** A REAL Meta signed_request (`base64url(sig).base64url(json)`). */
function sign(userId: string, secret = SECRET): string {
  const body = Buffer.from(
    JSON.stringify({
      algorithm: 'HMAC-SHA256',
      issued_at: Math.floor(Date.now() / 1000),
      user_id: userId,
    }),
  ).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${sig}.${body}`;
}

interface Call {
  call: string;
  args: any;
}

/**
 * Recording fake. `jest.spyOn` on a Prisma delegate does not stick (the delegate
 * is a lazily-built proxy), so every delegate here is its own Proxy that records
 * the call and answers from a per-method script.
 */
function recordingPrisma(identities: Array<{ workspaceId: string; leadId: string; kind: string; value: string }>) {
  const seen: Call[] = [];
  const rows: any[] = [];
  // Mutable per-delegate scripts. A spec overrides one by assigning into THIS
  // object — assigning onto the delegate itself would not stick, because the
  // delegate is a Proxy that mints a fresh jest.fn on every property read (the
  // same reason `jest.spyOn` on a real Prisma delegate does not stick).
  const scripts: Record<string, Record<string, any>> = {
    contactIdentity: {
      findMany: (args: any) =>
        identities.filter(
          (i) =>
            i.value === args?.where?.value &&
            (args?.where?.kind?.in ? args.where.kind.in.includes(i.kind) : true),
        ),
    },
    platformDeletionRequest: {
      findFirst: () => null,
      create: (args: any) => {
        const row = { id: `pdr-${rows.length + 1}`, ...args.data };
        rows.push(row);
        return row;
      },
      update: (args: any) => {
        const row = rows.find((r) => r.id === args.where.id);
        Object.assign(row, args.data);
        return row;
      },
    },
  };

  const delegate = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) =>
          jest.fn((args: any) => {
            seen.push({ call: `${name}.${String(method)}`, args });
            const r = scripts[name]?.[String(method)];
            return Promise.resolve(typeof r === 'function' ? r(args) : (r ?? null));
          }),
      },
    );

  const prisma = new Proxy({} as any, {
    get: (target, prop: string) => {
      if (!(prop in target)) target[prop] = delegate(String(prop));
      return target[prop];
    },
  });
  return { prisma, seen, rows, scripts };
}

function makeSvc(identities: Array<{ workspaceId: string; leadId: string; kind: string; value: string }> = []) {
  const { prisma, seen, rows, scripts } = recordingPrisma(identities);
  const erasures: Array<{ fn: string; workspaceId: string; arg: string }> = [];
  let n = 0;
  const compliance = {
    requestErasure: jest.fn(async (workspaceId: string, leadId: string) => {
      erasures.push({ fn: 'requestErasure', workspaceId, arg: leadId });
      return { id: `dr-${++n}` } as any;
    }),
    fulfillErasure: jest.fn(async (workspaceId: string, requestId: string) => {
      erasures.push({ fn: 'fulfillErasure', workspaceId, arg: requestId });
      return { id: requestId, status: 'COMPLETED', leadId: 'x' } as any;
    }),
  };
  const svc = new PlatformDataDeletionService(prisma as any, compliance as any);
  return { svc, prisma, seen, rows, scripts, compliance, erasures };
}

describe('PlatformDataDeletionService — Meta data deletion callback', () => {
  beforeEach(() => {
    process.env.META_APP_SECRET = SECRET;
    process.env.PUBLIC_BASE_URL = BASE;
  });
  afterEach(() => {
    delete process.env.META_APP_SECRET;
    delete process.env.PUBLIC_BASE_URL;
  });

  // ── signature verification IS the security of this endpoint ────────────────

  it('REFUSES a forged signed_request and erases NOTHING', async () => {
    const { svc, compliance, rows } = makeSvc([
      { workspaceId: 'ws-A', leadId: 'lead-A', kind: 'PSID', value: '4242' },
    ]);
    await expect(svc.handleMetaRequest(sign('4242', 'wrong-secret'), BASE)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(compliance.requestErasure).not.toHaveBeenCalled();
    expect(compliance.fulfillErasure).not.toHaveBeenCalled();
    // Not even a record: an unverified request is not a request.
    expect(rows).toEqual([]);
  });

  it('refuses a malformed signed_request (400) and an unconfigured app (503)', async () => {
    const { svc } = makeSvc();
    await expect(svc.handleMetaRequest('garbage', BASE)).rejects.toBeInstanceOf(BadRequestException);
    delete process.env.META_APP_SECRET;
    await expect(svc.handleMetaRequest(sign('4242'), BASE)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  // ── happy path: resolve → reuse the audited erasure ────────────────────────

  it('resolves the id through ContactIdentity and erases via ComplianceService (no second deletion path)', async () => {
    const { svc, compliance, rows } = makeSvc([
      { workspaceId: 'ws-A', leadId: 'lead-A', kind: 'PSID', value: '4242' },
    ]);
    const res = await svc.handleMetaRequest(sign('4242'), BASE);

    expect(compliance.requestErasure).toHaveBeenCalledWith('ws-A', 'lead-A');
    expect(compliance.fulfillErasure).toHaveBeenCalledWith('ws-A', 'dr-1');
    expect(res.confirmation_code).toMatch(/^[a-z0-9]{16,}$/i);
    expect(res.url).toBe(`${BASE}/data-deletion-status?code=${res.confirmation_code}`);
    expect(rows[0]).toMatchObject({ platform: 'META', status: 'COMPLETED', matchedLeads: 1 });
    expect(rows[0].dataRequestIds).toEqual(['dr-1']);
  });

  it('matches the Instagram-scoped id too (IGSID), and never the raw id in plaintext', async () => {
    const { svc, compliance, rows } = makeSvc([
      { workspaceId: 'ws-A', leadId: 'lead-IG', kind: 'IGSID', value: '17841400000000000' },
    ]);
    await svc.handleMetaRequest(sign('17841400000000000'), BASE);
    expect(compliance.fulfillErasure).toHaveBeenCalledWith('ws-A', 'dr-1');
    // The stored subject is a SHA-256, so the request record cannot re-create an
    // identifier for someone who just asked to be forgotten.
    expect(rows[0].subjectHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows[0])).not.toContain('17841400000000000');
  });

  // ── tenant isolation ───────────────────────────────────────────────────────

  it('erases each match under its OWN workspace — a shared id across tenants never crosses over', async () => {
    // Cross-stamped probes: the SAME platform id lives in two tenants (possible:
    // ContactIdentity is unique on (channelId, value), not on value alone).
    const { svc, erasures, seen } = makeSvc([
      { workspaceId: 'ws-A', leadId: 'lead-A', kind: 'PSID', value: '4242' },
      { workspaceId: 'ws-B', leadId: 'lead-B', kind: 'PSID', value: '4242' },
    ]);
    await svc.handleMetaRequest(sign('4242'), BASE);

    // ws-A's lead is erased under ws-A and ONLY ws-A …
    expect(erasures).toContainEqual({ fn: 'requestErasure', workspaceId: 'ws-A', arg: 'lead-A' });
    expect(erasures).not.toContainEqual({ fn: 'requestErasure', workspaceId: 'ws-B', arg: 'lead-A' });
    // … and ws-B's under ws-B and ONLY ws-B.
    expect(erasures).toContainEqual({ fn: 'requestErasure', workspaceId: 'ws-B', arg: 'lead-B' });
    expect(erasures).not.toContainEqual({ fn: 'requestErasure', workspaceId: 'ws-A', arg: 'lead-B' });
    // The fulfil of each request runs under the same workspace that raised it.
    expect(erasures.filter((e) => e.fn === 'fulfillErasure').map((e) => e.workspaceId).sort()).toEqual([
      'ws-A',
      'ws-B',
    ]);
    // The one deliberately cross-workspace read is the identity probe itself.
    expect(seen.filter((s) => s.call === 'contactIdentity.findMany')).toHaveLength(1);
  });

  it('erases a lead once even when the same person has several identities in one workspace', async () => {
    const { svc, compliance } = makeSvc([
      { workspaceId: 'ws-A', leadId: 'lead-A', kind: 'PSID', value: '4242' },
      { workspaceId: 'ws-A', leadId: 'lead-A', kind: 'IGSID', value: '4242' },
    ]);
    await svc.handleMetaRequest(sign('4242'), BASE);
    expect(compliance.requestErasure).toHaveBeenCalledTimes(1);
  });

  // ── honesty: error ≠ empty ─────────────────────────────────────────────────

  it('RECORDS an unmatched request instead of reporting a deletion that did not happen', async () => {
    const { svc, compliance, rows } = makeSvc([
      { workspaceId: 'ws-A', leadId: 'lead-A', kind: 'PSID', value: 'someone-else' },
    ]);
    const res = await svc.handleMetaRequest(sign('an-app-scoped-id-we-never-stored'), BASE);

    expect(compliance.requestErasure).not.toHaveBeenCalled();
    // Still a valid Meta response — refusing would just make Meta retry forever.
    expect(res.confirmation_code).toMatch(/^[a-z0-9]{16,}$/i);
    expect(res.url).toContain('/data-deletion-status?code=');
    // …but the state says what actually happened.
    expect(rows[0]).toMatchObject({ status: 'UNMATCHED', matchedLeads: 0 });
    expect(rows[0].status).not.toBe('COMPLETED');
  });

  it('records FAILED (not COMPLETED, not a 500) when the erasure itself errors', async () => {
    const { svc, compliance, rows } = makeSvc([
      { workspaceId: 'ws-A', leadId: 'lead-A', kind: 'PSID', value: '4242' },
    ]);
    compliance.fulfillErasure.mockRejectedValueOnce(new Error('db down'));
    const res = await svc.handleMetaRequest(sign('4242'), BASE);
    expect(res.confirmation_code).toMatch(/^[a-z0-9]{16,}$/i);
    expect(rows[0]).toMatchObject({ status: 'FAILED' });
  });

  it('is idempotent under Meta retries — the same subject gets back the same code', async () => {
    const { svc, scripts, rows } = makeSvc([
      { workspaceId: 'ws-A', leadId: 'lead-A', kind: 'PSID', value: '4242' },
    ]);
    const first = await svc.handleMetaRequest(sign('4242'), BASE);
    // Second delivery of the same callback: the recent row is found and reused.
    scripts.platformDeletionRequest.findFirst = () => rows[0];
    const second = await svc.handleMetaRequest(sign('4242'), BASE);
    expect(second.confirmation_code).toBe(first.confirmation_code);
    expect(rows).toHaveLength(1);
  });

  // ── the status page's data ─────────────────────────────────────────────────

  it('serves the status of a code, and null (not an empty success) for an unknown one', async () => {
    const { svc, scripts } = makeSvc();
    scripts.platformDeletionRequest.findFirst = (args: any) =>
      args.where.confirmationCode === 'known'
        ? { confirmationCode: 'known', status: 'COMPLETED', receivedAt: new Date(0), completedAt: new Date(1), matchedLeads: 1 }
        : null;
    expect(await svc.statusByCode('known')).toMatchObject({ status: 'COMPLETED' });
    expect(await svc.statusByCode('nope')).toBeNull();
  });

  it('never returns the subject hash or any platform id on the public status', async () => {
    const { svc, scripts } = makeSvc();
    scripts.platformDeletionRequest.findFirst = () => ({
      confirmationCode: 'known',
      status: 'COMPLETED',
      receivedAt: new Date(0),
      completedAt: new Date(1),
      matchedLeads: 1,
      subjectHash: 'deadbeef',
    });
    const out = await svc.statusByCode('known');
    expect(JSON.stringify(out)).not.toContain('deadbeef');
    expect(Object.keys(out!).sort()).toEqual(['completedAt', 'confirmationCode', 'receivedAt', 'status']);
  });
});
