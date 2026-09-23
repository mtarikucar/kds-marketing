import { isAutomatedFetch } from './automated-fetch';

/**
 * A real recipient clicking a link in their mail client. Every current browser
 * — including the Chromium/WebKit webviews inside the Gmail and Outlook apps —
 * sends this shape on a top-level navigation, so it is the baseline that must
 * NEVER be classified as automated.
 */
function humanClick(extra: Record<string, string | undefined> = {}) {
  return {
    method: 'GET',
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8',
      'accept-language': 'tr-TR,tr;q=0.9,en;q=0.8',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      ...extra,
    },
  };
}

describe('isAutomatedFetch', () => {
  describe('humans are never flagged', () => {
    it('passes a plain browser navigation', () => {
      expect(isAutomatedFetch(humanClick())).toBe(false);
    });

    it('passes a browser that sends no Sec-Fetch headers at all (older / in-app webviews)', () => {
      expect(
        isAutomatedFetch(humanClick({ 'sec-fetch-mode': undefined, 'sec-fetch-dest': undefined })),
      ).toBe(false);
    });

    it('passes a browser with no Accept-Language (one weak signal is not enough)', () => {
      expect(isAutomatedFetch(humanClick({ 'accept-language': undefined }))).toBe(false);
    });

    it('passes a mobile Safari navigation', () => {
      expect(
        isAutomatedFetch({
          method: 'GET',
          headers: {
            'user-agent':
              'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'en-GB,en;q=0.9',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-dest': 'document',
          },
        }),
      ).toBe(false);
    });
  });

  describe('strong signals', () => {
    it('flags HEAD whatever else the request looks like', () => {
      // The whole point: Defender/Safe Links increasingly send a Chrome UA, so
      // the method is the only signal that survives a convincing disguise.
      expect(isAutomatedFetch({ ...humanClick(), method: 'HEAD' })).toBe(true);
      expect(isAutomatedFetch({ ...humanClick(), method: 'head' })).toBe(true);
    });

    it('flags a non-navigate Sec-Fetch-Mode', () => {
      expect(isAutomatedFetch(humanClick({ 'sec-fetch-mode': 'no-cors' }))).toBe(true);
    });

    it('flags a non-document Sec-Fetch-Dest', () => {
      expect(isAutomatedFetch(humanClick({ 'sec-fetch-dest': 'empty' }))).toBe(true);
    });

    it('flags a declared prefetch', () => {
      expect(isAutomatedFetch(humanClick({ 'sec-purpose': 'prefetch;anonymous-client-ip' }))).toBe(
        true,
      );
    });

    it('flags an Accept that cannot render a page', () => {
      expect(isAutomatedFetch(humanClick({ accept: 'application/json' }))).toBe(true);
    });

    it('flags an empty or missing user agent', () => {
      expect(isAutomatedFetch(humanClick({ 'user-agent': '' }))).toBe(true);
      expect(isAutomatedFetch(humanClick({ 'user-agent': undefined }))).toBe(true);
    });

    it.each([
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'curl/8.4.0',
      'Wget/1.21.3',
      'python-requests/2.31.0',
      'Go-http-client/1.1',
      'okhttp/4.12.0',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/124.0.0.0 Safari/537.36',
      'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
      'Twitterbot/1.0',
      'facebookexternalhit/1.1',
      'WhatsApp/2.23.20.0',
      'TelegramBot (like TwitterBot)',
      'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
      'Mozilla/5.0 (Windows NT 10.0) BingPreview/1.0b',
      'Microsoft Office Word/16.0 MSOffice 16',
      'Mimecast Link Protection Scanner',
      'Proofpoint URL Defense',
      'Mozilla/5.0 (compatible; SiteMonitor/1.0)',
      'Mozilla/5.0 (compatible; YandexSpider/3.0)',
      'SomeCrawler/2.0',
    ])('flags the scanner/bot user agent %s', (ua) => {
      expect(isAutomatedFetch(humanClick({ 'user-agent': ua }))).toBe(true);
    });
  });

  describe('weak signals only count in pairs', () => {
    it('flags a wildcard Accept with no Accept-Language (the curl shape)', () => {
      expect(
        isAutomatedFetch({
          method: 'GET',
          headers: {
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/124.0.0.0 Safari/537.36',
            accept: '*/*',
          },
        }),
      ).toBe(true);
    });

    it('does not flag a wildcard Accept alone', () => {
      expect(isAutomatedFetch(humanClick({ accept: '*/*' }))).toBe(false);
    });
  });

  describe('hostile input', () => {
    it('never throws on a missing headers bag', () => {
      expect(isAutomatedFetch({ method: 'GET' })).toBe(true); // no UA at all
      expect(isAutomatedFetch({})).toBe(true);
    });

    it('reads the first value of a repeated header', () => {
      expect(
        isAutomatedFetch({
          method: 'GET',
          headers: { ...humanClick().headers, 'user-agent': ['curl/8.4.0', 'Mozilla/5.0'] },
        }),
      ).toBe(true);
    });

    it('caps how much user agent it will scan', () => {
      // A megabyte UA must not turn a regex into a CPU bill.
      const ua = `${'a'.repeat(5000)}bot`;
      expect(isAutomatedFetch(humanClick({ 'user-agent': ua }))).toBe(false);
    });
  });
});
