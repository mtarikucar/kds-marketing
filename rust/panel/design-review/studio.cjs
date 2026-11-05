#!/usr/bin/env node
/** Fixture-only visual/interaction review. No API request or provider navigation leaves this harness.
 * Run from any directory: node rust/panel/design-review/studio.cjs
 * JEETA_REVIEW_URL defaults to http://localhost:5180; JEETA_REVIEW_OUT defaults to /tmp/jeeta-studio-review.
 * Optional JEETA_REVIEW_FILTER matches scenario names. Uses existing repository dependencies only.
 */
const { chromium } = require('../../../frontend/node_modules/playwright');
const ts = require('../node_modules/typescript');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const src = path.resolve(__dirname, '../src');
const baseUrl = process.env.JEETA_REVIEW_URL || 'http://localhost:5180';
const out = process.env.JEETA_REVIEW_OUT || '/tmp/jeeta-studio-review';
const tr = require('../src/i18n/tr.json');
const moduleCache = new Map();
function evaluate(file, source) {
  const module = { exports: {} };
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function('exports', 'require', 'module', code)(module.exports, (ref) => {
    if (ref.endsWith('.json')) return require(path.resolve(src, ref.replace(/^@\//, '')));
    if (ref.startsWith('@/test/') && ref !== '@/test/render') return load(path.resolve(src, ref.slice(2)) + '.ts');
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
const m = load(path.join(src, 'test/materials.ts'));
const posts = load(path.join(src, 'test/posts.ts'));
const studio = fixture('pages/StudioPage.test.tsx', ['answers', 'overview', 'slot']);
const tiktok = fixture('pages/StudioTiktok.test.tsx', ['answers', 'screenAnswer', 'creator', 'detail', 'slot', 'approvedIn']);
const calendar = fixture('pages/materials/MaterialsCalendar.test.tsx', ['answers']);
const olays = fixture('pages/materials/MaterialsOlays.test.tsx', ['answers', 'confirmed']);
const shoots = fixture('pages/materials/MaterialsShoots.test.tsx', ['answers']);
const editor = fixture('pages/materials/MaterialEditor.test.tsx', ['answers', 'suggested']);
const hold = fixture('pages/materials/MaterialHold.test.tsx', ['base', 'overview', 'detail']);
const common = {
  ...studio.answers, ...m.materialsAnswers, ...posts.postsAnswers,
  'GET /api/auth/me': studio.answers['GET /api/auth/me'],
  'GET /api/strategy': f.strategyWithDraft,
  'GET /api/strategy/versions': f.versions,
  'GET /api/capability-groups': [],
  'GET /api/studio/slots/s1/tiktok/metrics': { post: null, metrics: null, draft: false },
  [`GET /api/strategy/versions/${f.DRAFT_ID}/consultation`]: f.consultation,
  [`GET /api/strategy/versions/${f.APPROVED_ID}/consultation`]: [],
  'GET /api/studio/slots/s1/materials': { candidates: [], refused: [] },
};
const used = [{ slot_id: 's9', piece_id: 'p9', revision: 1, role: 'anchor', slot_state: 'published', scheduled_at: '2026-10-20T09:00:00Z', publications: [{ publication_id: 'pub1', external_id: 'ig-1', capability_id: 'c1', url: 'https://example.invalid/post/1', published_at: '2026-10-20T09:01:00Z' }] }];
const materialDetail = { material: editor.suggested, used_in: used };
const emptyOverview = { ...studio.overview, slots: [], today: { slots: [], approvals: [], blockers: [], budget_moves: [], paid_alerts: [] } };
const denied = { ...m.repMe, memberships: m.repMe.memberships.map(x => ({ ...x, permissions: ['workspace.read'] })) };
const materialUrl = '/studio?tab=materials&view=olays&material=m1';
const eventUrl = '/studio?tab=materials&view=olays&olay=o1';
const eventData = { ...olays.answers, 'GET /api/studio/olays/o1': { olay: olays.confirmed, materials: [materialDetail], shoots: [m.shoot('r1')], shoot_requests: [m.shoot('r1')] } };
const checks = {
  visible: (selector) => async p => p.locator(selector).first().waitFor(),
  click: (name) => async p => { const button=p.getByRole('button', { name, exact: true }).first(); await button.evaluate(el=>{ window.__reviewOpener=el; }); await button.click(); },
  tab: (name) => async p => p.getByRole('tab', { name, exact: true }).click(),
};
const scenarios = [];
function add(name, url, data = {}, options = {}) { scenarios.push({ name, url, data, ...options }); }
add('studio-loaded', '/studio', {}, { ready: checks.visible('[data-testid="today-s1"]') });
add('studio-empty', '/studio', { 'GET /api/studio/overview': emptyOverview }, { ready: async p => p.getByText(tr.studio.emptyToday, { exact: true }).waitFor() });
add('studio-calendar', '/studio', {}, { action: checks.click(tr.studio.calendar) });
add('studio-filter', '/studio', {}, { action: async p => p.getByLabel(tr.studio.filters.hypothesis).selectOption('h1') });
add('studio-proposal', '/studio', {}, { action: checks.click(tr.studio.proposal) });
add('studio-policy', '/studio', {}, { action: async p => p.getByText(tr.studio.policy, { exact: true }).click() });
add('studio-learning-forms', '/studio', {}, { action: async p => { await p.getByText(tr.studio.trend, { exact: true }).click(); await p.locator('summary').filter({ hasText: tr.studio.judgment }).click(); } });
add('studio-slot-editor', '/studio', {}, { action: async p => { await p.getByTestId('today-s1').getByRole('button', { name: 'Kısa hikâyeler', exact: true }).click(); await p.getByTestId('slot-detail').waitFor(); } });
add('studio-permission', '/studio', { 'GET /api/auth/me': denied }, { ready: async p => p.getByRole('alert').first().waitFor() });
const captionFindings = [{ kind: 'caption', code: 'place_not_in_material', matched: 'Kadıköy' }];
add('studio-hard-material-hold', '/studio', { ...hold.base, 'GET /api/studio/overview': hold.overview([{ kind: 'hard', code: 'no_eligible_material', material_id: 'm1' }], 'fix_piece', [m.shoot('r1')]) });
add('studio-caption-release-dialog', '/studio', { ...hold.base, 'GET /api/studio/overview': hold.overview(captionFindings), 'GET /api/studio/slots/s1': hold.detail({ digest: 'review-fixture', findings: captionFindings, hard: [], released: false }) }, { action: checks.click(tr.materials.hold.release), dialog: true });
add('tiktok-direct', '/studio', tiktok.answers(), { ready: async p => p.getByRole('form', { name: tr.studio.tiktok.screen }).waitFor() });
add('tiktok-draft', '/studio', tiktok.answers(), { action: async p => p.getByLabel(tr.studio.tiktok.modeDraft, { exact: true }).check() });
add('tiktok-disclosure', '/studio', tiktok.answers(), { action: async p => { const form = p.getByRole('form', { name: tr.studio.tiktok.screen }); await form.getByRole('checkbox').filter({ has: p.locator('input') }).count(); await form.locator('input[type=checkbox]').last().check(); } });
add('tiktok-unavailable', '/studio', tiktok.answers(true, { 'GET /api/studio/slots/s1/tiktok': tiktok.screenAnswer({ creator: { ...tiktok.creator, cannot_post: 'spam_risk_too_many_posts' } }) }));
add('tiktok-no-draft-permission', '/studio', tiktok.answers(true, { 'GET /api/studio/slots/s1/tiktok': tiktok.screenAnswer({ drafts_available: false }) }));
add('tiktok-scheduled', '/studio', tiktok.approvedIn(86400000));
add('materials-upload', '/studio?tab=materials&view=upload');
add('materials-upload-selected', '/studio?tab=materials&view=upload', { 'POST /api/studio/files': { id: 'review-file', mime: 'image/jpeg', filename: 'review.jpg' } }, { action: async p => { await p.locator('input[type=file][multiple]').setInputFiles({ name: 'review.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([255,216,255,217]) }); await p.getByText(tr.materials.upload.status.uploaded, { exact: true }).waitFor(); } });
add('materials-upload-rejected', '/studio?tab=materials&view=upload', {}, { action: async p => { await p.locator('input[type=file][multiple]').setInputFiles({ name: 'review.pdf', mimeType: 'application/pdf', buffer: Buffer.from('fixture') }); await p.getByText(tr.materials.upload.status.refused, { exact: true }).waitFor(); } });
add('materials-events', '/studio?tab=materials&view=olays', olays.answers);
add('materials-events-empty', '/studio?tab=materials&view=olays');
add('materials-event-create', '/studio?tab=materials&view=olays', {}, { action: checks.click(tr.materials.olay.new) });
add('materials-event-detail', eventUrl, eventData);
add('materials-event-edit', eventUrl, eventData, { action: checks.click(tr.materials.olay.edit) });
add('materials-general', '/studio?tab=materials&view=olays&olay=genel', { 'GET /api/studio/materials': [m.material('general', { binding: { kind: 'genel' } })] });
add('materials-review', '/studio?tab=materials&view=olays&olay=review', { 'GET /api/studio/materials': [m.material('review', { share: null })] });
add('materials-editor', materialUrl, { ...editor.answers, 'GET /api/studio/materials/m1': materialDetail });
add('materials-editor-permission', materialUrl, { ...editor.answers, 'GET /api/auth/me': m.repMe });
add('materials-editor-deleted', materialUrl, { ...editor.answers, 'GET /api/studio/materials/m1': { material: { ...editor.suggested, erased_at: '2026-11-04T09:00:00Z' }, used_in: used } });
add('materials-delete-dialog', materialUrl, editor.answers, { action: checks.click(tr.materials.editor.delete), dialog: true });
add('materials-calendar', '/studio?tab=materials&view=calendar&year=2027', calendar.answers);
add('materials-calendar-edit', '/studio?tab=materials&view=calendar&year=2027', calendar.answers, { action: async p => p.getByTestId('calendar-ramazan_bayrami').getByRole('button').click() });
add('materials-calendar-add', '/studio?tab=materials&view=calendar&year=2027', calendar.answers, { action: checks.click(tr.materials.calendar.add) });
add('materials-calendar-permission', '/studio?tab=materials&view=calendar&year=2027', { ...calendar.answers, 'GET /api/auth/me': m.repMe });
add('materials-shoots', '/studio?tab=materials&view=shoots', shoots.answers);
add('materials-shoots-empty', '/studio?tab=materials&view=shoots');
add('posts-empty', '/studio?tab=posts&view=plan');
add('posts-populated', '/studio?tab=posts&view=plan', { 'GET /api/studio/post-requests': [posts.postRequest('q1')], 'GET /api/studio/posts': { settings: posts.defaultSettings, posts: [posts.postOut('review-slot', new Date().toISOString())] } });
add('posts-week', '/studio?tab=posts&view=week&week=2026-10-19');
add('posts-week-empty', '/studio?tab=posts&view=week', { 'GET /api/studio/summary': { ...posts.weekSummary, published: [], planned: [], cancelled: [], scores: [] } });
add('posts-settings', '/studio?tab=posts&view=settings');
add('posts-settings-permission', '/studio?tab=posts&view=settings', { 'GET /api/auth/me': m.repMe });
add('strategy-draft', '/strategy');
add('strategy-approved', '/strategy', { 'GET /api/strategy': { approved: f.approvedVersion, draft: null, gaps: [] } });
add('strategy-empty', '/strategy', { 'GET /api/strategy': { approved: null, draft: null, gaps: [] } });
add('strategy-no-approved', '/strategy', { 'GET /api/strategy': { ...f.strategyWithDraft, approved: null } }, { action: checks.tab(tr.strategy.tabs.approved) });
add('strategy-rep', '/strategy', { 'GET /api/auth/me': f.repMe });
add('strategy-versions-drawer', '/strategy', {}, { action: checks.click(tr.strategy.versions), dialog: true });
add('strategy-approval-dialog', '/strategy', {}, { action: checks.click(tr.strategy.approve), dialog: true });
add('strategy-archive-dialog', '/strategy', { 'GET /api/strategy': { approved: f.approvedVersion, draft: null, gaps: [] } }, { action: checks.click(tr.strategy.archive), dialog: true });
for (const [index, section] of ['identity','audience','channels','goals','budget_frame','prohibitions','cadence'].entries()) {
 add('strategy-edit-'+section, '/strategy', {}, { action: async p => p.getByRole('button', { name: tr.common.edit, exact: true }).nth(index).click() });
}
add('strategy-edit-hypotheses', '/strategy', {}, { action: checks.click(tr.strategy.hypotheses.edit) });
// Less frequent operational branches use the same production screen, with explicit fixtures.
const paidOverview = { ...studio.overview, lane_support: { ...studio.overview.lane_support, paid: { visible: true, supported: true } } };
add('studio-paid-controls', '/studio', { 'GET /api/studio/overview': paidOverview }, { action: async p => { await p.locator('summary').filter({ hasText: tr.studio.bind }).click(); await p.locator('summary').filter({ hasText: tr.studio.budgetMove }).click(); } });
add('studio-ledger-populated', '/studio', { 'GET /api/studio/ledger': { entries: [{ id: 1, entry: { at: '2026-10-28T10:00:00Z', actor: { kind: 'human', user_id: 'owner-1' }, action: 'piece.approved', subject: { id: 's1' }, strategy_version_id: 'v1', payload: { review: 'Approved for scheduled publication' } } }], next_before: null } }, { action: async p => p.getByRole('region', { name: tr.studio.ledger }).locator('summary').click() });
add('tiktok-photos', '/studio', tiktok.answers(true, { 'GET /api/studio/slots/s1/tiktok': tiktok.screenAnswer({ media: { kind: 'photos' }, max_title_units: 4000, previews: [] }) }), { ready: async p => p.getByRole('form', { name: tr.studio.tiktok.screen }).waitFor() });
add('tiktok-sending', '/studio', tiktok.approvedIn(-60000));
add('tiktok-processing', '/studio', tiktok.answers(false, { 'GET /api/studio/slots/s1': tiktok.detail([{ state: 'unknown', outcome: { status: 'observed', evidence: { external_id: 'v_pub_1', url: null } } }]) }));

// Distinct history and publication outcomes, including actual fixture paging/download interaction.
const ledgerRow = (id, action) => ({ id, entry: { at: '2026-10-28T10:00:00Z', actor: { kind: 'human', user_id: 'owner-1' }, action, subject: { id: 's1' }, strategy_version_id: 'v1', payload: {} } });
add('supplement-consultation-paging', '/strategy', {
 [`GET /api/strategy/versions/${f.DRAFT_ID}/consultation`]: u => u.searchParams.has('before_id') ? [{ ...f.consultation[0], id:'older-review-entry', text:'Earlier consultation decision' }] : Array.from({length:50},(_,i)=>({...f.consultation[0],id:'review-entry-'+i,text:'Consultation note '+(i+1)})),
}, { action: async p => { await p.getByRole('button',{name:tr.strategy.consultation.loadMore,exact:true}).click(); await p.getByText('Earlier consultation decision',{exact:true}).waitFor(); assert.equal(await p.getByRole('button',{name:tr.strategy.consultation.loadMore,exact:true}).count(),0); } });
add('supplement-ledger-paging', '/studio', { 'GET /api/studio/ledger': u => u.searchParams.has('before') ? {entries:[ledgerRow(1,'Earlier reviewed action')],next_before:null} : {entries:[ledgerRow(2,'Latest reviewed action')],next_before:2} }, { action:async p=>{ await p.getByRole('region',{name:tr.studio.ledger}).getByRole('button',{name:tr.studio.more,exact:true}).click();await p.getByText('Earlier reviewed action',{exact:true}).waitFor(); } });
add('supplement-ledger-export','/studio',{'POST /api/studio/ledger/export':{filename:'studio-review.csv',media_type:'text/csv',content:'action\npiece.approved\n'}},{action:async p=>{const next=p.waitForEvent('download');await p.getByRole('region',{name:tr.studio.ledger}).getByRole('button',{name:tr.studio.export,exact:true}).click();const download=await next;assert.equal(download.suggestedFilename(),'studio-review.csv');const stream=await download.createReadStream();let content='';for await(const chunk of stream)content+=chunk.toString();assert.equal(content,'action\npiece.approved\n');}});
const failureOverview = { ...studio.overview, today:{...studio.overview.today,approvals:[],blockers:[{target:{slot:'s1'},reason:'publish_permanent',next_action:'review_publication_duplicate_risk'}]} };
const failedData = {'GET /api/studio/overview':failureOverview,'GET /api/studio/slots/s1':{...studio.answers['GET /api/studio/slots/s1'],attempts:[{state:'failed',failure_reason:'permanent: x: HTTP 402 CreditsDepleted: no credits'}]}};
add('supplement-today-failed-card','/studio',failedData,{ready:async p=>p.getByTestId('today-s1').getByLabel(tr.studio.reason).waitFor()});
add('supplement-today-failed-editor','/studio',failedData,{action:async p=>{await p.getByTestId('today-s1').getByRole('button',{name:'Kısa hikâyeler',exact:true}).click();await p.getByTestId('slot-detail').getByRole('status').waitFor();assert.equal(await p.getByTestId('slot-detail').locator('textarea').count(),0);}});
add('supplement-today-unknown','/studio',{'GET /api/studio/overview':{...failureOverview,today:{...failureOverview.today,blockers:[{target:{slot:'s1'},reason:'publish_unknown',next_action:'review_publication_duplicate_risk'}]}}},{ready:checks.visible('[data-testid="today-s1"]')});
add('supplement-today-missing-preview','/studio',{'GET /api/studio/slots/s1':{...studio.answers['GET /api/studio/slots/s1'],piece:null}},{ready:async p=>p.getByText(tr.studio.noDraft,{exact:true}).waitFor()});
const tkBase=tiktok.answers(false)['GET /api/studio/overview'];
add('supplement-tiktok-failed','/studio',tiktok.answers(false,{'GET /api/studio/overview':{...tkBase,today:{...tkBase.today,blockers:[{target:{slot:'s1'},reason:'publish_permanent',next_action:'review_publication_duplicate_risk'}]}},'GET /api/studio/slots/s1':tiktok.detail([{state:'failed',failure_reason:'permanent: tiktok: HTTP 403 unaudited_client_can_only_post_to_private_accounts'}])}),{ready:async p=>p.getByText(/^Paylaşım durumu: yayınlanamadı/).waitFor()});
const publishedSlot={...tiktok.slot,scheduled_at:new Date().toISOString(),state:'published',revision:4};
const publishedData=tiktok.answers(false,{'GET /api/studio/overview':{...tkBase,slots:[publishedSlot],today:{...tkBase.today,slots:[]}},'GET /api/studio/slots/s1':{...tiktok.detail([{state:'succeeded',outcome:{status:'succeeded',evidence:{external_id:'review-published',url:'https://example.invalid/published'}}}]),slot:publishedSlot}});
for(const measured of [true,false])add('supplement-tiktok-published'+(measured?'':'-no-counters'),'/studio',{...publishedData,'GET /api/studio/slots/s1/tiktok/metrics':{post:{external_id:'review-published',url:'https://example.invalid/published'},metrics:measured?{view_count:42,like_count:3,comment_count:1,share_count:0}:null,source:'live',read_at:'2026-10-28T10:00:00Z'}},{action:async p=>{await p.getByRole('region',{name:tr.studio.plan}).getByTestId('slot-s1').getByRole('button').click();await p.getByTestId('slot-detail').waitFor();if(measured)await p.getByRole('list',{name:'Paylaşımın TikTok sayaçları'}).waitFor();else await p.getByText(tr.studio.tiktok.noCounters,{exact:true}).waitFor();}});

// Each top-level read family gets both a delayed loading frame and a recoverable error frame.
for (const [name,url,endpoint,data] of [
 ['studio','/studio','/api/studio/overview',{}],
 ['tiktok','/studio','/api/studio/slots/s1/tiktok',tiktok.answers()],
 ['material',materialUrl,'/api/studio/materials/m1',editor.answers],
 ['events','/studio?tab=materials&view=olays','/api/studio/olays',olays.answers],
 ['calendar','/studio?tab=materials&view=calendar&year=2027','/api/studio/calendar',calendar.answers],
 ['shoots','/studio?tab=materials&view=shoots','/api/studio/shoot-requests',shoots.answers],
 ['posts','/studio?tab=posts&view=plan','/api/studio/posts',{}],
 ['posts-week','/studio?tab=posts&view=week','/api/studio/summary',{}],
 ['posts-settings','/studio?tab=posts&view=settings','/api/studio/posts',{}],
 ['strategy','/strategy','/api/strategy',{}],
]) {
 add(name+'-loading',url,data,{ delayed: endpoint, ready: async p=>p.getByText(name==='tiktok' ? tr.studio.tiktok.loading : name==='strategy' ? tr.kit.loading : tr.common.loading, {exact:true}).first().waitFor() });
 add(name+'-error-retry',url,data,{ failed:endpoint, ready: async p=>p.getByRole('button',{name:tr.common.retry,exact:true}).first().waitFor(), retry:true });
}
(async()=>{
 fs.mkdirSync(out,{recursive:true});
 const browser=await chromium.launch({args:['--no-sandbox']}); const results=process.env.JEETA_REVIEW_RESUME && fs.existsSync(path.join(out,'results.json')) ? JSON.parse(fs.readFileSync(path.join(out,'results.json'),'utf8')).results : [];
 const save=()=>fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({baseUrl,at:new Date().toISOString(),results},null,2)+'\n');
 try {
  for (const scenario of scenarios.filter(s=>!process.env.JEETA_REVIEW_FILTER||s.name.includes(process.env.JEETA_REVIEW_FILTER))) {
   for (const width of [1440,390]) {
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
