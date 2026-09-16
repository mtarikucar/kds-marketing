import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EmailService } from './email.service';

/**
 * Iter-98 regression for EmailService template caching.
 *
 * Pre-fix `compileTemplate` did
 *
 *   const src = fs.readFileSync(templatePath, "utf-8");
 *   const template = Handlebars.compile(src);
 *   return template(context);
 *
 * on every send. Cron-driven flows (z-report nightly mailings) and
 * auth bursts (verification + password reset) all hit this hot path.
 * Iter-98 mirrors iter-97's NotificationService cache: lazy-load on
 * first use, memoize in a Map for the process lifetime, async readFile.
 * Unlike NotificationService, compileTemplate THROWS on miss (auth
 * needs to surface the error loudly), and misses are NOT cached.
 */
describe('EmailService template cache (iter-98)', () => {
  let storageRoot: string;
  let originalCwd: string;
  let templatesDir: string;

  beforeAll(() => {
    originalCwd = process.cwd();
    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'email-svc-spec-'));
    templatesDir = path.join(storageRoot, 'templates', 'emails');
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.writeFileSync(
      path.join(templatesDir, 'iter98-test.hbs'),
      '<p>Welcome {{name}}</p>',
    );
    process.chdir(storageRoot);
  });

  afterAll(() => {
    process.chdir(originalCwd);
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  function newService(): EmailService {
    const config = {
      get: jest.fn((key: string, fallback?: any) => {
        // Force the no-transporter "mock" path so sendEmail doesn't try
        // to talk to an SMTP server. compileTemplate still runs first.
        if (key === 'EMAIL_HOST' || key === 'EMAIL_USER' || key === 'EMAIL_PASSWORD') {
          return undefined;
        }
        return fallback;
      }),
    } as any;
    return new EmailService(config);
  }

  it('reads each template file exactly once across multiple renders (cache populated)', async () => {
    const svc = newService();
    const cache: Map<string, any> = (svc as any).templateCache;
    expect(cache.size).toBe(0);

    const compile = (svc as any).compileTemplate.bind(svc);
    const out1 = await compile('iter98-test', { name: 'World' });
    const out2 = await compile('iter98-test', { name: 'Again' });

    expect(out1).toBe('<p>Welcome World</p>');
    expect(out2).toBe('<p>Welcome Again</p>');
    expect(cache.size).toBe(1);
    expect(cache.has('iter98-test')).toBe(true);
  });

  it('throws on missing template and does NOT cache the miss', async () => {
    const svc = newService();
    const compile = (svc as any).compileTemplate.bind(svc);
    await expect(compile('does-not-exist', {})).rejects.toThrow(
      /Email template does-not-exist not found or invalid/,
    );
    // Critical: missing-template state must not persist in the cache.
    // If a later deploy adds the template, the next call should pick
    // it up without a process restart.
    expect((svc as any).templateCache.has('does-not-exist')).toBe(false);
  });

  it('re-renders the cached template with different contexts', async () => {
    const svc = newService();
    const compile = (svc as any).compileTemplate.bind(svc);
    const a = await compile('iter98-test', { name: 'Alice' });
    const b = await compile('iter98-test', { name: 'Bob' });
    const c = await compile('iter98-test', { name: 'Carol' });
    expect(a).toBe('<p>Welcome Alice</p>');
    expect(b).toBe('<p>Welcome Bob</p>');
    expect(c).toBe('<p>Welcome Carol</p>');
  });

  /**
   * The platform transport's half of RFC 8058. A workspace without its own
   * verified mailbox sends its campaigns from here, so the headers have to come
   * out of these two methods as well as the channel adapter — otherwise whether
   * a client offers an Unsubscribe button depends on which transport happened
   * to carry the mail.
   */
  describe('List-Unsubscribe on the platform transport', () => {
    function withTransport() {
      const svc = newService();
      const sendMail = jest.fn().mockResolvedValue({ messageId: '<x@y>' });
      // The constructor builds a transporter from EMAIL_HOST/USER/PASSWORD,
      // which newService() deliberately leaves unset (the [EMAIL MOCK] path).
      // Standing one in is what lets these tests see the wire.
      (svc as any).transporter = { sendMail };
      return { svc, sendMail };
    }

    it('sendCampaignEmail carries the pair when given an unsubscribe URL', async () => {
      const { svc, sendMail } = withTransport();
      await svc.sendCampaignEmail('a@b.test', 'S', 'text', '<p>rich</p>', undefined, 'https://m.test/api/public/u/tok-1');
      expect(sendMail.mock.calls[0][0].headers).toEqual({
        'List-Unsubscribe': '<https://m.test/api/public/u/tok-1>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      });
    });

    it('sendPlainEmail carries it too — a plain-text campaign is still bulk', async () => {
      const { svc, sendMail } = withTransport();
      await svc.sendPlainEmail('a@b.test', 'S', 'text', undefined, 'https://m.test/api/public/u/tok-2');
      expect(sendMail.mock.calls[0][0].headers).toMatchObject({
        'List-Unsubscribe': '<https://m.test/api/public/u/tok-2>',
      });
    });

    it('omits the headers entirely on a transactional send', async () => {
      // These same methods carry password resets and status notices. Marking
      // those as list mail would invite a client to "unsubscribe" from them.
      const { svc, sendMail } = withTransport();
      await svc.sendPlainEmail('a@b.test', 'Your code', 'text');
      expect(sendMail.mock.calls[0][0]).not.toHaveProperty('headers');
    });
  });
});
