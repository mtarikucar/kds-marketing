/* Local-only lead workflow visual fixtures. Start Vite, then run:
 * node design-review/leads.cjs [base-url] [output-dir]
 * All API responses come from checked-in test fixtures. */
const { buildSync } = require('../../../frontend/node_modules/esbuild');
const { chromium } = require('../../../frontend/node_modules/playwright');
const os = require('os');
const path = require('path');
const fs = require('fs');
const fixturePath = path.join(os.tmpdir(), 'jeeta-leads-review-fixtures.cjs');
buildSync({ entryPoints: [path.join(__dirname, '../src/test/leads.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: fixturePath, logLevel: 'silent' });
const f = require(fixturePath);
const tr = require('../src/i18n/tr.json');
const base = process.argv[2] || process.env.JEETA_REVIEW_URL || 'http://localhost:5180';
const output = process.argv[3] || path.join(os.tmpdir(), 'jeeta-leads-review');
fs.mkdirSync(output, { recursive: true });
const task = f.task(1);
const responses = {
  '/api/auth/me': f.leadsMe,
  '/api/agents': f.agentsList, '/api/team': f.team,
  '/api/prospects': { items: [f.row(1), f.row(2)], next: null },
  [`/api/prospects/${f.prospectId(1)}`]: f.prospectOut(1), '/api/prospects/playbook': f.playbook,
  '/api/research/tasks': { items: [{ task, remaining_today: 8 }], next: null },
  [`/api/research/tasks/${task.id}`]: { task, remaining_today: 8, found: 3, prospects: [f.row(1)] },
  '/api/outreach/audience-preview': { eligible: 12, by_skip_reason: { no_deliverable_email: 3 }, basis: { consent: 4, business_recipient: 8 }, promotions_needed: 5, business_basis_in_force: true, truncated: false },
  '/api/outreach/settings': f.outreachSettings, '/api/outreach/templates': { items: [f.template(1)], next: null },
  '/api/outreach/campaigns': { items: [f.campaignRow()], next: null },
  [`/api/outreach/campaigns/${f.CAMPAIGN_ID}`]: f.campaignOut(),
  [`/api/outreach/campaigns/${f.CAMPAIGN_ID}/enrollments`]: { items: [], next: null },
  '/api/capabilities': [f.mailbox], '/api/distribution': f.distribution,
  '/api/distribution/assignments': { items: [], next: null },
};
const scenarios = [
  ['prospects', '/prospects'],
  ['prospect-reject', `/prospects/${f.prospectId(1)}`, async p => p.getByRole('button', { name: tr.leads.actions.reject }).click()],
  ['prospect-dnc', `/prospects/${f.prospectId(1)}`, async p => p.getByRole('button', { name: tr.leads.actions.dnc }).click()],
  ['prospect-detail', `/prospects/${f.prospectId(1)}`], ['research', '/prospects/tasks'],
  ['campaigns', '/outreach'], ['campaign-new', '/outreach/new'], ['campaign-detail', `/outreach/${f.CAMPAIGN_ID}`],
  ['templates', '/outreach/templates', async p => p.getByRole('button', { name: 'Tanışma 1' }).click()],
  ['settings', '/outreach/settings'], ['distribution', '/team/distribution'],
  ['prospects-empty', '/prospects', null, 'empty-prospects'],
  ['prospects-filtered', '/prospects', async p => p.getByRole('combobox', { name: tr.leads.prospects.filters.status }).selectOption('new'), 'empty-prospects'],
  ['campaigns-empty', '/outreach', null, 'empty-campaigns'],
  ['campaigns-filtered', '/outreach', async p => p.getByRole('combobox', { name: tr.leads.outreach.statusFilter }).selectOption('running'), 'empty-campaigns'],
  ['campaign-approval', `/outreach/${f.CAMPAIGN_ID}`, null, 'approval'],
  ['campaign-approval-rep', `/outreach/${f.CAMPAIGN_ID}`, null, 'approval-rep'],
  ['campaign-running', `/outreach/${f.CAMPAIGN_ID}`, null, 'running'],
  ['campaign-stop-error', `/outreach/${f.CAMPAIGN_ID}`, async p => { await p.getByRole('button', { name: tr.leads.enrollments.stop }).click(); await p.getByText(tr.errors.INTERNAL).waitFor(); }, 'running-error'],
  ['campaign-blocked', `/outreach/${f.CAMPAIGN_ID}`, null, 'locked'],
  ['campaign-paused', `/outreach/${f.CAMPAIGN_ID}`, null, 'paused'],
  ['campaign-refused', `/outreach/${f.CAMPAIGN_ID}`, async p => { await p.getByRole('button', { name: tr.leads.campaign.launch }).click(); await p.getByText(tr.leads.errors.outreach_disabled_on_platform).waitFor(); }, 'refused'],
  ['settings-rep', '/outreach/settings', null, 'rep'],
  ['settings-locked', '/outreach/settings', null, 'locked'],
  ['prospects-error', '/prospects', null, 'prospects-error'],
  ['distribution-rep', '/team/distribution', async p => p.getByRole('button', { name: 'Rana Temsilci için düzenle' }).click(), 'rep'],
];
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
  const results = [];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    for (const [name, url, action, variant] of scenarios) {
      if (process.env.JEETA_REVIEW_SCENARIOS && !process.env.JEETA_REVIEW_SCENARIOS.split(',').includes(name)) continue;
      const page = await browser.newPage({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/api/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (!pathname.startsWith('/api/')) return route.continue();
        if (variant === 'running-error' && pathname.endsWith('/stop')) return route.fulfill({ status: 500, json: { code: 'INTERNAL', message: 'Fixture error', details: {} } });
        if (variant === 'refused' && pathname.endsWith('/launch')) return route.fulfill({ status: 403, json: { code: 'FORBIDDEN', message: 'Fixture refusal', details: { reason: 'outreach_disabled_on_platform' } } });
        if (variant === 'prospects-error' && pathname === '/api/prospects') return route.fulfill({ status: 500, json: { code: 'INTERNAL', message: 'Fixture error', details: {} } });
        let payload = responses[pathname];
        if ((variant === 'rep' || variant === 'approval-rep') && pathname === '/api/auth/me') payload = f.leadsRep;
        if (variant === 'locked' && pathname === '/api/outreach/settings') payload = { ...f.outreachSettings, platform_enabled: false, sender_identity_complete: false };
        if ((variant === 'approval' || variant === 'approval-rep') && pathname === `/api/outreach/campaigns/${f.CAMPAIGN_ID}`) payload = f.campaignOut({ status: 'awaiting_approval' }, { approval_required: true });
        if ((variant === 'running' || variant === 'running-error') && pathname === `/api/outreach/campaigns/${f.CAMPAIGN_ID}`) payload = f.campaignOut({ status: 'running', launched_at: '2026-11-04T09:00:00Z' }, { active_enrollments: 1 });
        if ((variant === 'running' || variant === 'running-error') && pathname.endsWith('/enrollments')) payload = { items: [{ id: 'review-enrollment', campaign_id: f.CAMPAIGN_ID, person_id: 'review-person', prospect_id: f.prospectId(1), status: 'active', stop: null, skip: null, next_step: 1, next_send_at: '2026-11-05T07:00:00Z', basis: 'business_recipient' }, { id: 'review-stopped', campaign_id: f.CAMPAIGN_ID, person_id: 'review-person-2', prospect_id: null, status: 'stopped', stop: 'replied', skip: null, next_step: 1, next_send_at: null, basis: 'consent' }], next: null };
        if (variant === 'paused' && pathname === `/api/outreach/campaigns/${f.CAMPAIGN_ID}`) payload = f.campaignOut({ status: 'paused', pause_reason: 'bounce_rate' });
        if (variant === 'empty-prospects' && pathname === '/api/prospects') payload = { items: [], next: null };
        if (variant === 'empty-campaigns' && pathname === '/api/outreach/campaigns') payload = { items: [], next: null };
        if (payload === undefined) return route.fulfill({ status: 404, json: { code: 'NOT_FOUND', message: 'Fixture route missing', details: {} } });
        return route.fulfill({ json: payload });
      });
      try {
        await page.goto(base + url, { waitUntil: 'networkidle' });
        await page.locator('#root > *').first().waitFor({ timeout: 10000 });
        if (action) await action(page);
        await page.screenshot({ path: path.join(output, `${name}-${viewport.width}.png`), fullPage: true, animations: 'disabled' });
        const overflow = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth, offenders: [...document.querySelectorAll('*')].filter(e => { if (e.getBoundingClientRect().right <= innerWidth + 1) return false; let p = e.parentElement; while (p && p !== document.body) { if (['auto', 'hidden', 'scroll', 'clip'].includes(getComputedStyle(p).overflowX)) return false; p = p.parentElement; } return true; }).slice(0, 12).map(e => `${e.tagName}.${e.className}: ${Math.round(e.getBoundingClientRect().right)}`) }));
        results.push({ name, width: viewport.width, overflow: overflow.document > overflow.viewport, errors });
        if (overflow.document > overflow.viewport || errors.length) process.exitCode = 1;
        console.log(`${name} ${viewport.width}: ${overflow.document > overflow.viewport ? `document overflow ${overflow.document} ${overflow.offenders.join(' | ')}` : 'ok'}`);
      } catch (e) { results.push({ name, width: viewport.width, error: e.message }); console.error(`${name} ${viewport.width}: ${e.message}`); process.exitCode = 1; }
      await page.close();
    }
  }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  await browser.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
