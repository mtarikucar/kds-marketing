import {
  MAX_SUPPRESSIONS_PER_REPORT,
  PROVENANCE_WINDOW_DAYS,
  corroborateReport,
  describeRejections,
} from './dsn-provenance';
import { DeliveryReport, SuppressibleRecipient } from './delivery-report';

/**
 * The gate between "a message arrived saying an address bounced" and "stop
 * mailing that address for good". Everything above it — classification, the
 * report parser — reads content the SENDER wrote, so these are the rules that
 * decide whether a stranger can suppress a tenant's customers.
 */
describe('corroborateReport', () => {
  const WS = 'ws-1';

  function target(address: string): SuppressibleRecipient {
    return { address, reason: 'HARD_BOUNCE', status: '5.1.1', diagnostic: null };
  }

  function report(over: Partial<DeliveryReport> = {}): DeliveryReport {
    return { kind: 'DSN', originalMessageId: null, recipients: [], ...over };
  }

  /** A ledger that answers for the rows it was given, and nothing else. */
  function db(rows: Array<{ toAddressNorm: string; messageId?: string; status?: string; sentAt?: Date }>) {
    const findFirst = jest.fn(async ({ where }: any) => {
      const clauses = where.OR ?? [where];
      const hit = rows.find((r) =>
        // An ABSENT constraint matches every row — that is what Prisma does,
        // and modelling it any other way would let a dropped `toAddressNorm`
        // pairing pass these tests.
        clauses.some((c: any) => {
          if (c.toAddressNorm !== undefined && c.toAddressNorm !== r.toAddressNorm) return false;
          if (c.messageId !== undefined && c.messageId !== r.messageId) return false;
          if (c.status !== undefined && c.status !== (r.status ?? 'SENT')) return false;
          if (c.sentAt?.gte && (r.sentAt ?? new Date()) < c.sentAt.gte) return false;
          return true;
        }),
      );
      return hit ? { id: 'ml-1' } : null;
    });
    return { mailLog: { findFirst } };
  }

  it('corroborates an address this workspace recently mailed', async () => {
    const out = await corroborateReport(db([{ toAddressNorm: 'yok@musteri.com' }]), WS, report(), [
      target('yok@musteri.com'),
    ]);
    expect(out.corroborated.map((t) => t.address)).toEqual(['yok@musteri.com']);
    expect(out.rejected).toEqual([]);
  });

  it('refuses an address this workspace has no record of mailing', async () => {
    const out = await corroborateReport(db([]), WS, report(), [target('patron@buyukmusteri.com')]);
    expect(out.corroborated).toEqual([]);
    expect(out.rejected).toEqual([{ address: 'patron@buyukmusteri.com', reason: 'not-our-recipient' }]);
  });

  it('refuses a stranger even when the report quotes a REAL Message-ID', async () => {
    // Anyone who ever received mail from the tenant knows a valid
    // Original-Message-ID. Knowing one must not become a licence to suppress
    // a third party, so the quoted row's recipient has to match too.
    const ledger = db([{ toAddressNorm: 'bilinen@musteri.com', messageId: 'ml-9.abc@jeetagrowth.com' }]);
    const out = await corroborateReport(ledger, WS, report({ originalMessageId: 'ml-9.abc@jeetagrowth.com' }), [
      target('patron@buyukmusteri.com'),
    ]);
    expect(out.corroborated).toEqual([]);
    expect(out.rejected[0].reason).toBe('not-our-recipient');
  });

  it('accepts a quoted Message-ID that names its own recipient, outside the window', async () => {
    // A receiving MTA may sit on a message for a long time before the final
    // NDR. The id is proof on its own, so the age limit does not apply to it.
    const old = new Date(Date.now() - (PROVENANCE_WINDOW_DAYS + 120) * 24 * 60 * 60 * 1000);
    const ledger = db([
      { toAddressNorm: 'yok@musteri.com', messageId: 'ml-9.abc@jeetagrowth.com', sentAt: old },
    ]);
    const out = await corroborateReport(ledger, WS, report({ originalMessageId: 'ml-9.abc@jeetagrowth.com' }), [
      target('yok@musteri.com'),
    ]);
    expect(out.corroborated).toHaveLength(1);
  });

  it('refuses an address last mailed before the window, when no id is quoted', async () => {
    const old = new Date(Date.now() - (PROVENANCE_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000);
    const out = await corroborateReport(db([{ toAddressNorm: 'eski@musteri.com', sentAt: old }]), WS, report(), [
      target('eski@musteri.com'),
    ]);
    expect(out.corroborated).toEqual([]);
  });

  it('refuses an address whose send never left the building', async () => {
    // A REFUSED or FAILED row is not evidence the address was ever mailed.
    const out = await corroborateReport(
      db([{ toAddressNorm: 'yok@musteri.com', status: 'REFUSED' }]),
      WS,
      report(),
      [target('yok@musteri.com')],
    );
    expect(out.corroborated).toEqual([]);
  });

  it('caps how many addresses one report may suppress', async () => {
    const many = Array.from({ length: MAX_SUPPRESSIONS_PER_REPORT + 15 }, (_, i) => `v${i}@musteri.com`);
    const ledger = db(many.map((a) => ({ toAddressNorm: a })));
    const out = await corroborateReport(ledger, WS, report(), many.map(target));
    expect(out.corroborated).toHaveLength(MAX_SUPPRESSIONS_PER_REPORT);
    expect(out.rejected.every((r) => r.reason === 'over-cap')).toBe(true);
  });

  it('treats a lookup failure as "not proved", never as proved', async () => {
    const ledger = { mailLog: { findFirst: jest.fn().mockRejectedValue(new Error('P2024')) } };
    const out = await corroborateReport(ledger, WS, report(), [target('yok@musteri.com')]);
    expect(out.corroborated).toEqual([]);
    expect(out.rejected).toHaveLength(1);
  });

  it('refuses everything when there is no workspace to scope the check to', async () => {
    const ledger = db([{ toAddressNorm: 'yok@musteri.com' }]);
    const out = await corroborateReport(ledger, '', report(), [target('yok@musteri.com')]);
    expect(out.corroborated).toEqual([]);
    expect(ledger.mailLog.findFirst).not.toHaveBeenCalled();
  });

  it('scopes the lookup to the workspace that owns the mailbox', async () => {
    const ledger = db([{ toAddressNorm: 'yok@musteri.com' }]);
    await corroborateReport(ledger, WS, report(), [target('yok@musteri.com')]);
    expect(ledger.mailLog.findFirst.mock.calls[0][0].where.workspaceId).toBe(WS);
  });
});

/**
 * The one proof only a tenant's own mailbox can produce: the mail its owner
 * sent from Outlook or a phone, read back out of their Sent folder and filed
 * as an OUTBOUND echo. Modelled at the three tables the lookup walks.
 */
describe('corroborateReport — mail the owner sent from their own client', () => {
  const WS = 'ws-1';
  const DAY = 24 * 60 * 60 * 1000;

  function target(address: string, reason: SuppressibleRecipient['reason'] = 'HARD_BOUNCE'): SuppressibleRecipient {
    return { address, reason, status: '5.1.1', diagnostic: null };
  }

  function report(over: Partial<DeliveryReport> = {}): DeliveryReport {
    return { kind: 'DSN', originalMessageId: null, recipients: [], ...over };
  }

  interface Echo {
    to: string;
    direction?: 'OUTBOUND' | 'INBOUND';
    status?: string;
    externalMessageId?: string;
    createdAt?: Date;
    workspaceId?: string;
  }

  /** No ledger rows at all, so anything proved here was proved by the echo. */
  function db(echoes: Echo[]) {
    const identities = echoes.map((e, i) => ({
      id: `ci-${i}`,
      workspaceId: e.workspaceId ?? WS,
      kind: 'EMAIL',
      value: e.to,
    }));
    const conversations = echoes.map((e, i) => ({
      id: `cv-${i}`,
      workspaceId: e.workspaceId ?? WS,
      contactIdentityId: `ci-${i}`,
    }));
    const messages = echoes.map((e, i) => ({
      id: `m-${i}`,
      workspaceId: e.workspaceId ?? WS,
      conversationId: `cv-${i}`,
      direction: e.direction ?? 'OUTBOUND',
      status: e.status ?? 'SENT',
      externalMessageId: e.externalMessageId ?? null,
      createdAt: e.createdAt ?? new Date(),
    }));
    const inList = (list: unknown, v: unknown) => !Array.isArray(list) || list.includes(v);
    return {
      mailLog: { findFirst: jest.fn(async () => null) },
      contactIdentity: {
        findMany: jest.fn(async ({ where }: any) =>
          identities.filter(
            (r) => r.workspaceId === where.workspaceId && r.kind === where.kind && r.value === where.value,
          ),
        ),
      },
      conversation: {
        findMany: jest.fn(async ({ where }: any) =>
          conversations.filter(
            (r) => r.workspaceId === where.workspaceId && inList(where.contactIdentityId?.in, r.contactIdentityId),
          ),
        ),
      },
      message: {
        findFirst: jest.fn(async ({ where }: any) => {
          const hit = messages.find(
            (m) =>
              m.workspaceId === where.workspaceId &&
              inList(where.conversationId?.in, m.conversationId) &&
              m.direction === where.direction &&
              // Both spellings Prisma accepts, and an ABSENT one matches every
              // row — so dropping the status filter fails the FAILED/PENDING cases.
              (where.status?.in === undefined || where.status.in.includes(m.status)) &&
              (where.status?.not === undefined || m.status !== where.status.not) &&
              (where.OR ?? []).some((c: any) => {
                if (c.externalMessageId) return inList(c.externalMessageId.in, m.externalMessageId);
                if (c.createdAt) return m.createdAt >= c.createdAt.gte;
                return false;
              }),
          );
          return hit ? { id: hit.id } : null;
        }),
      },
    };
  }

  it('corroborates by the returned id when the echo went to the reported address', async () => {
    const old = new Date(Date.now() - (PROVENANCE_WINDOW_DAYS + 90) * DAY);
    const ledger = db([{ to: 'yok@musteri.com', externalMessageId: 'CAF123@mail.gmail.com', createdAt: old }]);
    const out = await corroborateReport(ledger, WS, report({ originalMessageId: 'CAF123@mail.gmail.com' }), [
      target('yok@musteri.com'),
    ]);
    // The id is proof on its own, so the window does not apply to it.
    expect(out.corroborated.map((t) => t.address)).toEqual(['yok@musteri.com']);
  });

  it('corroborates by address inside the window when the report quotes no id', async () => {
    const ledger = db([{ to: 'yok@musteri.com', createdAt: new Date(Date.now() - 2 * DAY) }]);
    const out = await corroborateReport(ledger, WS, report(), [target('yok@musteri.com')]);
    expect(out.corroborated).toHaveLength(1);
  });

  it('matches an echo stored with its angle brackets as well', async () => {
    const old = new Date(Date.now() - (PROVENANCE_WINDOW_DAYS + 5) * DAY);
    const ledger = db([{ to: 'yok@musteri.com', externalMessageId: '<abc@acme.com>', createdAt: old }]);
    const out = await corroborateReport(ledger, WS, report({ originalMessageId: 'abc@acme.com' }), [
      target('yok@musteri.com'),
    ]);
    expect(out.corroborated).toHaveLength(1);
  });

  it('refuses a stranger even when the report quotes the id of a real echo', async () => {
    // The customer who got the owner's mail knows its id. That must buy them
    // their own address at most — never somebody else's.
    const old = new Date(Date.now() - (PROVENANCE_WINDOW_DAYS + 5) * DAY);
    const ledger = db([{ to: 'bilinen@musteri.com', externalMessageId: 'abc@acme.com', createdAt: old }]);
    const out = await corroborateReport(ledger, WS, report({ originalMessageId: 'abc@acme.com' }), [
      target('patron@buyukmusteri.com'),
    ]);
    expect(out.corroborated).toEqual([]);
    expect(out.rejected).toEqual([{ address: 'patron@buyukmusteri.com', reason: 'not-our-recipient' }]);
  });

  it('refuses a contact who only ever wrote TO us — knowing someone is not mailing them', async () => {
    const ledger = db([{ to: 'yazan@musteri.com', direction: 'INBOUND' }]);
    const out = await corroborateReport(ledger, WS, report(), [target('yazan@musteri.com')]);
    expect(out.corroborated).toEqual([]);
  });

  it('refuses an echo whose send failed', async () => {
    const ledger = db([{ to: 'yok@musteri.com', status: 'FAILED' }]);
    const out = await corroborateReport(ledger, WS, report(), [target('yok@musteri.com')]);
    expect(out.corroborated).toEqual([]);
  });

  it('refuses a send whose outcome was never recorded (PENDING)', async () => {
    // `message-sender` opens the row PENDING before it dials, and a crash
    // between the dial and the settle leaves it there. "We cannot tell whether
    // it left" must not be proof that it did.
    const ledger = db([{ to: 'yok@musteri.com', status: 'PENDING' }]);
    const out = await corroborateReport(ledger, WS, report(), [target('yok@musteri.com')]);
    expect(out.corroborated).toEqual([]);
  });

  it.each(['SENT', 'DELIVERED', 'READ'])('accepts a settled send in state %s', async (status) => {
    const ledger = db([{ to: 'yok@musteri.com', status }]);
    const out = await corroborateReport(ledger, WS, report(), [target('yok@musteri.com')]);
    expect(out.corroborated).toHaveLength(1);
  });

  it('refuses an echo older than the window when no id is quoted', async () => {
    const old = new Date(Date.now() - (PROVENANCE_WINDOW_DAYS + 1) * DAY);
    const ledger = db([{ to: 'eski@musteri.com', createdAt: old }]);
    const out = await corroborateReport(ledger, WS, report(), [target('eski@musteri.com')]);
    expect(out.corroborated).toEqual([]);
  });

  it("never reads another workspace's mailbox as this one's proof", async () => {
    const ledger = db([{ to: 'yok@musteri.com', workspaceId: 'ws-2' }]);
    const out = await corroborateReport(ledger, WS, report(), [target('yok@musteri.com')]);
    expect(out.corroborated).toEqual([]);
    expect(ledger.contactIdentity.findMany.mock.calls[0][0].where.workspaceId).toBe(WS);
  });

  it('treats a failing echo lookup as "not proved"', async () => {
    const ledger = db([{ to: 'yok@musteri.com' }]);
    ledger.message.findFirst.mockRejectedValueOnce(new Error('P1001'));
    const out = await corroborateReport(ledger, WS, report(), [target('yok@musteri.com')]);
    expect(out.corroborated).toEqual([]);
    expect(out.rejected).toHaveLength(1);
  });

  it('still caps one report at MAX_SUPPRESSIONS_PER_REPORT', async () => {
    const many = Array.from({ length: MAX_SUPPRESSIONS_PER_REPORT + 3 }, (_, i) => `e${i}@musteri.com`);
    const ledger = db(many.map((to) => ({ to })));
    const out = await corroborateReport(ledger, WS, report(), many.map((a) => target(a)));
    expect(out.corroborated).toHaveLength(MAX_SUPPRESSIONS_PER_REPORT);
    expect(out.rejected.every((r) => r.reason === 'over-cap')).toBe(true);
  });
});

describe('describeRejections', () => {
  it('says nothing when nothing was refused', () => {
    expect(describeRejections([])).toBeNull();
  });

  it('names the refused addresses and counts the rest', () => {
    const line = describeRejections(
      Array.from({ length: 8 }, (_, i) => ({ address: `v${i}@x.com`, reason: 'not-our-recipient' as const })),
    );
    expect(line).toContain('v0@x.com (not-our-recipient)');
    expect(line).toContain('+3 more');
  });
});
