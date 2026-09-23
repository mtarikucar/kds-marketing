import {
  normalizeDomain,
  buildRecords,
  dkimHost,
  dmarcHost,
  checkDkim,
  checkSpf,
  checkDmarc,
  allVerified,
  isDecisive,
  missingSummary,
  flattenTxt,
  type DnsCheck,
} from './sending-domain.dns';

const OK: DnsCheck = { dkim: { ok: true }, spf: { ok: true }, dmarc: { ok: true } };

describe('sending-domain.dns (pure)', () => {
  describe('normalizeDomain', () => {
    it('strips scheme/path/www and lower-cases', () => {
      expect(normalizeDomain('https://www.Acme.com/contact')).toBe('acme.com');
      expect(normalizeDomain('  Mail.Acme.Co.UK ')).toBe('mail.acme.co.uk');
    });
    it('rejects non-domains', () => {
      expect(normalizeDomain('localhost')).toBeNull();
      expect(normalizeDomain('not a domain')).toBeNull();
      expect(normalizeDomain('')).toBeNull();
      expect(normalizeDomain('http://')).toBeNull();
    });
  });

  describe('buildRecords', () => {
    const recs = (spfInclude: string | null = 'spf.jeeta.example') =>
      Object.fromEntries(
        buildRecords({
          domain: 'mail.acme.com',
          selector: 'mkt1a2b',
          publicKeyB64Der: 'PUBKEY',
          spfInclude,
        }).map((r) => [r.label, r]),
      );

    it('builds the records at the right hosts', () => {
      const byLabel = recs();
      expect(byLabel.DKIM.host).toBe(dkimHost('mkt1a2b', 'mail.acme.com'));
      expect(byLabel.DKIM.value).toBe('v=DKIM1; k=rsa; p=PUBKEY');
      expect(byLabel.SPF.host).toBe('mail.acme.com');
      expect(byLabel.SPF.value).toContain('include:spf.jeeta.example');
      expect(byLabel.DMARC.host).toBe(dmarcHost('mail.acme.com'));
    });

    // The whole class of harm this package exists to stop: a tenant who already
    // sends mail pastes a SECOND v=spf1 record at the apex and every one of
    // their own mails starts failing SPF with a permerror.
    it('never presents SPF as a record to paste blind — it carries the merge instruction', () => {
      const spf = recs().SPF;
      expect(spf.noteCode).toBe('SPF_MERGE');
      expect(spf.note).toMatch(/do not add a second/i);
      expect(spf.note).toContain('include:spf.jeeta.example');
    });

    // A second _dmarc TXT voids the policy outright (RFC 7489 §6.6.3), and
    // p=quarantine applies to ALL the tenant's mail, not only ours.
    it('offers p=none only, with no rua, and only when the host has no record yet', () => {
      const dmarc = recs().DMARC;
      expect(dmarc.value).toBe('v=DMARC1; p=none');
      expect(dmarc.value).not.toMatch(/quarantine|reject/);
      expect(dmarc.value).not.toMatch(/rua=/);
      expect(dmarc.onlyIfAbsent).toBe(true);
      expect(dmarc.noteCode).toBe('DMARC_ONLY_IF_ABSENT');
    });

    // platformSpfInclude() returns null until an operator sets a real value;
    // inventing one would be the bad guidance in a different costume.
    it('omits the SPF record entirely when the platform has no include to give', () => {
      const byLabel = recs(null);
      expect(byLabel.SPF).toBeUndefined();
      expect(byLabel.DKIM).toBeDefined();
      expect(byLabel.DMARC).toBeDefined();
    });
  });

  describe('record checks', () => {
    it('checkDkim requires our exact public key in the p= tag', () => {
      expect(checkDkim([['v=DKIM1; k=rsa; p=ABC123']], 'ABC123')).toEqual({ ok: true });
      expect(checkDkim([['v=DKIM1; k=rsa; p=WRONG']], 'ABC123')).toEqual({ ok: false, reason: 'KEY_MISMATCH' });
      expect(checkDkim([['some other txt']], 'ABC123')).toEqual({ ok: false, reason: 'MISSING' });
    });

    // Several TXT records at a selector host is not an RFC error (key rotation
    // parks the old one there), so the cardinality rule must NOT apply here.
    it('checkDkim accepts our key alongside other TXT at the selector host', () => {
      expect(checkDkim([['v=DKIM1; k=rsa; p=OLD'], ['v=DKIM1; k=rsa; p=ABC123']], 'ABC123')).toEqual({ ok: true });
    });

    // The v= tag is RECOMMENDED, not required (RFC 6376 §3.6.1), and some DNS
    // panels drop it. A working key must not be reported as missing.
    it('checkDkim recognises a key record that omits the optional v= tag', () => {
      expect(checkDkim([['k=rsa; p=ABC123']], 'ABC123')).toEqual({ ok: true });
      expect(checkDkim([['k=rsa; p=OTHER']], 'ABC123')).toEqual({ ok: false, reason: 'KEY_MISMATCH' });
    });

    it('joins chunked TXT records (the wire splits long values at 255 chars)', () => {
      expect(checkDkim([['v=DKIM1; k=rsa; p=AB', 'C123']], 'ABC123')).toEqual({ ok: true });
      expect(flattenTxt([['ab', 'cd']])).toEqual(['abcd']);
    });

    it('checkSpf needs exactly one v=spf1 record carrying our include', () => {
      expect(checkSpf([['v=spf1 include:spf.jeeta.example ~all']], 'spf.jeeta.example')).toEqual({ ok: true });
      expect(checkSpf([['v=spf1 -all']], 'spf.jeeta.example')).toEqual({ ok: false, reason: 'NO_INCLUDE' });
      expect(checkSpf([['some other txt']], 'spf.jeeta.example')).toEqual({ ok: false, reason: 'MISSING' });
    });

    // The failure the tenant must be told about by name: two SPF records is a
    // permerror for EVERY sender of that domain, including the tenant's own.
    it('checkSpf refuses two v=spf1 records even when one of them is ours', () => {
      expect(
        checkSpf([['v=spf1 include:_spf.google.com ~all'], ['v=spf1 include:spf.jeeta.example ~all']], 'spf.jeeta.example'),
      ).toEqual({ ok: false, reason: 'DUPLICATE' });
    });

    it('checkSpf never reports ok when the platform has no include configured', () => {
      expect(checkSpf([['v=spf1 include:anything ~all']], null)).toEqual({ ok: false, reason: 'NOT_CONFIGURED' });
    });

    // An existing policy is UPGRADED, never replaced: any well-formed DMARC
    // record at _dmarc satisfies us, including a stricter one we never asked for.
    it('checkDmarc accepts the policy the tenant already publishes', () => {
      expect(checkDmarc([['v=DMARC1; p=reject; rua=mailto:dmarc@acme.com']])).toEqual({ ok: true });
      expect(checkDmarc([['v=DMARC1; p=none']])).toEqual({ ok: true });
    });

    it('checkDmarc anchors on v=DMARC1 instead of matching it anywhere in a TXT', () => {
      expect(checkDmarc([['google-site-verification=v=DMARC1']])).toEqual({ ok: false, reason: 'MISSING' });
    });

    it('checkDmarc refuses two _dmarc records (a second one voids the policy)', () => {
      expect(checkDmarc([['v=DMARC1; p=none'], ['v=DMARC1; p=reject']])).toEqual({ ok: false, reason: 'DUPLICATE' });
    });
  });

  describe('grading the whole check', () => {
    it('allVerified only when all three are ok', () => {
      expect(allVerified(OK)).toBe(true);
      expect(allVerified({ ...OK, spf: { ok: false, reason: 'MISSING' } })).toBe(false);
    });

    // A resolver blip is not an answer. Nothing may be flipped on the strength
    // of a SERVFAIL, in either direction.
    it('isDecisive is false when any lookup could not be answered', () => {
      expect(isDecisive(OK)).toBe(true);
      expect(isDecisive({ ...OK, dkim: { ok: false, reason: 'MISSING' } })).toBe(true);
      expect(isDecisive({ ...OK, dkim: { ok: false, reason: 'UNAVAILABLE' } })).toBe(false);
    });

    it('missingSummary names the real problem instead of "Not yet found: SPF"', () => {
      expect(missingSummary({ ...OK, spf: { ok: false, reason: 'DUPLICATE' } })).toMatch(/two v=spf1 records/i);
      expect(missingSummary({ ...OK, dmarc: { ok: false, reason: 'DUPLICATE' } })).toMatch(/two DMARC records/i);
      expect(missingSummary({ ...OK, spf: { ok: false, reason: 'NO_INCLUDE' } })).toMatch(/include/i);
      expect(missingSummary({ ...OK, dkim: { ok: false, reason: 'KEY_MISMATCH' } })).toMatch(/different key/i);
      expect(missingSummary({ ...OK, spf: { ok: false, reason: 'NOT_CONFIGURED' } })).toMatch(/not configured/i);
      expect(missingSummary({ ...OK, spf: { ok: false, reason: 'UNAVAILABLE' } })).toMatch(/could not be checked/i);
    });

    it('missingSummary still lists the plainly absent records together', () => {
      expect(
        missingSummary({ dkim: { ok: false, reason: 'MISSING' }, spf: { ok: false, reason: 'MISSING' }, dmarc: { ok: true } }),
      ).toMatch(/Not yet found: DKIM, SPF/);
      expect(missingSummary(OK)).toMatch(/verified/i);
    });
  });
});
