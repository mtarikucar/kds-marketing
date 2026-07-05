import { parseAttribution, pickParams } from './attribution-capture.util';

describe('parseAttribution', () => {
  it('returns null when no attribution signal is present', () => {
    expect(parseAttribution({})).toBeNull();
    expect(parseAttribution({ url: 'https://x.co/landing', referrer: 'https://google.com' })).toBeNull();
    expect(parseAttribution({ fields: { name: 'Ada', email: 'a@b.co' } })).toBeNull();
  });

  it('extracts UTM params from the landing-URL query', () => {
    const r = parseAttribution({
      url: 'https://shop.co/lp?utm_source=instagram&utm_medium=cpc&utm_campaign=implant_temmuz&utm_content=hook_a&utm_term=diş',
    });
    expect(r).toMatchObject({
      utmSource: 'instagram',
      utmMedium: 'cpc',
      utmCampaign: 'implant_temmuz',
      utmContent: 'hook_a',
      utmTerm: 'diş',
      landingUrl: expect.stringContaining('shop.co/lp'),
    });
  });

  it('detects and normalizes the platform click-id (first match wins)', () => {
    expect(parseAttribution({ url: 'https://x.co?fbclid=ABC123' })).toMatchObject({ clickId: 'ABC123', clickIdType: 'FBCLID' });
    expect(parseAttribution({ url: 'https://x.co?gclid=G-1' })).toMatchObject({ clickId: 'G-1', clickIdType: 'GCLID' });
    expect(parseAttribution({ url: 'https://x.co?ttclid=T-9' })).toMatchObject({ clickId: 'T-9', clickIdType: 'TTCLID' });
    expect(parseAttribution({ fields: { li_fat_id: 'L-5' } })).toMatchObject({ clickId: 'L-5', clickIdType: 'LICLID' });
  });

  it('captures the click-to-WhatsApp id from an explicit signal', () => {
    expect(parseAttribution({ ctwaClid: 'wa-referral-1' })).toMatchObject({ ctwaClid: 'wa-referral-1' });
  });

  it('prefers hidden fields over URL query over referrer', () => {
    const r = parseAttribution({
      fields: { utm_source: 'field-src' },
      url: 'https://x.co?utm_source=url-src&utm_medium=url-med',
      referrer: 'https://y.co?utm_source=ref-src&utm_medium=ref-med&utm_campaign=ref-camp',
    });
    expect(r!.utmSource).toBe('field-src'); // field wins
    expect(r!.utmMedium).toBe('url-med'); // url wins over referrer
    expect(r!.utmCampaign).toBe('ref-camp'); // falls through to referrer
  });

  it('is case-insensitive on param keys and trims/caps values', () => {
    const r = parseAttribution({ url: 'https://x.co?UTM_Source=IG&FBCLID=  padded  ' });
    expect(r).toMatchObject({ utmSource: 'IG', clickId: 'padded', clickIdType: 'FBCLID' });
  });

  it('tolerates malformed URLs without throwing', () => {
    expect(() => parseAttribution({ url: '::::not a url::::?utm_source=x' })).not.toThrow();
    // a value after ? is still parseable as a query even with a junk scheme
    expect(parseAttribution({ url: 'garbage?utm_source=x' })).toMatchObject({ utmSource: 'x' });
  });
});

describe('pickParams', () => {
  it('extracts arbitrary params from the landing-URL query', () => {
    expect(pickParams({ url: 'https://x.co/lp?jg_cid=camp-42&jg_pid=post-7' }, ['jg_cid', 'jg_pid'])).toEqual({
      jg_cid: 'camp-42',
      jg_pid: 'post-7',
    });
  });

  it('applies the same precedence as parseAttribution: field > URL > referrer', () => {
    const r = pickParams(
      {
        fields: { jg_cid: 'field-c' },
        url: 'https://x.co?jg_cid=url-c',
        referrer: 'https://y.co?jg_cid=ref-c&jg_pid=ref-p',
      },
      ['jg_cid', 'jg_pid'],
    );
    expect(r).toEqual({ jg_cid: 'field-c', jg_pid: 'ref-p' });
  });

  it('omits absent keys and never throws on malformed input', () => {
    expect(pickParams({ url: 'https://x.co/lp' }, ['jg_cid'])).toEqual({});
    expect(() => pickParams({ url: '::::junk::::?jg_cid=a' }, ['jg_cid'])).not.toThrow();
  });

  it('is case-insensitive on param keys', () => {
    expect(pickParams({ url: 'https://x.co?JG_CID=C1' }, ['jg_cid'])).toEqual({ jg_cid: 'C1' });
  });
});
