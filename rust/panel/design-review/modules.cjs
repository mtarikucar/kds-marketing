#!/usr/bin/env node
/** Fixture-only visual/interaction review of the four module pages that replaced the Growth Studio
 * (content, social media, advertising) and of Bütçe's spend view. No API request or provider
 * navigation leaves this harness.
 * Run from any directory: node rust/panel/design-review/modules.cjs
 * JEETA_REVIEW_URL defaults to http://localhost:5180; JEETA_REVIEW_OUT defaults to /tmp/jeeta-modules-review.
 * Optional JEETA_REVIEW_FILTER matches scenario names. Uses existing repository dependencies only.
 */
const { chromium } = require('../../../frontend/node_modules/playwright');
const ts = require('../node_modules/typescript');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const src = path.resolve(__dirname, '../src');
const baseUrl = process.env.JEETA_REVIEW_URL || 'http://localhost:5180';
const out = process.env.JEETA_REVIEW_OUT || '/tmp/jeeta-modules-review';
const tr = require('../src/i18n/tr.json');
const moduleCache = new Map();
function evaluate(file, source) {
  const module = { exports: {} };
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function('exports', 'require', 'module', code)(module.exports, (ref) => {
    if (ref.endsWith('.json')) return require(path.resolve(src, ref.replace(/^@\//, '')));
    if (ref.startsWith('@/test/') && ref !== '@/test/render') return load(path.resolve(src, ref.slice(2)) + '.ts');
    if (ref.endsWith('/render')) return {};
    if (ref.startsWith('.')) return load(path.resolve(path.dirname(file), ref) + '.ts');
    // Test fixtures before describe() do not call test helpers, React, or network functions.
    return {};
  }, module);
  return module.exports;
}
function load(file) {
  if (!moduleCache.has(file)) moduleCache.set(file, evaluate(file, fs.readFileSync(file, 'utf8')));
  return moduleCache.get(file);
}
function fixture(file, names) {
  const absolute = path.join(src, file), source = fs.readFileSync(absolute, 'utf8');
  const end = source.indexOf('\ndescribe(');
  assert(end > 0, `Fixture preamble not found: ${file}`);
  return evaluate(absolute, source.slice(0, end) + '\nmodule.exports = {' + names.join(',') + '};');
}
const f = load(path.join(src, 'test/fixtures.ts'));
const content = load(path.join(src, 'test/content.ts'));
const social = load(path.join(src, 'test/social.ts'));
const ads = load(path.join(src, 'test/ads.ts'));
const modules = load(path.join(src, 'test/modules.ts'));
const common = {
  ...social.socialAnswers, ...ads.adsAnswers,
  // The unit tests answer this by default (`test/render.tsx`); a browser has to be told.
  'GET /api/workspace/modules': modules.legacyModules,
  // The module status line reads the connected agents' keys.
  'GET /api/api-keys': f.keys,
  // No ad platform in a fixture: an empty preview shows the panel's own neutral preview.
  'GET /api/ads/campaigns/campaign-1/ads/0/preview': { html: '' },
  'GET /api/agents': f.agents,
  'GET /api/strategy': f.strategyWithDraft,
  'GET /api/studio/projects': { projects: [], next_cursor: null, next_done_before: null },
};
// The production line: one area in each state a person meets.
const areas = [
  content.area('queued', { title: 'Kupa serisini tanıt', state: { state: 'queued', step: null, note: null, starts_at: '2026-11-12T09:00:00Z' } }),
  content.area('working', { title: 'Atölye turu', state: { state: 'working', step: 9, note: 'Görsel hazırlanıyor', starts_at: '2026-11-10T09:00:00Z' } }),
  content.area('waiting', { title: 'Yeni sezon', state: { state: 'waiting_material', step: null, note: null, starts_at: '2026-11-10T09:00:00Z' } }),
  content.area('held', { title: 'Kampanya duyurusu', refused: 3, state: { state: 'held', step: null, note: null, starts_at: '2026-11-09T09:00:00Z' } }),
];
const finished = content.area('done', { title: 'Biten içerik', packages: [content.pack], state: { state: 'done', step: null, note: null, starts_at: '2026-11-01T09:00:00Z' } });
const projects = u => ({
  projects: u.searchParams.get('archived') === 'true' ? [] : u.searchParams.get('scope') === 'done' ? [finished] : areas,
  next_cursor: null, next_done_before: null,
});
const approvalPending = { slots: [], approvals: [{ slot: 's1' }], blockers: [{ target: { slot: 's1' }, reason: 'human_approval_required' }], budget_moves: [], paid_alerts: [] };
const proposal = { ...ads.campaign, id: 'proposal-1', title: 'Ajanın önerisi', opened_by: { kind: 'system', agent: 'agent1' }, approval: null, plan: null, built: null, moves: [], state: { state: 'proposed', note: null }, totals: { spent_minor: 0, results: null, result_kind: null, impressions: null, clicks: null } };
const stopped = { ...ads.breakdown, stop: { revision: 9, all: false, modules: ['ads', 'inbox'], paused: [{ module: 'ads', title: ads.campaign.title, state: 'paused' }, { module: 'ads', title: 'İkinci reklam', state: 'pausing' }] } };
const scenarios = [];
function add(name, url, data = {}, options = {}) { scenarios.push({ name, url, data, ...options }); }
add('content-line', '/content', { 'GET /api/studio/projects': projects });
add('content-empty', '/content', {});
add('content-area-done', '/content?area=done', { 'GET /api/studio/projects': projects, 'GET /api/studio/projects/done': content.detail(finished) });
add('social-accounts', '/social', {});
add('social-account', '/social?account=ig1', {});
add('social-empty', '/social', { 'GET /api/social/accounts': [] });
add('social-packages', '/social?tab=packages', {});
add('social-packages-blocked', '/social?tab=packages', { 'GET /api/social/packages': social.socialAnswers['GET /api/social/packages'].map(p => ({ ...p, versions: p.versions.map(v => ({ ...v, accounts: [], blocked: 'hypothesis_does_not_post' })) })) });
add('social-settings', '/social?tab=settings', {});
add('social-approval', '/social?slot=s1', { 'GET /api/studio/pending': approvalPending }, { ready: async p => p.getByRole('region', { name: tr.socialAccounts.approvalTitle }).waitFor() });
add('ads-queue', '/ads', {});
add('ads-empty', '/ads', { 'GET /api/ads/campaigns': { campaigns: [], next_before: null } });
add('ads-campaign', '/ads?campaign=campaign-1', {});
add('ads-proposal', '/ads?campaign=proposal-1', { 'GET /api/ads/campaigns': { campaigns: [proposal], next_before: null }, 'GET /api/ads/campaigns/proposal-1': { campaign: proposal, materials: [], days: [] } });
// A campaign a person has to read closely: a refused plan, a budget's stop, an end the ad platform
// has not confirmed yet.
const detail = campaign => ({ 'GET /api/ads/campaigns/campaign-1': { campaign, materials: [], days: [] } });
add('ads-plan-refused', '/ads?campaign=campaign-1', detail({ ...ads.campaign, plan: null, built: null, refused: 2, state: { state: 'queued', note: null },
  refusal: [{ field: 'ad_account', reason: 'not_a_usable_ad_account' }, { field: 'budget_minor', reason: 'below_the_accounts_minimum', least: 700000 }, { field: 'ads[0].primary_text', reason: 'claim_not_in_strategy' }] }));
add('ads-stopped-by-budget', '/ads?campaign=campaign-1', detail({ ...ads.campaign, stop: { by: 'budget', at: '2026-11-12T09:00:00Z', reason: 'budget_exhausted' }, state: { state: 'paused', note: 'budget_exhausted' } }));
add('ads-ended-not-confirmed', '/ads?campaign=campaign-1', detail({ ...ads.campaign, ended: { at: '2026-11-13T09:00:00Z', reason: 'person' }, state: { state: 'ended', note: 'provider_still_running' } }));
add('budget-spending', '/budget', {});
add('budget-held', '/budget', { 'GET /api/budget/breakdown': { ...ads.breakdown, items: [{ ...ads.breakdown.items[0], held_minor: 175000 }] } });
add('budget-stopped', '/budget', { 'GET /api/budget/breakdown': stopped });
for (const [name, url, endpoint] of [
  ['content', '/content', '/api/studio/projects'],
  ['social', '/social', '/api/social/accounts'],
  ['ads', '/ads', '/api/ads/campaigns'],
]) {
  add(name + '-error-retry', url, {}, { failed: endpoint, ready: async p => p.getByRole('button', { name: tr.common.retry, exact: true }).first().waitFor(), retry: true });
}
(async()=>{
 fs.mkdirSync(out,{recursive:true});
 const browser=await chromium.launch({args:['--no-sandbox']}); const results=process.env.JEETA_REVIEW_RESUME && fs.existsSync(path.join(out,'results.json')) ? JSON.parse(fs.readFileSync(path.join(out,'results.json'),'utf8')).results : [];
 const save=()=>fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({baseUrl,at:new Date().toISOString(),results},null,2)+'\n');
 try {
  for (const scenario of scenarios.filter(s=>(!process.env.JEETA_REVIEW_CASES||process.env.JEETA_REVIEW_CASES.split(',').includes(s.name))&&(!process.env.JEETA_REVIEW_FILTER||s.name.includes(process.env.JEETA_REVIEW_FILTER)))) {
   for (const width of (process.env.JEETA_REVIEW_WIDTHS || '1440,390').split(',').map(Number)) {
    const prior=results.findIndex(r=>r.scenario===scenario.name&&r.width===width);
    if(prior>=0 && results[prior].passed && !results[prior].unexpected.length)continue;
    if(prior>=0)results.splice(prior,1);
    const p=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'}), errors=[], unexpected=[], writes=[];
    p.setDefaultTimeout(8000);
    const answers={...common,...scenario.data}; let recover=false;
    await p.route('**/*',async route=>{
     const u=new URL(route.request().url());
     if(u.origin!==new URL(baseUrl).origin) return route.abort();
     if(!u.pathname.startsWith('/api/')) return route.continue();
     const key=route.request().method()+' '+u.pathname;
     if(route.request().method()!=='GET')writes.push(key);
     if(scenario.delayed===u.pathname) await new Promise(resolve=>setTimeout(resolve,4500));
     if(scenario.failed===u.pathname&&!recover)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'INTERNAL',message:'Review fixture: unavailable',details:{}})});
     if(!(key in answers))unexpected.push(key);
     return route.fulfill({status:key in answers?200:404,contentType:'application/json',body:JSON.stringify((typeof answers[key]==='function'?answers[key](u):answers[key])??{code:'NOT_FOUND',message:'Review fixture missing',details:{}})});
    });
    p.on('pageerror',e=>errors.push(e.message));
    const record={scenario:scenario.name,width,passed:false,errors,unexpected,writes};
    try {
     await p.goto(baseUrl+scenario.url); await p.locator('h1').first().waitFor();
     if(scenario.ready)await scenario.ready(p); else await p.waitForTimeout(300);
     if(scenario.action)await scenario.action(p);
     if(scenario.dialog){ await p.getByRole('dialog').waitFor(); await p.waitForTimeout(250); const box=await p.getByRole('dialog').boundingBox(); assert(box && box.x>=0 && box.x+box.width<=width, 'dialog outside viewport'); }
     if(!scenario.dialog)await p.evaluate(()=>scrollTo(0,0));
     await p.screenshot({path:path.join(out,`${scenario.name}-${width}.png`),fullPage:!scenario.dialog,animations:'disabled'});
     record.overflow=await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
     assert.equal(record.overflow,false,'document horizontal overflow'); assert.deepEqual(errors,[],'browser exception'); assert.deepEqual(unexpected,[],'unmocked API route');
     if(scenario.retry){recover=true;await p.getByRole('button',{name:tr.common.retry,exact:true}).first().click();await p.getByRole('button',{name:tr.common.retry,exact:true}).first().waitFor({state:'hidden'});}
     if(scenario.dialog){await p.keyboard.press('Escape'); await p.getByRole('dialog').waitFor({state:'hidden'}); await p.waitForTimeout(50); assert(await p.evaluate(()=>document.activeElement===window.__reviewOpener), 'dialog did not restore opener focus');}
     record.passed=true;
    } catch(e){record.failure=e.message;}
    results.push(record); save(); console.log(JSON.stringify(record)); await p.close();
   }
  }
 } finally { await browser.close(); save(); }
 if(results.some(x=>!x.passed))process.exitCode=1;
})().catch(e=>{console.error(e);process.exit(1)});
