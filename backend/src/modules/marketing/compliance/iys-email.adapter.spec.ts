import { sealSecret } from '../../../common/crypto/secret-box.helper';
import { IysEmailAdapter } from './iys-email.adapter';
import { IYS_EPOSTA_BUDGET_BUCKET, IYS_EPOSTA_MESSAGE_KEY } from './iys-email.port';

const WS = 'ws-1';
const ADDR = 'Musteri@Acme.com';
const KEY = 'musteri@acme.com';

process.env.MARKETING_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');

/** `settings.email.iys.eposta = true` — the one switch that arms the gate. */
function armed(extra: Record<string, unknown> = {}) {
  return { email: { iys: { eposta: true } }, ...extra };
}

/** Workspace-level credentials: an email-only tenant has no SMS channel. */
function workspaceCreds() {
  return { iys: { usercode: 'uc-ws', passwordSealed: sealSecret('pw-ws'), brandCode: 'BRAND-WS' } };
}

function makeAdapter(opts: {
  settings?: unknown;
  channels?: any[];
  lead?: any;
  search?: any;
  budget?: boolean;
} = {}) {
  const prisma: any = {
    workspace: { findUnique: jest.fn().mockResolvedValue({ settings: opts.settings ?? null }) },
    channel: { findMany: jest.fn().mockResolvedValue(opts.channels ?? []) },
    lead: {
      findFirst: jest.fn().mockResolvedValue(opts.lead ?? null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const registry = {
    resolveConfig: jest.fn((ch: any) => ({ secrets: ch.secrets ?? {}, public: ch.public ?? {} })),
  };
  const budgeter = { tryTake: jest.fn().mockReturnValue(opts.budget ?? true) };
  const client = {
    search: jest.fn().mockResolvedValue(opts.search ?? { ok: true, status: 'ONAY', message: null }),
  };
  const svc = new IysEmailAdapter(prisma, registry as any, budgeter as any, client as any);
  return { prisma, registry, budgeter, client, svc };
}

/** An ACTIVE SMS channel carrying NetGSM creds — the fallback credential source. */
function smsChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ch-1',
    workspaceId: WS,
    type: 'SMS',
    status: 'ACTIVE',
    secrets: { usercode: 'uc-sms', password: 'pw-sms' },
    public: { brandCode: 'BRAND-SMS' },
    ...overrides,
  };
}

function bulk(extra: Record<string, unknown> = {}) {
  return { workspaceId: WS, address: ADDR, mailClass: 'BULK' as const, ticari: true, ...extra };
}

describe('IysEmailAdapter', () => {
  describe('inert by default', () => {
    it('does not arm itself: an unconfigured workspace never calls İYS and never blocks', async () => {
      const { svc, prisma, budgeter, client } = makeAdapter({ settings: null });

      const verdict = await svc.check(bulk());

      expect(verdict).toEqual({ status: 'UNKNOWN', refusal: null, gap: 'NOT_ARMED' });
      expect(client.search).not.toHaveBeenCalled();
      expect(budgeter.tryTake).not.toHaveBeenCalled();
      // Not armed is decided from the workspace row alone: no lead read either.
      expect(prisma.lead.findFirst).not.toHaveBeenCalled();
    });

    it('armed but with no credentials says what is missing instead of failing', async () => {
      const { svc, client } = makeAdapter({ settings: armed(), channels: [] });

      const verdict = await svc.check(bulk());

      expect(verdict.status).toBe('UNKNOWN');
      expect(verdict.refusal).toBeNull();
      expect(verdict.gap).toBe('NO_CREDENTIALS');
      expect(client.search).not.toHaveBeenCalled();
    });

    it('armed with creds but no brand code is a no-op, not a block', async () => {
      const channel = smsChannel({ public: {} });
      const { svc, client } = makeAdapter({ settings: armed(), channels: [channel] });

      const verdict = await svc.check(bulk());

      expect(verdict).toEqual({ status: 'UNKNOWN', refusal: null, gap: 'NO_BRAND_CODE' });
      expect(client.search).not.toHaveBeenCalled();
    });

    it('never throws when the workspace cannot be read — an unreadable switch is an off switch', async () => {
      const { svc, prisma, client } = makeAdapter();
      prisma.workspace.findUnique.mockRejectedValue(new Error('db down'));

      const verdict = await svc.check(bulk());

      expect(verdict.refusal).toBeNull();
      expect(verdict.gap).toBe('NOT_ARMED');
      expect(client.search).not.toHaveBeenCalled();
    });
  });

  describe('the gate matrix decides who is asked', () => {
    it('asks nothing for a BİLGİLENDİRME bulk mail', async () => {
      const { svc, client, prisma } = makeAdapter({ settings: armed(), channels: [smsChannel()] });

      const verdict = await svc.check(bulk({ ticari: false }));

      expect(verdict).toEqual({ status: 'UNKNOWN', refusal: null });
      expect(client.search).not.toHaveBeenCalled();
      expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
    });

    it('hands back a fresh verdict each time — no caller can poison the next one', async () => {
      const { svc } = makeAdapter({ settings: armed(), channels: [smsChannel()] });

      const first = await svc.check(bulk({ ticari: false }));
      (first as any).refusal = { reason: 'IYS_RET', retriable: false };
      const second = await svc.check(bulk({ ticari: false }));

      expect(second.refusal).toBeNull();
    });

    it.each(['AUTH', 'INTERNAL', 'TRANSACTIONAL', 'CONVERSATIONAL'] as const)(
      'never blocks %s mail, even to a RET address',
      async (mailClass) => {
        const { svc, client } = makeAdapter({
          settings: armed(),
          channels: [smsChannel()],
          search: { ok: true, status: 'RET', message: null },
        });

        const verdict = await svc.check(bulk({ mailClass }));

        expect(verdict.refusal).toBeNull();
        expect(client.search).not.toHaveBeenCalled();
      },
    );
  });

  describe('the verdict', () => {
    it('RET refuses a TİCARİ bulk mail with IYS_RET, terminally', async () => {
      const { svc } = makeAdapter({
        settings: armed(),
        channels: [smsChannel()],
        search: { ok: true, status: 'RET', message: null },
      });

      const verdict = await svc.check(bulk());

      expect(verdict.status).toBe('RET');
      expect(verdict.refusal).toEqual({ reason: 'IYS_RET', retriable: false });
    });

    it('YOK refuses too — İYS holding no record is not permission', async () => {
      const { svc } = makeAdapter({
        settings: armed(),
        channels: [smsChannel()],
        search: { ok: true, status: 'YOK', message: null },
      });

      const verdict = await svc.check(bulk());

      expect(verdict.status).toBe('YOK');
      expect(verdict.refusal?.reason).toBe('IYS_RET');
    });

    it('ONAY lets the mail through and caches the answer on every lead sharing the address', async () => {
      const { svc, prisma, client } = makeAdapter({ settings: armed(), channels: [smsChannel()] });

      const verdict = await svc.check(bulk());

      expect(verdict.refusal).toBeNull();
      expect(verdict.status).toBe('ONAY');
      expect(client.search).toHaveBeenCalledWith(
        { usercode: 'uc-sms', password: 'pw-sms', brandCode: 'BRAND-SMS' },
        KEY,
        'EPOSTA',
      );
      const args = prisma.lead.updateMany.mock.calls[0][0];
      expect(args.where).toEqual({ workspaceId: WS, emailNormalized: KEY });
      expect(args.data.iysEmailStatus).toBe('ONAY');
      expect(args.data.iysEmailCheckedAt).toBeInstanceOf(Date);
    });

    it('an İYS failure defers the mail instead of refusing it, and caches nothing', async () => {
      const { svc, prisma } = makeAdapter({
        settings: armed(),
        channels: [smsChannel()],
        search: { ok: false, status: null, message: 'NetGSM erişilemedi' },
      });

      const verdict = await svc.check(bulk());

      expect(verdict.status).toBe('UNKNOWN');
      expect(verdict.gap).toBe('UNREACHABLE');
      expect(verdict.refusal).toEqual({
        reason: 'TRANSIENT',
        retriable: true,
        error: 'NetGSM erişilemedi',
      });
      expect(prisma.lead.updateMany).not.toHaveBeenCalled();
    });

    it('an unclassifiable status is a failure, not an answer', async () => {
      const { svc, prisma } = makeAdapter({
        settings: armed(),
        channels: [smsChannel()],
        search: { ok: true, status: null, message: null },
      });

      const verdict = await svc.check(bulk());

      expect(verdict.refusal?.retriable).toBe(true);
      expect(prisma.lead.updateMany).not.toHaveBeenCalled();
    });

    it('an address İYS could never hold is not asked about, and is not refused here', async () => {
      const { svc, client } = makeAdapter({ settings: armed(), channels: [smsChannel()] });

      const verdict = await svc.check(bulk({ address: 'not an address' }));

      expect(verdict.gap).toBe('BAD_RECIPIENT');
      expect(verdict.refusal).toBeNull();
      expect(client.search).not.toHaveBeenCalled();
    });

    it('a cache write that fails does not fail the send', async () => {
      const { svc, prisma } = makeAdapter({ settings: armed(), channels: [smsChannel()] });
      prisma.lead.updateMany.mockRejectedValue(new Error('db down'));

      await expect(svc.check(bulk())).resolves.toMatchObject({ status: 'ONAY', refusal: null });
    });
  });

  describe('the caller’s workspace read', () => {
    it('uses settings the caller already read, instead of a read per recipient', async () => {
      // The gateway loads the workspace once for the kill switches; a campaign
      // tick asking for it again per recipient would be a query per send.
      const { svc, prisma, client } = makeAdapter({ settings: null, channels: [smsChannel()] });

      const verdict = await svc.check(bulk({ settings: armed() }));

      expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
      expect(client.search).toHaveBeenCalled();
      expect(verdict.status).toBe('ONAY');
    });

    it('treats a workspace with no settings at all as not armed, without re-reading it', async () => {
      const { svc, prisma } = makeAdapter({ settings: armed(), channels: [smsChannel()] });

      const verdict = await svc.check(bulk({ settings: null }));

      expect(verdict.gap).toBe('NOT_ARMED');
      expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('the budget', () => {
    it('spends the EPOSTA bucket, never the shared İYS one the SMS preflight lives on', async () => {
      const { svc, budgeter } = makeAdapter({ settings: armed(), channels: [smsChannel()] });

      await svc.check(bulk());

      expect(budgeter.tryTake).toHaveBeenCalledTimes(1);
      const [usercode, bucket, limit, windowMs] = budgeter.tryTake.mock.calls[0];
      expect(usercode).toBe('uc-sms');
      expect(bucket).toBe(IYS_EPOSTA_BUDGET_BUCKET);
      expect(bucket).not.toBe('iys');
      expect(limit).toBe(10);
      expect(windowMs).toBe(60_000);
    });

    it('defers rather than sends when the bucket is empty', async () => {
      const { svc, client } = makeAdapter({ settings: armed(), channels: [smsChannel()], budget: false });

      const verdict = await svc.check(bulk());

      expect(verdict.gap).toBe('RATE_LIMITED');
      expect(verdict.refusal).toEqual({ reason: 'TRANSIENT', retriable: true });
      expect(client.search).not.toHaveBeenCalled();
    });
  });

  describe('the lead cache', () => {
    it('a fresh cached answer spends no search and no budget unit', async () => {
      const { svc, client, budgeter } = makeAdapter({
        settings: armed(),
        channels: [smsChannel()],
        lead: { iysEmailStatus: 'ONAY', iysEmailCheckedAt: new Date() },
      });

      const verdict = await svc.check(bulk());

      expect(verdict).toEqual({ status: 'ONAY', refusal: null, cached: true });
      expect(client.search).not.toHaveBeenCalled();
      expect(budgeter.tryTake).not.toHaveBeenCalled();
    });

    it('a cached RET refuses without asking İYS again', async () => {
      const { svc, client } = makeAdapter({
        settings: armed(),
        channels: [smsChannel()],
        lead: { iysEmailStatus: 'RET', iysEmailCheckedAt: new Date() },
      });

      const verdict = await svc.check(bulk());

      expect(verdict.refusal?.reason).toBe('IYS_RET');
      expect(client.search).not.toHaveBeenCalled();
    });

    it('a stale answer is asked again — consent withdrawn yesterday must not ride a day-old ONAY', async () => {
      const { svc, client } = makeAdapter({
        settings: armed(),
        channels: [smsChannel()],
        lead: { iysEmailStatus: 'ONAY', iysEmailCheckedAt: new Date(Date.now() - 48 * 3_600_000) },
      });

      await svc.check(bulk());

      expect(client.search).toHaveBeenCalled();
    });

    it('a cached UNKNOWN is not an answer and is asked again', async () => {
      const { svc, client } = makeAdapter({
        settings: armed(),
        channels: [smsChannel()],
        lead: { iysEmailStatus: 'UNKNOWN', iysEmailCheckedAt: new Date() },
      });

      await svc.check(bulk());

      expect(client.search).toHaveBeenCalled();
    });
  });

  describe('credentials', () => {
    it('reads workspace-level İYS credentials, so an email-only tenant needs no SMS channel', async () => {
      const { svc, prisma, client, budgeter } = makeAdapter({
        settings: armed(workspaceCreds()),
        channels: [],
      });

      const verdict = await svc.check(bulk());

      expect(verdict.status).toBe('ONAY');
      expect(client.search).toHaveBeenCalledWith(
        { usercode: 'uc-ws', password: 'pw-ws', brandCode: 'BRAND-WS' },
        KEY,
        'EPOSTA',
      );
      expect(budgeter.tryTake.mock.calls[0][0]).toBe('uc-ws');
      expect(prisma.channel.findMany).not.toHaveBeenCalled();
    });

    it('falls back to the ACTIVE SMS channel when the workspace holds none', async () => {
      const { svc, client } = makeAdapter({ settings: armed(), channels: [smsChannel()] });

      await svc.check(bulk());

      expect(client.search.mock.calls[0][0]).toEqual({
        usercode: 'uc-sms',
        password: 'pw-sms',
        brandCode: 'BRAND-SMS',
      });
    });

    it('takes a workspace brand code over the channel one, and never a half credential pair', async () => {
      // Only a usercode at workspace level: the PAIR must still come from one
      // source, or we would sign requests with one tenant's user and another's
      // password and get an auth error nobody can explain.
      const { svc, client } = makeAdapter({
        settings: armed({ iys: { usercode: 'uc-ws', brandCode: 'BRAND-WS' } }),
        channels: [smsChannel()],
      });

      await svc.check(bulk());

      expect(client.search.mock.calls[0][0]).toEqual({
        usercode: 'uc-sms',
        password: 'pw-sms',
        brandCode: 'BRAND-WS',
      });
    });

    it('ignores a plaintext password in workspace settings — secrets are sealed or absent', async () => {
      const { svc, client } = makeAdapter({
        settings: armed({ iys: { usercode: 'uc-ws', password: 'pw-plain', brandCode: 'BRAND-WS' } }),
        channels: [],
      });

      const verdict = await svc.check(bulk());

      expect(verdict.gap).toBe('NO_CREDENTIALS');
      expect(client.search).not.toHaveBeenCalled();
    });

    it('skips an SMS channel with creds but no brand code and keeps scanning', async () => {
      const { svc, client } = makeAdapter({
        settings: armed(),
        channels: [
          smsChannel({ id: 'ch-a', public: {} }),
          smsChannel({ id: 'ch-b', secrets: { usercode: 'uc-b', password: 'pw-b' }, public: { brandCode: 'BRAND-B' } }),
        ],
      });

      await svc.check(bulk());

      expect(client.search.mock.calls[0][0]).toEqual({
        usercode: 'uc-b',
        password: 'pw-b',
        brandCode: 'BRAND-B',
      });
    });
  });

  describe('readiness', () => {
    it('reports the gate as off, with the key the composer renders', async () => {
      const { svc } = makeAdapter({ settings: null });

      const readiness = await svc.readiness(WS);

      expect(readiness).toEqual({
        armed: false,
        configured: false,
        gap: 'NOT_ARMED',
        messageKey: IYS_EPOSTA_MESSAGE_KEY.NOT_ARMED,
      });
    });

    it('reports armed-but-unconfigured so the tenant is told what is missing', async () => {
      const { svc } = makeAdapter({ settings: armed(), channels: [] });

      const readiness = await svc.readiness(WS);

      expect(readiness).toMatchObject({ armed: true, configured: false, gap: 'NO_CREDENTIALS' });
      expect(readiness.messageKey).toBe(IYS_EPOSTA_MESSAGE_KEY.NO_CREDENTIALS);
    });

    it('reports ready when the credentials resolve, and asks İYS nothing to find out', async () => {
      const { svc, client } = makeAdapter({ settings: armed(), channels: [smsChannel()] });

      const readiness = await svc.readiness(WS);

      expect(readiness).toEqual({ armed: true, configured: true, gap: null, messageKey: null });
      expect(client.search).not.toHaveBeenCalled();
    });
  });
});
