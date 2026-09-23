import * as fs from 'fs';
import * as path from 'path';
import {
  OAUTH_NETWORKS,
  credentialEnvNames,
} from './modules/marketing/social-planner/oauth/social-oauth.config';
import {
  EMAIL_OAUTH,
  EMAIL_OAUTH_PROVIDERS,
} from './modules/marketing/channels/email-oauth.config';
import {
  ESP_PROVIDERS,
  getVerifier,
} from './modules/marketing/channels/inbound/webhook-verifier';

/**
 * Deploy/env parity guard for the entitlement feature gates.
 *
 * GAP: /billing/summary merges a `platform` object of env-gated feature flags
 * into the SAME entitlements.features map the SPA nav reads, so a flag that is
 * false hides its menu item entirely. Three such features (prospecting,
 * sendingDomains, customDomains) shipped complete but were BORN DEAD in
 * production for months — their env keys were documented in .env.example and
 * read by the code, but nobody added them to deploy.yml, which is the only
 * place config enters prod. No amount of unit testing the features could catch
 * that, because the bug lives in the workflow file.
 *
 * So this spec derives the key list from the source instead of hardcoding it:
 * controller -> the gate functions in the `platform` map -> the config modules
 * they are imported from -> every `process.env.X` those modules read. A fourth
 * feature flag added to that map is therefore covered automatically, and the
 * next one cannot be born dead.
 *
 * NOTE: this asserts the key is PLUMBED, never that it is SET. Every one of
 * these is optional; an unset repo Secret/Variable renders `KEY=` (dotenv reads
 * '' -> falsy), which is exactly the feature-off behavior. Requiring a value
 * would fail every deploy until the owner buys an ESP.
 */

const REPO = path.join(__dirname, '../..');
const DEPLOY_YML = path.join(REPO, '.github/workflows/deploy.yml');
const CONTROLLER = path.join(
  __dirname,
  'modules/marketing/controllers/marketing-billing.controller.ts',
);

/** Credential-shaped keys belong in repo Secrets; operator switches, names and
 *  hosts belong in repo Variables (visible + auditable in the settings UI,
 *  which is the point of a kill-switch). This mirrors deploy.yml's own split. */
const CREDENTIAL_SHAPED = /(_KEY|_SECRET|_TOKEN|_PASSWORD)$/;

/** The gate functions the billing controller merges into entitlements.features. */
function platformGateFunctions(src: string): string[] {
  const block = src.match(/const platform = \{([\s\S]*?)\n\s*\};/);
  expect(block).not.toBeNull();
  const fns = [...block![1].matchAll(/:\s*(\w+)\(/g)].map((m) => m[1]);
  // If this ever comes back empty the merge was restructured — re-derive the
  // key list rather than letting the guard quietly pass on nothing.
  expect(fns.length).toBeGreaterThan(0);
  return fns;
}

/** Resolve each gate function to the .ts file it is imported from. */
function configFilesFor(src: string, fns: string[]): string[] {
  const files = new Set<string>();
  for (const fn of fns) {
    const imp = src.match(
      new RegExp(`import \\{[^}]*\\b${fn}\\b[^}]*\\} from '([^']+)'`),
    );
    expect(imp).not.toBeNull();
    files.add(path.join(path.dirname(CONTROLLER), `${imp![1]}.ts`));
  }
  return [...files];
}

/** Every env key the entitlement gates (and their companions) read. */
function entitlementEnvKeys(): string[] {
  const src = fs.readFileSync(CONTROLLER, 'utf8');
  const keys = new Set<string>();
  for (const file of configFilesFor(src, platformGateFunctions(src))) {
    const cfg = fs.readFileSync(file, 'utf8');
    for (const m of cfg.matchAll(/process\.env\.([A-Z0-9_]+)/g)) keys.add(m[1]);
  }
  expect(keys.size).toBeGreaterThan(0);
  return [...keys].sort();
}

const yml = fs.readFileSync(DEPLOY_YML, 'utf8');
/** The rendered heredoc — `cat > .env.rendered <<ENV` .. `ENV`. */
const heredoc = yml.slice(yml.indexOf('<<ENV'), yml.indexOf('\n          ENV\n'));
/** The same step's `env:` block — from its `- name:` down to its `run: |`. */
const envBlock = yml.slice(
  yml.indexOf('- name: Render .env.production'),
  yml.indexOf('\n        run: |', yml.indexOf('- name: Render .env.production')),
);
/** The hard-required secrets — a deploy dies if one of these is empty. */
const requiredArray = yml.match(/required=\(([\s\S]*?)\)/)![1];

describe('deploy.yml ↔ backend entitlement env parity', () => {
  const keys = entitlementEnvKeys();

  it.each(keys)('%s is passed into the render step env: block', (key) => {
    expect(envBlock).toMatch(
      new RegExp(`^\\s*${key}: \\$\\{\\{ (secrets|vars)\\.${key} \\}\\}$`, 'm'),
    );
  });

  it.each(keys)('%s is echoed into the rendered .env.production', (key) => {
    expect(heredoc).toMatch(new RegExp(`^\\s*${key}=\\$\\{${key}\\}$`, 'm'));
  });

  it.each(keys)('%s uses the right secrets/vars kind for its shape', (key) => {
    const kind = envBlock.match(
      new RegExp(`^\\s*${key}: \\$\\{\\{ (secrets|vars)\\.${key} \\}\\}$`, 'm'),
    )![1];
    expect(kind).toBe(CREDENTIAL_SHAPED.test(key) ? 'secrets' : 'vars');
  });

  it.each(keys)('%s never fails the deploy when unset', (key) => {
    expect(requiredArray).not.toContain(key);
  });
});

/**
 * Deploy/env parity for the social OAuth apps — the same "born dead" failure,
 * one layer over.
 *
 * A network whose platform-app credentials never reach the server can never be
 * connected by anyone: `isNetworkConfigured` is false, the Account Center
 * renders a permanently disabled Connect button, and no repo Secret the owner
 * sets will change it, because the workflow does not forward that secret. That
 * is invisible to every test of the connect flow itself, which is exactly how
 * Pinterest — fully implemented, listed in the provider catalogue — shipped
 * unconnectable.
 *
 * Derived from the network table, so a network added there is covered here.
 * A network may declare SEVERAL env names for one credential (Google's app
 * answers to two); the requirement is that AT LEAST ONE of them is plumbed —
 * the legacy spelling need not be.
 *
 * As above: this asserts PLUMBED, never SET. An unset Secret renders `KEY=`,
 * which the resolver reads as unconfigured — the correct off state.
 */
describe('deploy.yml ↔ social OAuth app credentials', () => {
  const cases = OAUTH_NETWORKS.flatMap((n) => {
    const { id, secret } = credentialEnvNames(n);
    return [
      { network: n, kind: 'client id', names: id },
      { network: n, kind: 'client secret', names: secret },
    ];
  });

  // Not asserting secrets-vs-vars here: every one of these is credential-shaped
  // regardless of suffix (a client id is half of an app credential and is kept
  // in Secrets alongside its secret), which the generic _KEY/_SECRET/_TOKEN
  // name rule cannot see.
  it.each(cases)('$network $kind is passed into the render step env: block', ({ names }) => {
    const plumbed = names.filter(
      (k) =>
        envBlock.includes(k + ': ${{ secrets.' + k + ' }}') ||
        envBlock.includes(k + ': ${{ vars.' + k + ' }}'),
    );
    // Jest prints the received value, so a failure reads as "[] is empty" next
    // to a title that names the network; `names` says which vars were looked for.
    expect({ names, plumbed }).not.toEqual({ names, plumbed: [] });
  });

  it.each(cases)('$network $kind is echoed into the rendered .env.production', ({ names }) => {
    const echoed = names.filter((k) => heredoc.includes(k + '=${' + k + '}'));
    expect({ names, echoed }).not.toEqual({ names, echoed: [] });
  });

  it.each(cases)('$network $kind never fails the deploy when unset', ({ names }) => {
    for (const k of names) expect(requiredArray).not.toContain(k);
  });
});

/**
 * Deploy/env parity for the email platform keys — the same "born dead" failure,
 * on the surface that hurts most when it is silent.
 *
 * A mailbox consent app whose credentials never reach the server cannot be
 * connected by anyone: `isEmailOAuthConfigured()` is false, so the M365 tenant
 * that answers 535 5.7.139 to SMTP AUTH is offered no OAuth route at all and
 * the Gmail user never sees "Connect with Google". Neither the connect flow's
 * own tests nor anything else in the suite can see that, because the bug lives
 * in the workflow file — exactly how Pinterest shipped unconnectable.
 *
 * The OAuth half is DERIVED from `EMAIL_OAUTH`, so a third provider added to
 * that table is covered here the day it lands.
 *
 * The rest is an EXPLICIT list, deliberately not a `process.env` sweep over the
 * email modules, because several email keys legitimately do not travel through
 * the env:/heredoc pair these assertions check and a sweep would red the build
 * for keys that are correctly plumbed elsewhere:
 *   - EMAIL_HOST/PORT/USER/FROM/PASSWORD are appended by the "Ship env +
 *     compose" step from `.env.shared` plus the base64 password round-trip,
 *     AFTER this heredoc, so that the marketing sender identity wins over
 *     core's. They never appear as `KEY: ${{ secrets.KEY }}` here.
 *   - PUBLIC_BASE_URL (read by `emailOAuthRedirectUri()`) is a literal in the
 *     heredoc, not a `${PUBLIC_BASE_URL}` expansion.
 *   - MARKETING_SECRET_KEY is already covered as a hard-required secret.
 *
 * As above: this asserts PLUMBED, never SET. Every key here is optional and an
 * unset Secret renders `KEY=` (dotenv reads '' -> falsy), which is the correct
 * feature-off state. Putting one in `required=(...)` would fail every deploy
 * until the owner registers an app / buys an ESP, so the third assertion pins
 * that it is absent from there.
 */
describe('deploy.yml ↔ email platform env keys', () => {
  /** The mailbox-consent app registrations, derived from the provider table. */
  const oauthCases = EMAIL_OAUTH_PROVIDERS.flatMap((p) => [
    { what: `${EMAIL_OAUTH[p].label} mail client id`, key: EMAIL_OAUTH[p].clientIdEnv },
    { what: `${EMAIL_OAUTH[p].label} mail client secret`, key: EMAIL_OAUTH[p].clientSecretEnv },
  ]);

  /**
   * The per-provider bounce/complaint webhook credentials, DERIVED from the
   * verifier registry rather than listed here.
   *
   * `POST /api/public/esp/feedback/:provider` picks its verifier from the URL,
   * and each verifier is dark until ITS key is set — so a provider added to
   * `ESP_PROVIDERS` with a `requires` list nothing forwards is born dead in
   * exactly the way this whole file exists to prevent: the operator pastes the
   * key into GitHub Secrets, the heredoc never writes it, and every bounce and
   * spam complaint SendGrid/Mailgun/Postmark reports is answered 401 while the
   * health card still calls the feature armed.
   *
   * `ESP_FEEDBACK_SECRET` (the `generic` relay) comes out of this same list —
   * it is that verifier's `requires`, not a separate hardcoded entry.
   */
  const espCases = ESP_PROVIDERS.flatMap((provider) =>
    (getVerifier(provider)!.requires as readonly string[]).map((key) => ({
      what: `ESP feedback (${provider})`,
      key,
    })),
  );

  /** The platform-global email knobs, each named with the surface it powers. */
  const platformCases = [
    // postmark.ts — the OPTIONAL egress allow-list, deliberately not in that
    // verifier's `requires` (unset = not enforced). Still has to be settable,
    // or the belt-and-braces operator has no way to switch it on.
    { what: 'Postmark webhook IP allow-list', key: 'POSTMARK_WEBHOOK_IPS' },
    // platform-bounce-poll.service.ts target() — the ops stop button for the
    // cron that reads the platform's own INBOX. Empty = the poller runs.
    { what: 'platform bounce poll switch', key: 'PLATFORM_BOUNCE_POLL' },
    // inbound-mail webhook — unset, a connected mailbox is send-only.
    { what: 'inbound webhook HMAC', key: 'EMAIL_INBOUND_SECRET' },
    // email.service.ts platformDkim() — both halves or nothing is signed.
    { what: 'platform DKIM selector', key: 'EMAIL_DKIM_SELECTOR' },
    { what: 'platform DKIM private key', key: 'EMAIL_DKIM_PRIVATE_KEY_B64' },
    // campaign-sender.service.ts linkBase() — unset, bulk links stay on
    // PUBLIC_BASE_URL, which is today's behaviour.
    { what: 'bulk link host', key: 'LINK_BASE_URL' },
  ];

  const cases = [...oauthCases, ...espCases, ...platformCases];

  // If the provider table is ever restructured this guard must red rather than
  // quietly pass on an empty `it.each`.
  it('derives a case for every configured email OAuth provider', () => {
    expect(oauthCases).toHaveLength(EMAIL_OAUTH_PROVIDERS.length * 2);
    for (const c of cases) expect(c.key).toMatch(/^[A-Z0-9_]+$/);
  });

  // Same guard for the ESP registry: an empty `requires` list anywhere would
  // silently drop that provider's key out of every assertion below.
  it('derives a case for every ESP feedback verifier', () => {
    expect(espCases.length).toBeGreaterThanOrEqual(ESP_PROVIDERS.length);
    for (const provider of ESP_PROVIDERS) {
      expect(espCases.filter((c) => c.what.includes(`(${provider})`)).length).toBeGreaterThan(0);
    }
  });

  // Not asserting secrets-vs-vars here, for the same reason the social block
  // does not: `GOOGLE_MAIL_CLIENT_ID` and `MICROSOFT_MAIL_CLIENT_ID` do not
  // match the generic /(_KEY|_SECRET|_TOKEN|_PASSWORD)$/ name rule, yet a
  // client id is half of an app credential and belongs in Secrets beside its
  // secret. Demanding `vars.` for them would push that half into a plaintext,
  // world-readable repo Variable — the guard would create the leak.
  it.each(cases)('$what ($key) is passed into the render step env: block', ({ key }) => {
    expect(envBlock).toMatch(
      new RegExp(`^\\s*${key}: \\$\\{\\{ (secrets|vars)\\.${key} \\}\\}$`, 'm'),
    );
  });

  it.each(cases)('$what ($key) is echoed into the rendered .env.production', ({ key }) => {
    expect(heredoc).toMatch(new RegExp(`^\\s*${key}=\\$\\{${key}\\}$`, 'm'));
  });

  it.each(cases)('$what ($key) never fails the deploy when unset', ({ key }) => {
    expect(requiredArray).not.toContain(key);
  });
});
