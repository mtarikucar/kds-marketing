import {
  normalizeHostname,
  verifyTxtHost,
  buildInstructions,
  txtHasToken,
  flattenTxt,
} from './custom-domain.dns';

describe('custom-domain.dns (pure)', () => {
  describe('normalizeHostname', () => {
    it('strips scheme/path/port and lower-cases', () => {
      expect(normalizeHostname('https://WWW.Acme.com/funnel')).toBe('www.acme.com');
      expect(normalizeHostname('acme.com:8080')).toBe('acme.com');
      expect(normalizeHostname('  Go.Acme.io ')).toBe('go.acme.io');
    });
    it('rejects non-hostnames', () => {
      expect(normalizeHostname('localhost')).toBeNull();
      expect(normalizeHostname('10.0.0.1')).toBeNull();
      expect(normalizeHostname('not a host')).toBeNull();
      expect(normalizeHostname('')).toBeNull();
    });
  });

  it('builds the CNAME + TXT instructions', () => {
    const recs = buildInstructions('www.acme.com', 'tok123', 'ingress.platform.example');
    const byType = Object.fromEntries(recs.map((r) => [r.type, r]));
    expect(byType.CNAME.host).toBe('www.acme.com');
    expect(byType.CNAME.value).toBe('ingress.platform.example');
    expect(byType.TXT.host).toBe(verifyTxtHost('www.acme.com'));
    expect(byType.TXT.host).toBe('_platform-verify.www.acme.com');
    expect(byType.TXT.value).toBe('platform-verify=tok123');
  });

  describe('txtHasToken', () => {
    it('requires the exact ownership token', () => {
      expect(txtHasToken([['platform-verify=tok123']], 'tok123')).toBe(true);
      expect(txtHasToken([['platform-verify=WRONG']], 'tok123')).toBe(false);
      expect(txtHasToken([['some unrelated txt']], 'tok123')).toBe(false);
      expect(txtHasToken([], 'tok123')).toBe(false);
    });
    it('joins chunked TXT records', () => {
      expect(flattenTxt([['plat', 'form']])).toEqual(['platform']);
      expect(txtHasToken([['platform-verify=tok', '123']], 'tok123')).toBe(true);
    });
  });
});
