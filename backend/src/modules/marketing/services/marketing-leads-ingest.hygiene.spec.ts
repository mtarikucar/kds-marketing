import { MarketingLeadsIngestService } from './marketing-leads-ingest.service';

/**
 * THE ONE PATH THAT MINTS A LEAD FROM AN ADDRESS NOBODY TYPED.
 *
 * A CSV import is the tenant's own data and a form is typed by a visitor; both
 * stamp a hygiene verdict at the write. The research accept path does not — it
 * writes whatever the agent scraped off a web page straight onto `Lead.email`,
 * with `emailVerifiedStatus` left at its column default. `buildAudienceWhere`
 * excludes only `INVALID`, so a syntactically impossible address minted here
 * entered every campaign audience and was refused one by one at the gateway,
 * spending reputation on the shared relay each time.
 *
 * SYNTAX ONLY, deliberately. `verify()` is a 2.5 s MX lookup and this mapper
 * runs inside `prisma.$transaction` — one held pooled connection per row. The
 * MX half belongs to the background sweeper, not to a transaction.
 */
describe('MarketingLeadsIngestService — a researched address is classified as it lands', () => {
  const map = (c: Record<string, unknown>): Record<string, unknown> =>
    (MarketingLeadsIngestService.prototype as never as {
      mapToLeadData(c: unknown): Record<string, unknown>;
    }).mapToLeadData({
      businessName: 'Acme',
      externalRef: 'ref-1',
      painPoint: 'p',
      evidence: 'e',
      pitch: 'x',
      ...c,
    });

  it('marks an address that cannot be delivered to INVALID', () => {
    // Two addresses in one value — the transport would expand or refuse it.
    expect(map({ email: 'a,b@c.com' }).emailVerifiedStatus).toBe('INVALID');
    expect(map({ email: 'Ali <ali@acme.com>' }).emailVerifiedStatus).toBe('INVALID');
  });

  it('leaves an ordinary address UNKNOWN rather than claiming it is VALID', () => {
    // Nothing has checked the domain. Claiming VALID here would smuggle an
    // unverified address past a gate that is supposed to mean "MX-checked".
    expect(map({ email: 'ali@acme.com' }).emailVerifiedStatus).toBe('UNKNOWN');
  });

  it('flags a disposable domain as RISKY, which nothing blocks on', () => {
    expect(map({ email: 'x@mailinator.com' }).emailVerifiedStatus).toBe('RISKY');
  });

  it('is UNKNOWN when the candidate carries no address at all', () => {
    expect(map({}).emailVerifiedStatus).toBe('UNKNOWN');
  });

  it('does not disturb the dedup keys the cross-path match depends on', () => {
    const row = map({ email: 'Ali@ACME.com', phone: '05551112233' });
    expect(row.emailNormalized).toBe('ali@acme.com');
    expect(row.email).toBe('Ali@ACME.com');
    expect(row.phoneNormalized).toBeTruthy();
  });
});
