import { MailClass } from '../channels/outbound/mail-class';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';
import { SuppressionReason, SuppressionService } from './suppression.service';

const WS = 'ws-1';
const ADDR = 'Info@Acme.com';
const KEY = 'info@acme.com';
const MASTER = Buffer.alloc(32, 9).toString('base64');

type Row = Record<string, any>;

/** Enough Prisma `where` to drive the real service: equality, in, not, OR. */
function matches(row: Row, where: Row = {}): boolean {
  for (const [field, cond] of Object.entries(where)) {
    if (field === 'OR') {
      if (!(cond as Row[]).some((c) => matches(row, c))) return false;
      continue;
    }
    if (cond !== null && typeof cond === 'object') {
      if ('in' in cond && !(cond.in as unknown[]).includes(row[field])) return false;
      if ('not' in cond) {
        if (cond.not === null ? row[field] == null : row[field] === cond.not) return false;
      }
      continue;
    }
    if (cond === null ? row[field] != null : row[field] !== cond) return false;
  }
  return true;
}

interface Store {
  suppressions: Row[];
  leads: Row[];
  consents: Row[];
  messages: Row[];
}

/**
 * A stateful stand-in for the two tables the union read spans, so
 * suppress → check → lift → check is one real round-trip instead of four
 * hand-fed mock returns.
 */
function makeSvc(seed: Partial<Store> = {}) {
  const prisma = mockPrismaClient();
  const store: Store = {
    suppressions: seed.suppressions ?? [],
    leads: seed.leads ?? [],
    consents: seed.consents ?? [],
    messages: seed.messages ?? [],
  };
  (prisma.$transaction as unknown as jest.Mock) = jest.fn((fn: any) => fn(prisma));

  (prisma.contactSuppression.findMany as unknown as jest.Mock).mockImplementation(async (args: any) =>
    store.suppressions.filter((r) => matches(r, args?.where)),
  );
  (prisma.contactSuppression.upsert as unknown as jest.Mock).mockImplementation(async (args: any) => {
    const k = args.where.workspaceId_kind_hash_reason;
    const found = store.suppressions.find(
      (r) => r.workspaceId === k.workspaceId && r.kind === k.kind && r.hash === k.hash && r.reason === k.reason,
    );
    if (found) Object.assign(found, args.update);
    else store.suppressions.push({ liftedAt: null, createdAt: new Date(), ...args.create });
    return found ?? store.suppressions[store.suppressions.length - 1];
  });
  (prisma.contactSuppression.updateMany as unknown as jest.Mock).mockImplementation(async (args: any) => {
    const hit = store.suppressions.filter((r) => matches(r, args?.where));
    hit.forEach((r) => Object.assign(r, args.data));
    return { count: hit.length };
  });

  (prisma.lead.findMany as unknown as jest.Mock).mockImplementation(async (args: any) =>
    store.leads.filter((r) => matches(r, args?.where)),
  );
  (prisma.lead.updateMany as unknown as jest.Mock).mockImplementation(async (args: any) => {
    const hit = store.leads.filter((r) => matches(r, args?.where));
    hit.forEach((r) => Object.assign(r, args.data));
    return { count: hit.length };
  });
  (prisma.consentRecord.findFirst as unknown as jest.Mock).mockImplementation(async (args: any) => {
    const hit = store.consents.filter((r) => matches(r, args?.where));
    hit.sort((a, b) => b.createdAt - a.createdAt);
    return hit[0] ?? null;
  });
  (prisma.message.findFirst as unknown as jest.Mock).mockImplementation(async (args: any) => {
    const where = { ...(args?.where ?? {}) };
    const after = where.createdAt?.gt as Date | undefined;
    delete where.createdAt;
    return (
      store.messages.find((r) => matches(r, where) && (!after || r.createdAt > after)) ?? null
    );
  });

  const ledger = { record: jest.fn().mockResolvedValue(0) };
  const svc = new SuppressionService(prisma as any, ledger as any);
  return { prisma, ledger, store, svc };
}

function lead(over: Row = {}): Row {
  return {
    id: 'lead-1',
    workspaceId: WS,
    emailNormalized: KEY,
    phoneNormalized: null,
    emailOptOut: false,
    emailBouncedAt: null,
    emailVerifiedStatus: 'UNKNOWN',
    smsOptOut: false,
    ...over,
  };
}

beforeEach(() => {
  process.env.MARKETING_SECRET_KEY = MASTER;
});
afterEach(() => {
  delete process.env.MARKETING_SECRET_KEY;
});

/**
 * §A3.2 — the class × reason table. Every cell here is a verifier's warning:
 * an invoice must reach someone who unticked marketing mail, a password reset
 * must survive a stale bounce, and nothing at all outruns an erasure tombstone.
 */
describe('SuppressionService.check — the class matrix', () => {
  const BLOCK = true;
  const ALLOW = false;
  const cases: Array<[SuppressionReason, MailClass, boolean]> = [
    ['ERASURE', 'AUTH', BLOCK],
    ['ERASURE', 'INTERNAL', ALLOW],
    ['ERASURE', 'TRANSACTIONAL', BLOCK],
    ['ERASURE', 'BULK', BLOCK],
    ['HARD_BOUNCE', 'AUTH', ALLOW],
    ['HARD_BOUNCE', 'INTERNAL', ALLOW],
    ['HARD_BOUNCE', 'TRANSACTIONAL', BLOCK],
    ['HARD_BOUNCE', 'BULK', BLOCK],
    ['INVALID', 'AUTH', ALLOW],
    ['INVALID', 'INTERNAL', ALLOW],
    ['INVALID', 'TRANSACTIONAL', BLOCK],
    ['INVALID', 'BULK', BLOCK],
    ['COMPLAINT', 'AUTH', ALLOW],
    ['COMPLAINT', 'INTERNAL', ALLOW],
    ['COMPLAINT', 'TRANSACTIONAL', ALLOW],
    ['COMPLAINT', 'BULK', BLOCK],
    ['OPT_OUT', 'AUTH', ALLOW],
    ['OPT_OUT', 'INTERNAL', ALLOW],
    ['OPT_OUT', 'TRANSACTIONAL', ALLOW],
    ['OPT_OUT', 'BULK', BLOCK],
  ];

  it.each(cases)('%s + %s → blocked=%s', async (reason, mailClass, blocked) => {
    const { svc } = makeSvc();
    await svc.suppress(WS, ADDR, 'EMAIL', reason);
    const verdict = await svc.check(WS, ADDR, mailClass);
    expect(verdict.suppressed).toBe(blocked);
    if (blocked) expect(verdict.reason).toBe(reason);
  });

  const conversational: Array<[SuppressionReason, boolean, boolean]> = [
    // reason, blocked when proactive, blocked when answering a fresh inbound
    ['ERASURE', BLOCK, BLOCK],
    ['HARD_BOUNCE', BLOCK, ALLOW],
    ['INVALID', BLOCK, ALLOW],
    ['COMPLAINT', BLOCK, ALLOW],
    ['OPT_OUT', BLOCK, ALLOW],
  ];

  it.each(conversational)(
    '%s + CONVERSATIONAL → proactive blocked=%s, reply blocked=%s',
    async (reason, whenProactive, whenReplying) => {
      const { svc } = makeSvc({
        messages: [{ workspaceId: WS, conversationId: 'c1', direction: 'INBOUND', createdAt: new Date() }],
      });
      await svc.suppress(WS, ADDR, 'EMAIL', reason);
      const proactive = await svc.check(WS, ADDR, 'CONVERSATIONAL', { proactive: true, conversationId: 'c1' });
      const reply = await svc.check(WS, ADDR, 'CONVERSATIONAL', { conversationId: 'c1' });
      expect(proactive.suppressed).toBe(whenProactive);
      expect(reply.suppressed).toBe(whenReplying);
    },
  );

  it('reports the harshest applicable reason, not the first one found', async () => {
    const { svc } = makeSvc();
    await svc.suppress(WS, ADDR, 'EMAIL', 'OPT_OUT');
    await svc.suppress(WS, ADDR, 'EMAIL', 'HARD_BOUNCE');
    // TRANSACTIONAL ignores the opt-out and must still refuse the dead address.
    expect(await svc.check(WS, ADDR, 'TRANSACTIONAL')).toEqual({ suppressed: true, reason: 'HARD_BOUNCE' });
  });

  it('allows an address nothing is on record against', async () => {
    const { svc } = makeSvc();
    expect(await svc.check(WS, ADDR, 'BULK')).toEqual({ suppressed: false });
  });

  it('allows an empty or unparsable recipient — that is the gateway’s gate, not this one', async () => {
    const { svc, prisma } = makeSvc();
    expect(await svc.check(WS, '', 'BULK')).toEqual({ suppressed: false });
    expect(await svc.check('', ADDR, 'BULK')).toEqual({ suppressed: false });
    expect(prisma.contactSuppression.findMany).not.toHaveBeenCalled();
  });
});

/** R2 — the verdict is the UNION of the table and the denormalised Lead flags. */
describe('SuppressionService.check — the union read', () => {
  it('honours a pre-existing lead flag with no suppression row (no backfill needed)', async () => {
    const { svc } = makeSvc({ leads: [lead({ emailOptOut: true })] });
    expect(await svc.check(WS, ADDR, 'BULK')).toEqual({ suppressed: true, reason: 'OPT_OUT' });
  });

  it('reads emailBouncedAt as HARD_BOUNCE and INVALID as INVALID', async () => {
    const bounced = makeSvc({ leads: [lead({ emailBouncedAt: new Date() })] });
    expect(await bounced.svc.check(WS, ADDR, 'TRANSACTIONAL')).toEqual({
      suppressed: true,
      reason: 'HARD_BOUNCE',
    });
    const invalid = makeSvc({ leads: [lead({ emailVerifiedStatus: 'INVALID' })] });
    expect(await invalid.svc.check(WS, ADDR, 'TRANSACTIONAL')).toEqual({
      suppressed: true,
      reason: 'INVALID',
    });
  });

  it('honours a suppression row with no lead at all', async () => {
    const { svc } = makeSvc();
    await svc.suppress(WS, ADDR, 'EMAIL', 'OPT_OUT');
    expect(await svc.check(WS, ADDR, 'BULK')).toEqual({ suppressed: true, reason: 'OPT_OUT' });
  });

  it('never reads across workspaces', async () => {
    const { svc, prisma } = makeSvc({ leads: [lead({ emailOptOut: true, workspaceId: 'ws-2' })] });
    expect(await svc.check(WS, ADDR, 'BULK')).toEqual({ suppressed: false });
    expect(prisma.contactSuppression.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS }) }),
    );
    expect(prisma.lead.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS }) }),
    );
  });

  it('ignores a lifted row', async () => {
    const { svc } = makeSvc();
    await svc.suppress(WS, ADDR, 'EMAIL', 'OPT_OUT');
    await svc.lift(WS, ADDR, 'EMAIL', 'OPT_OUT', 'operator-1');
    expect(await svc.check(WS, ADDR, 'BULK')).toEqual({ suppressed: false });
  });

  it('matches on the normalized address, whatever casing the caller passes', async () => {
    const { svc } = makeSvc();
    await svc.suppress(WS, '  INFO@acme.com ', 'EMAIL', 'OPT_OUT');
    expect(await svc.check(WS, 'info@ACME.com', 'BULK')).toEqual({ suppressed: true, reason: 'OPT_OUT' });
  });
});

/**
 * `replies-skip-consent`: a customer who unsubscribed and then wrote in must
 * get an answer; a follow-up we queue hours later must not go out.
 */
describe('SuppressionService.check — the reply exemption', () => {
  const optOutAt = new Date('2026-01-01T10:00:00Z');

  function conversation(inboundAt: Date | null) {
    return makeSvc({
      leads: [lead({ emailOptOut: true })],
      consents: [{ workspaceId: WS, leadId: 'lead-1', type: 'MARKETING_EMAIL', granted: false, createdAt: optOutAt }],
      messages: inboundAt
        ? [{ workspaceId: WS, conversationId: 'c1', direction: 'INBOUND', createdAt: inboundAt }]
        : [],
    });
  }

  it('allows a reply when the customer wrote in after the opt-out', async () => {
    const { svc } = conversation(new Date('2026-01-01T11:00:00Z'));
    expect(await svc.check(WS, ADDR, 'CONVERSATIONAL', { conversationId: 'c1' })).toEqual({ suppressed: false });
  });

  it('blocks a proactive follow-up on that same conversation', async () => {
    const { svc } = conversation(new Date('2026-01-01T11:00:00Z'));
    expect(
      await svc.check(WS, ADDR, 'CONVERSATIONAL', { conversationId: 'c1', proactive: true }),
    ).toEqual({ suppressed: true, reason: 'OPT_OUT' });
  });

  it('blocks a "reply" when the last inbound predates the opt-out', async () => {
    const { svc } = conversation(new Date('2026-01-01T09:00:00Z'));
    expect(await svc.check(WS, ADDR, 'CONVERSATIONAL', { conversationId: 'c1' })).toEqual({
      suppressed: true,
      reason: 'OPT_OUT',
    });
  });

  it('blocks when there is no conversation to prove a reply', async () => {
    const { svc } = conversation(new Date('2026-01-01T11:00:00Z'));
    expect(await svc.check(WS, ADDR, 'CONVERSATIONAL', {})).toEqual({ suppressed: true, reason: 'OPT_OUT' });
  });

  it('falls back to a 72h inbound window for legacy rows with no ConsentRecord', async () => {
    const fresh = makeSvc({
      leads: [lead({ emailOptOut: true })],
      messages: [{ workspaceId: WS, conversationId: 'c1', direction: 'INBOUND', createdAt: new Date() }],
    });
    expect(await fresh.svc.check(WS, ADDR, 'CONVERSATIONAL', { conversationId: 'c1' })).toEqual({
      suppressed: false,
    });

    const stale = makeSvc({
      leads: [lead({ emailOptOut: true })],
      messages: [
        {
          workspaceId: WS,
          conversationId: 'c1',
          direction: 'INBOUND',
          createdAt: new Date(Date.now() - 100 * 60 * 60 * 1000),
        },
      ],
    });
    expect(await stale.svc.check(WS, ADDR, 'CONVERSATIONAL', { conversationId: 'c1' })).toEqual({
      suppressed: true,
      reason: 'OPT_OUT',
    });
  });

  it('an erasure tombstone is not exempted by a reply', async () => {
    const { svc } = makeSvc({
      messages: [{ workspaceId: WS, conversationId: 'c1', direction: 'INBOUND', createdAt: new Date() }],
    });
    await svc.suppress(WS, ADDR, 'EMAIL', 'ERASURE');
    expect(await svc.check(WS, ADDR, 'CONVERSATIONAL', { conversationId: 'c1' })).toEqual({
      suppressed: true,
      reason: 'ERASURE',
    });
  });

  it('does not ask about inbound mail when no reason is proactive-gated', async () => {
    const { svc, prisma } = makeSvc();
    await svc.suppress(WS, ADDR, 'EMAIL', 'OPT_OUT');
    await svc.check(WS, ADDR, 'BULK');
    expect(prisma.message.findFirst).not.toHaveBeenCalled();
  });

  it('scopes the inbound probe to the workspace and the conversation', async () => {
    const { svc, prisma } = conversation(new Date('2026-01-01T11:00:00Z'));
    await svc.check(WS, ADDR, 'CONVERSATIONAL', { conversationId: 'c1' });
    expect(prisma.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: WS, conversationId: 'c1', direction: 'INBOUND' }),
      }),
    );
  });
});

describe('SuppressionService.suppress', () => {
  it('writes the row keyed by reason, so a bounce cannot overwrite an erasure', async () => {
    const { svc, store } = makeSvc();
    await svc.suppress(WS, ADDR, 'EMAIL', 'ERASURE', { source: 'dsar' });
    await svc.suppress(WS, ADDR, 'EMAIL', 'HARD_BOUNCE', { source: 'dsn' });
    expect(store.suppressions.map((r) => r.reason).sort()).toEqual(['ERASURE', 'HARD_BOUNCE']);
    expect(store.suppressions.every((r) => r.hash && r.hash !== KEY)).toBe(true);
  });

  it('projects an opt-out onto EVERY same-address lead in the workspace', async () => {
    // `optout-per-lead-row`: info@acme.com on file twice unsubscribed once.
    const { svc, store } = makeSvc({
      leads: [lead({ id: 'a' }), lead({ id: 'b' }), lead({ id: 'c', workspaceId: 'ws-2' })],
    });
    await svc.suppress(WS, ADDR, 'EMAIL', 'OPT_OUT');
    expect(store.leads.map((l) => l.emailOptOut)).toEqual([true, true, false]);
  });

  it('a hard bounce sets emailBouncedAt only, never emailOptOut', async () => {
    // `bounce-sets-optout`: correcting the address must clear the right thing.
    const { svc, store } = makeSvc({ leads: [lead()] });
    await svc.suppress(WS, ADDR, 'EMAIL', 'HARD_BOUNCE');
    expect(store.leads[0].emailBouncedAt).toBeInstanceOf(Date);
    expect(store.leads[0].emailOptOut).toBe(false);
  });

  it('INVALID projects onto emailVerifiedStatus, COMPLAINT onto emailOptOut', async () => {
    const invalid = makeSvc({ leads: [lead()] });
    await invalid.svc.suppress(WS, ADDR, 'EMAIL', 'INVALID');
    expect(invalid.store.leads[0].emailVerifiedStatus).toBe('INVALID');
    expect(invalid.store.leads[0].emailOptOut).toBe(false);

    const complaint = makeSvc({ leads: [lead()] });
    await complaint.svc.suppress(WS, ADDR, 'EMAIL', 'COMPLAINT');
    expect(complaint.store.leads[0].emailOptOut).toBe(true);
    expect(complaint.store.leads[0].emailBouncedAt).toBeNull();
  });

  it('never widens on a null or malformed key', async () => {
    // esp-feedback.service.ts:33's guard: `{ emailNormalized: null }` would opt
    // out every email-less lead in the workspace.
    const { svc, prisma, store } = makeSvc({ leads: [lead({ emailNormalized: null })] });
    await svc.suppress(WS, '', 'EMAIL', 'OPT_OUT');
    await svc.suppress(WS, null as unknown as string, 'EMAIL', 'OPT_OUT');
    await svc.suppress(WS, 'not-an-address', 'EMAIL', 'OPT_OUT');
    expect(prisma.lead.updateMany).not.toHaveBeenCalled();
    expect(store.leads[0].emailOptOut).toBe(false);
  });

  it('opts out the clicked lead even when its address has since changed', async () => {
    // The unsubscribe token carries a lead id; the address on the row may have
    // been edited since the mail went out.
    const { svc, store } = makeSvc({ leads: [lead({ id: 'a', emailNormalized: 'new@acme.com' })] });
    await svc.suppress(WS, ADDR, 'EMAIL', 'OPT_OUT', { leadId: 'a' });
    expect(store.leads[0].emailOptOut).toBe(true);
  });

  it('a lead id from another workspace matches nothing', async () => {
    const { svc, store } = makeSvc({
      leads: [lead({ id: 'a', workspaceId: 'ws-2', emailNormalized: 'new@acme.com' })],
    });
    await svc.suppress(WS, ADDR, 'EMAIL', 'OPT_OUT', { leadId: 'a' });
    expect(store.leads[0].emailOptOut).toBe(false);
  });

  it('writes one ConsentRecord per newly opted-out lead, and none on a repeat', async () => {
    const { svc, prisma, ledger } = makeSvc({ leads: [lead({ id: 'a' }), lead({ id: 'b' })] });
    await svc.suppress(WS, ADDR, 'EMAIL', 'OPT_OUT', { source: 'lead-token' });
    const [entry, tx] = ledger.record.mock.calls[0];
    expect(entry).toMatchObject({
      workspaceId: WS,
      leadIds: ['a', 'b'],
      type: 'MARKETING_EMAIL',
      granted: false,
    });
    // The audit row commits with the flip that produced it.
    expect(tx).toBe(prisma);
    ledger.record.mockClear();
    await svc.suppress(WS, ADDR, 'EMAIL', 'OPT_OUT', { source: 'lead-token' });
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it('records no consent row for a deliverability fact', async () => {
    const { svc, ledger } = makeSvc({ leads: [lead()] });
    await svc.suppress(WS, ADDR, 'EMAIL', 'HARD_BOUNCE');
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it('an ERASURE tombstone does not touch the lead flags', async () => {
    const { svc, prisma } = makeSvc({ leads: [lead()] });
    await svc.suppress(WS, ADDR, 'EMAIL', 'ERASURE');
    expect(prisma.lead.updateMany).not.toHaveBeenCalled();
  });

  it('runs inside a caller-supplied transaction instead of opening its own', async () => {
    const { svc, prisma } = makeSvc({ leads: [lead()] });
    const tx = prisma as any;
    await svc.suppress(WS, ADDR, 'EMAIL', 'OPT_OUT', { tx });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.contactSuppression.upsert).toHaveBeenCalled();
  });

  it('still projects the flags when the master key is missing (the table row is skipped)', async () => {
    delete process.env.MARKETING_SECRET_KEY;
    const { svc, prisma, store } = makeSvc({ leads: [lead()] });
    await svc.suppress(WS, ADDR, 'EMAIL', 'OPT_OUT');
    expect(prisma.contactSuppression.upsert).not.toHaveBeenCalled();
    expect(store.leads[0].emailOptOut).toBe(true);
  });

  it('projects a PHONE opt-out across every spelling of the number', async () => {
    const { svc, store } = makeSvc({
      leads: [
        lead({ id: 'a', phoneNormalized: '05551112233' }),
        lead({ id: 'b', phoneNormalized: '905551112233' }),
        lead({ id: 'c', phoneNormalized: '5559998877' }),
      ],
    });
    await svc.suppress(WS, '+90 555 111 22 33', 'PHONE', 'OPT_OUT');
    expect(store.leads.map((l) => l.smsOptOut)).toEqual([true, true, false]);
  });
});

describe('SuppressionService.lift', () => {
  it('refuses to lift an erasure tombstone', async () => {
    const { svc, prisma, store } = makeSvc();
    await svc.suppress(WS, ADDR, 'EMAIL', 'ERASURE');
    (prisma.contactSuppression.updateMany as unknown as jest.Mock).mockClear();
    await svc.lift(WS, ADDR, 'EMAIL', 'ERASURE', 'operator-1');
    expect(prisma.contactSuppression.updateMany).not.toHaveBeenCalled();
    expect(store.suppressions[0].liftedAt).toBeNull();
    expect(await svc.check(WS, ADDR, 'BULK')).toEqual({ suppressed: true, reason: 'ERASURE' });
  });

  it('clears the row and the denormalised flag so the lead is mailable again', async () => {
    // R3: without this, a re-consented lead is permanently unmailable.
    const { svc, store } = makeSvc({ leads: [lead({ id: 'a' }), lead({ id: 'b' })] });
    await svc.suppress(WS, ADDR, 'EMAIL', 'OPT_OUT');
    await svc.lift(WS, ADDR, 'EMAIL', 'OPT_OUT', 'operator-1');
    expect(store.suppressions[0].liftedAt).toBeInstanceOf(Date);
    expect(store.leads.map((l) => l.emailOptOut)).toEqual([false, false]);
  });

  it('keeps the flag while another unlifted row still demands it', async () => {
    const { svc, store } = makeSvc({ leads: [lead()] });
    await svc.suppress(WS, ADDR, 'EMAIL', 'OPT_OUT');
    await svc.suppress(WS, ADDR, 'EMAIL', 'COMPLAINT');
    await svc.lift(WS, ADDR, 'EMAIL', 'OPT_OUT', 'operator-1');
    expect(store.leads[0].emailOptOut).toBe(true);
    expect(await svc.check(WS, ADDR, 'BULK')).toEqual({ suppressed: true, reason: 'COMPLAINT' });
  });

  it('records the restored consent for the leads it actually freed', async () => {
    const { svc, ledger } = makeSvc({ leads: [lead({ id: 'a', emailOptOut: true })] });
    await svc.suppress(WS, ADDR, 'EMAIL', 'OPT_OUT');
    ledger.record.mockClear();
    await svc.lift(WS, ADDR, 'EMAIL', 'OPT_OUT', 'operator-1');
    expect(ledger.record.mock.calls[0][0]).toMatchObject({
      workspaceId: WS,
      leadIds: ['a'],
      type: 'MARKETING_EMAIL',
      granted: true,
    });
  });

  it('clears a bounce without claiming consent was restored', async () => {
    const { svc, ledger, store } = makeSvc({ leads: [lead()] });
    await svc.suppress(WS, ADDR, 'EMAIL', 'HARD_BOUNCE');
    ledger.record.mockClear();
    await svc.lift(WS, ADDR, 'EMAIL', 'HARD_BOUNCE', 'operator-1');
    expect(store.leads[0].emailBouncedAt).toBeNull();
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it('never lifts another workspace’s row', async () => {
    const { svc, prisma } = makeSvc();
    await svc.suppress(WS, ADDR, 'EMAIL', 'OPT_OUT');
    await svc.lift(WS, ADDR, 'EMAIL', 'OPT_OUT', 'operator-1');
    expect(prisma.contactSuppression.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS }) }),
    );
  });
});

describe('SuppressionService — the round trip', () => {
  it('suppress → check → lift → check', async () => {
    const { svc } = makeSvc({ leads: [lead()] });
    expect(await svc.check(WS, ADDR, 'BULK')).toEqual({ suppressed: false });
    await svc.suppress(WS, ADDR, 'EMAIL', 'OPT_OUT', { source: 'lead-token' });
    expect(await svc.check(WS, ADDR, 'BULK')).toEqual({ suppressed: true, reason: 'OPT_OUT' });
    await svc.lift(WS, ADDR, 'EMAIL', 'OPT_OUT', 'compliance');
    expect(await svc.check(WS, ADDR, 'BULK')).toEqual({ suppressed: false });
  });
});

describe('SuppressionService.checkMany', () => {
  it('returns only the suppressed addresses, keyed by what the caller passed', async () => {
    const { svc } = makeSvc({ leads: [lead({ id: 'b', emailNormalized: 'flagged@acme.com', emailOptOut: true })] });
    await svc.suppress(WS, ADDR, 'EMAIL', 'HARD_BOUNCE');
    const out = await svc.checkMany(WS, ['Info@Acme.com', 'Flagged@Acme.com', 'clean@acme.com'], 'BULK');
    expect(out.get('Info@Acme.com')).toBe('HARD_BOUNCE');
    expect(out.get('Flagged@Acme.com')).toBe('OPT_OUT');
    expect(out.has('clean@acme.com')).toBe(false);
  });

  it('applies the class matrix, so an opt-out does not stop an invoice', async () => {
    const { svc } = makeSvc();
    await svc.suppress(WS, ADDR, 'EMAIL', 'OPT_OUT');
    expect((await svc.checkMany(WS, [ADDR], 'TRANSACTIONAL')).size).toBe(0);
    expect((await svc.checkMany(WS, [ADDR], 'BULK')).get(ADDR)).toBe('OPT_OUT');
  });

  it('asks the database nothing for an empty list', async () => {
    const { svc, prisma } = makeSvc();
    expect((await svc.checkMany(WS, [], 'BULK')).size).toBe(0);
    expect(prisma.contactSuppression.findMany).not.toHaveBeenCalled();
    expect(prisma.lead.findMany).not.toHaveBeenCalled();
  });

  it('scopes both reads to the workspace', async () => {
    const { svc, prisma } = makeSvc();
    await svc.checkMany(WS, [ADDR], 'BULK');
    expect(prisma.contactSuppression.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS }) }),
    );
    expect(prisma.lead.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS }) }),
    );
  });
});
