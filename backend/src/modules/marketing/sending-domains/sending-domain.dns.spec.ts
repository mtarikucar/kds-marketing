import {
  normalizeDomain,
  buildRecords,
  dkimHost,
  dmarcHost,
  dkimMatches,
  spfMatches,
  dmarcMatches,
  allVerified,
  missingSummary,
  flattenTxt,
} from './sending-domain.dns';

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

  it('builds the three DNS records at the right hosts', () => {
    const recs = buildRecords({ domain: 'mail.acme.com', selector: 'mkt1a2b', publicKeyB64Der: 'PUBKEY', spfInclude: 'spf.platform.example' });
    const byLabel = Object.fromEntries(recs.map((r) => [r.label, r]));
    expect(byLabel.DKIM.host).toBe(dkimHost('mkt1a2b', 'mail.acme.com'));
    expect(byLabel.DKIM.value).toBe('v=DKIM1; k=rsa; p=PUBKEY');
    expect(byLabel.SPF.host).toBe('mail.acme.com');
    expect(byLabel.SPF.value).toContain('include:spf.platform.example');
    expect(byLabel.DMARC.host).toBe(dmarcHost('mail.acme.com'));
    expect(byLabel.DMARC.value).toMatch(/^v=DMARC1/);
  });

  describe('record matchers', () => {
    it('dkimMatches requires our exact public key in the p= tag', () => {
      expect(dkimMatches([['v=DKIM1; k=rsa; p=ABC123']], 'ABC123')).toBe(true);
      expect(dkimMatches([['v=DKIM1; k=rsa; p=WRONG']], 'ABC123')).toBe(false);
      expect(dkimMatches([['some other txt']], 'ABC123')).toBe(false);
    });
    it('joins chunked TXT records (wire splits long values at 255 chars)', () => {
      // a DKIM value can be returned as multiple chunks
      expect(dkimMatches([['v=DKIM1; k=rsa; p=AB', 'C123']], 'ABC123')).toBe(true);
      expect(flattenTxt([['ab', 'cd']])).toEqual(['abcd']);
    });
    it('spfMatches needs v=spf1 + our include', () => {
      expect(spfMatches([['v=spf1 include:spf.platform.example ~all']], 'spf.platform.example')).toBe(true);
      expect(spfMatches([['v=spf1 -all']], 'spf.platform.example')).toBe(false);
    });
    it('dmarcMatches needs a DMARC1 record', () => {
      expect(dmarcMatches([['v=DMARC1; p=quarantine']])).toBe(true);
      expect(dmarcMatches([['nope']])).toBe(false);
    });
  });

  it('allVerified + missingSummary reflect which records are present', () => {
    expect(allVerified({ dkim: true, spf: true, dmarc: true })).toBe(true);
    expect(allVerified({ dkim: true, spf: false, dmarc: true })).toBe(false);
    expect(missingSummary({ dkim: true, spf: false, dmarc: false })).toMatch(/SPF, DMARC/);
    expect(missingSummary({ dkim: true, spf: true, dmarc: true })).toMatch(/verified/i);
  });
});
