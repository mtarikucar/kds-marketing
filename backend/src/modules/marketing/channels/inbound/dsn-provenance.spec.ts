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
