// Browser-only fixture review. Every /api/* response is mocked; no credentials or providers.
// Run from any directory: JEETA_REVIEW_URL=http://localhost:5180 node foundation.cjs
const { chromium } = require('../../../frontend/node_modules/playwright');
const { expect } = require('../../../frontend/node_modules/@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('../node_modules/typescript');
const base = process.env.JEETA_REVIEW_URL || 'http://localhost:5180';
const output = process.env.JEETA_REVIEW_OUTPUT || '/tmp/jeeta-foundation-review';
fs.mkdirSync(output, { recursive: true });
function fixture(name) {
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../src/test', name + '.ts'), 'utf8');
  new Function('exports', 'require', 'module', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(module.exports, require, module);
  return module.exports;
}
const f = fixture('fixtures');
const b = fixture('billing');
const tr = require('../src/i18n/tr.json');
const en = require('../src/i18n/en.json');
const clone = value => structuredClone(value);
const error = (status, code, message = 'Synthetic review error') => ({ status, data: { code, message, details: {} } });
const activeMe = clone(f.me);
activeMe.memberships[0].workspace_status = 'active';
const activeWorkspace = { ...f.workspace, status: 'active' };
const activeBilling = { ...b.billing, workspace_status: 'active', entitlement: { ...b.entitlement, source: 'grandfathered', payment_id: null, activated_at: '2026-11-05T08:00:00Z' } };
const approved = { ...f.pendingOverdue, strategy: { approved: { version_id: f.APPROVED_ID, number: 1 } }, items: [], agent: { last_seen_at: '2026-11-05T08:00:00Z', interval_minutes: 1440, overdue: false } };
const defaults = () => ({
  'GET /api/auth/me': activeMe, 'GET /api/workspace': activeWorkspace,
  'GET /api/work/pending': approved, 'GET /api/billing': activeBilling,
  'GET /api/strategy': { approved: f.approvedVersion, draft: null, gaps: [] },
  'GET /api/capabilities': f.capabilities, 'GET /api/team': f.members,
  'GET /api/api-keys': f.keys, 'POST /api/auth/logout': null,
});
const cases = [];
const axeEnabled = process.env.JEETA_REVIEW_AXE === '1';
function add(name, url, overrides = {}, act) { cases.push({ name, url, overrides, act }); }
function authInputs(kind) {
  return async page => {
    if (kind === 'register' || kind === 'invite') await page.locator('input[autocomplete=name]').fill('Demo Kullanıcı');
    if (kind === 'register') await page.locator('input[autocomplete=organization]').fill('Demo Atölye');
    if (kind !== 'invite') await page.locator('input[type=email]').fill('demo@example.invalid');
    await page.locator('input[autocomplete$=password]').fill('Synthetic passphrase');
  };
}
async function submit(page) { await page.locator('form button[type=submit]').click(); }
async function checkPassword(page, t) {
  const input = page.locator('input[autocomplete$=password]');
  await input.fill('Synthetic passphrase');
  await page.getByRole('button', { name: t.kit.showPassword, exact: true }).click();
  await expect(input).toHaveAttribute('type', 'text');
  await expect(page.getByRole('button', { name: t.kit.hidePassword, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: t.kit.hidePassword, exact: true }).click();
  await expect(input).toHaveAttribute('type', 'password');
}
for (const kind of ['login', 'register']) {
  const endpoint = `POST /api/auth/${kind}`;
  add(`${kind}-default-invalid-password`, `/${kind}`, {}, async (p, ctx) => {
    await checkPassword(p, ctx.t);
    await submit(p);
    await expect(p.locator('form')).toBeVisible();
    await p.locator('input[type=email]').fill('invalid-email'); await submit(p);
    if (ctx.calls.some(c => c.key === endpoint)) throw Error('Native-invalid form sent mutation');
    if (kind === 'register') {
      await authInputs(kind)(p);
      await p.locator('input[autocomplete$=password]').fill('short');
      await submit(p);
      if (ctx.calls.some(c => c.key === endpoint)) throw Error('Short password sent mutation');
    }
  });
  add(`${kind}-pending`, `/${kind}`, { [endpoint]: { wait: true, data: activeMe } }, async (p, ctx) => {
    await authInputs(kind)(p); await submit(p);
    await expect(p.locator('form button[type=submit]')).toBeDisabled();
    await ctx.capture('pending');
  });
  for (const [label, status, code] of [['401',401,'UNAUTHENTICATED'],['server-error',500,'INTERNAL'], ...(kind === 'register' ? [['conflict',409,'CONFLICT']] : [])]) {
    add(`${kind}-${label}-retry-success`, `/${kind}`, { [endpoint]: error(status,code) }, async (p, ctx) => {
      await authInputs(kind)(p); await submit(p);
      await expect(p.getByRole('alert').first()).toBeVisible();
      await ctx.capture('error'); ctx.answers[endpoint] = activeMe;
      await submit(p); await p.waitForURL(base + '/');
      await expect(p.getByRole('heading', { name: f.workspace.name, exact: true })).toBeVisible();
    });
  }
}
const invitePath = '/invite/synthetic-local-token';
const inviteEndpoint = 'POST /api/team/invites/accept';
const visitor = { 'GET /api/auth/me': error(401,'UNAUTHENTICATED') };
add('invite-new-native-invalid-password', invitePath, visitor, async (p,ctx) => {
  await checkPassword(p,ctx.t); await submit(p);
  await p.locator('input[autocomplete=name]').fill('Demo Kullanıcı'); await p.locator('input[autocomplete$=password]').fill('short'); await submit(p);
  if (ctx.calls.some(c=>c.key===inviteEndpoint)) throw Error('Invalid invite form sent mutation');
});
for (const signed of [false,true]) {
  const prefix = signed ? 'signed' : 'new';
  const initial = signed ? {} : visitor;
  const doAccept = async (p,t) => { if (!signed) { await authInputs('invite')(p); await submit(p); } else await p.getByRole('button',{name:t.invite.accept,exact:true}).click(); };
  add(`invite-${prefix}-default`,invitePath,initial);
  add(`invite-${prefix}-pending`,invitePath,{...initial,[inviteEndpoint]:{wait:true,data:{workspace_id:f.WS_ID,me:activeMe}}},async(p,ctx)=>{
    await doAccept(p,ctx.t); await expect(signed?p.getByRole('button',{name:new RegExp(ctx.t.invite.accept)}):p.locator('form button[type=submit]')).toBeDisabled();
  });
  for(const [label,status,code] of [['401',401,'UNAUTHENTICATED'],['conflict',409,'CONFLICT'],['forbidden',403,'FORBIDDEN'],['expired',403,'FORBIDDEN'],['missing',404,'NOT_FOUND'],['inactive',403,'WORKSPACE_INACTIVE'],['server-error',500,'INTERNAL']]) {
    add(`invite-${prefix}-${label}-retry-accepted`,invitePath,{...initial,[inviteEndpoint]:error(status,code,label==='expired'?'invite is not valid':'Synthetic review error')},async(p,ctx)=>{
      await doAccept(p,ctx.t); await expect(signed&&code==='CONFLICT'?p.getByText(ctx.t.invite.alreadyMember,{exact:true}):p.getByRole('alert').first()).toBeVisible(); await ctx.capture(label);
      if(!signed && code==='CONFLICT') await expect(p.getByRole('link',{name:ctx.t.invite.loginLink,exact:true}).first()).toHaveAttribute('href','/login');
      ctx.answers[inviteEndpoint]={workspace_id:f.WS_ID,...(!signed?{me:activeMe}:{})};
      ctx.answers['GET /api/auth/me']=activeMe;
      ctx.answers['POST /api/auth/switch-workspace']=activeMe;
      await doAccept(p,ctx.t); await expect(p.getByText(ctx.t.invite.accepted,{exact:true})).toBeVisible();
      await expect(p.getByRole('link',{name:ctx.t.invite.goHome,exact:true})).toHaveAttribute('href','/');
    });
  }
}
add('invite-session-loading',invitePath,{'GET /api/auth/me':{wait:true,data:activeMe}});
add('invite-session-failure-retry',invitePath,{'GET /api/auth/me':error(500,'INTERNAL')},async(p,ctx)=>{
  await expect(p.getByRole('button',{name:ctx.t.common.retry,exact:true}).first()).toBeVisible(); await ctx.capture('error');
  ctx.answers['GET /api/auth/me']=activeMe; await p.getByRole('button',{name:ctx.t.common.retry,exact:true}).first().click();
  await expect(p.getByRole('button',{name:ctx.t.invite.accept,exact:true})).toBeVisible();
});
add('home-strategy-missing-populated','/',{'GET /api/work/pending':f.pendingOverdue});
add('home-strategy-draft','/',{'GET /api/work/pending':{...approved,strategy:{draft_open:{version_id:f.DRAFT_ID,gaps:f.draftGaps}}}});
add('home-submitted-approval-dialog','/',{
 'GET /api/work/pending':{...approved,strategy:{submitted:{version_id:f.DRAFT_ID,submitted_at:f.draftVersion.submitted_at}}},
 'GET /api/strategy':{...f.strategyWithDraft,draft:{...f.draftVersion,gaps:[],hypotheses:f.approvedVersion.hypotheses}},
},async(p,ctx)=>{
 await p.getByRole('button',{name:ctx.t.home.strategy.approve,exact:true}).click();
 const dialog=p.getByRole('dialog'); await expect(dialog).toBeVisible();
 for(let i=0;i<6;i++){await p.keyboard.press('Tab');if(!await p.evaluate(()=>!!document.activeElement?.closest('[role=dialog]')))throw Error('Dialog focus escaped on Tab');}
 await p.keyboard.press('Shift+Tab');if(!await p.evaluate(()=>!!document.activeElement?.closest('[role=dialog]')))throw Error('Dialog focus escaped on Shift+Tab');
 await ctx.capture('dialog');
 await p.keyboard.press('Escape'); await expect(dialog).toBeHidden();
 await expect(p.getByRole('button',{name:ctx.t.home.strategy.approve,exact:true})).toBeFocused();
});
add('home-agent-interval-invalid-saveerror-retry','/',{'PUT /api/work/checkin-interval':error(500,'INTERNAL')},async(p,ctx)=>{
 await p.getByRole('button',{name:ctx.t.home.agent.editInterval,exact:true}).click();
 const input=p.getByLabel(ctx.t.home.agent.intervalLabel,{exact:true});
 await input.fill('1');await expect(p.getByRole('button',{name:ctx.t.common.save,exact:true})).toBeDisabled();await ctx.capture('invalid');
 await input.fill('60');await p.getByRole('button',{name:ctx.t.common.save,exact:true}).click();
 await expect(p.getByRole('alert').first()).toBeVisible();await ctx.capture('save-error');
 ctx.answers['PUT /api/work/checkin-interval']={...approved.agent,interval_minutes:60};
 await p.getByRole('button',{name:ctx.t.common.save,exact:true}).click();await expect(input).toBeHidden();
 await p.getByRole('button',{name:ctx.t.home.agent.editInterval,exact:true}).click();await expect(input).toHaveValue('60');
 await p.getByRole('button',{name:ctx.t.common.cancel,exact:true}).click();await expect(input).toBeHidden();
});
add('home-approved-empty','/');
add('home-agent-never','/',{'GET /api/work/pending':{...approved,agent:{...approved.agent,last_seen_at:null,overdue:true}}});
add('home-restricted-submitted','/',{'GET /api/auth/me':{...f.repMe,memberships:[{...f.repMe.memberships[0],workspace_status:'active'}]},'GET /api/workspace':{...activeWorkspace,my_role:'rep',my_permissions:['workspace.read']},'GET /api/work/pending':{...approved,strategy:{submitted:{version_id:f.DRAFT_ID,submitted_at:f.draftVersion.submitted_at}}}},async(p,ctx)=>{
 await expect(p.getByRole('button',{name:ctx.t.home.strategy.approve,exact:true})).toHaveCount(0);
});
add('home-suspended','/',{'GET /api/workspace':{...activeWorkspace,status:'suspended'},'GET /api/auth/me':{...activeMe,memberships:[{...activeMe.memberships[0],workspace_status:'suspended'}]},'GET /api/work/pending':error(403,'WORKSPACE_INACTIVE')});
add('home-workspace-loading','/',{'GET /api/workspace':{wait:true,data:activeWorkspace}});
add('home-pending-loading','/',{'GET /api/work/pending':{wait:true,data:approved}});
for(const endpoint of ['GET /api/workspace','GET /api/work/pending']) add('home-failure-retry-'+endpoint.split('/').pop(),'/',{[endpoint]:error(500,'INTERNAL')},async(p,ctx)=>{
 await expect(p.getByRole('button',{name:ctx.t.common.retry,exact:true}).first()).toBeVisible(); await ctx.capture('error');
 ctx.answers[endpoint]=defaults()[endpoint]; await p.getByRole('button',{name:ctx.t.common.retry,exact:true}).first().click();
 await expect(p.getByRole('button',{name:ctx.t.common.retry,exact:true})).toHaveCount(0);
});
add('shell-session-loading','/',{'GET /api/auth/me':{wait:true,data:activeMe}});
add('shell-session-error-retry','/',{'GET /api/auth/me':error(500,'INTERNAL')},async(p,ctx)=>{
 await expect(p.getByRole('button',{name:ctx.t.common.retry,exact:true})).toBeVisible();ctx.answers['GET /api/auth/me']=activeMe;
 await p.getByRole('button',{name:ctx.t.common.retry,exact:true}).click();await expect(p.getByRole('heading',{name:f.workspace.name,exact:true})).toBeVisible();
});
add('shell-no-workspace','/',{'GET /api/auth/me':{...activeMe,current_workspace:null,memberships:[]}});
add('shell-choose-workspace','/',{'GET /api/auth/me':{...activeMe,current_workspace:null}});
const second={...activeMe.memberships[0],workspace_id:'0190a000-0000-7000-8000-000000000099',workspace_name:'İkinci Atölye'};
for(const fail of [false,true]) add(`shell-switch-${fail?'error':'success'}`,'/',{'GET /api/auth/me':{...activeMe,memberships:[...activeMe.memberships,second]},'POST /api/auth/switch-workspace':fail?error(500,'INTERNAL'):{...activeMe,current_workspace:second.workspace_id,memberships:[...activeMe.memberships,second]}},async(p,ctx)=>{
 await p.getByRole('combobox',{name:ctx.t.shell.switchWorkspace,exact:true}).click();
 await p.getByRole('option',{name:second.workspace_name,exact:true}).click();
 await expect.poll(()=>ctx.calls.filter(c=>c.key==='POST /api/auth/switch-workspace').length).toBe(1);
 if(!fail) await expect(p.getByRole('combobox',{name:ctx.t.shell.switchWorkspace,exact:true})).toContainText(second.workspace_name);
});
for(const status of ['pending_payment','active','suspended']) add('onboarding-'+status,'/onboarding',{
 'GET /api/workspace':{...activeWorkspace,status},'GET /api/billing':status==='active'?activeBilling:{...b.billing,workspace_status:status},
 'GET /api/auth/me':{...activeMe,memberships:[{...activeMe.memberships[0],workspace_status:status}]},
});
add('onboarding-restricted','/onboarding',{'GET /api/auth/me':f.repMe,'GET /api/workspace':{...activeWorkspace,my_role:'rep',my_permissions:['workspace.read']}});
add('onboarding-loading','/onboarding',{'GET /api/workspace':{wait:true,data:activeWorkspace},'GET /api/billing':{wait:true,data:activeBilling}});
add('onboarding-error-retry','/onboarding',{'GET /api/workspace':error(500,'INTERNAL')},async(p,ctx)=>{
 await expect(p.getByRole('button',{name:ctx.t.common.retry,exact:true}).first()).toBeVisible(); await ctx.capture('error');
 ctx.answers['GET /api/workspace']=activeWorkspace; await p.getByRole('button',{name:ctx.t.common.retry,exact:true}).first().click();
 await expect(p.getByRole('button',{name:ctx.t.common.retry,exact:true})).toHaveCount(0);
});
add('not-found','/synthetic-missing-route');

(async()=>{
 const browser=await chromium.launch({args:['--no-sandbox']});
 const results=[];
 let variants=[...cases.flatMap(c=>[390,1440].map(width=>({...c,width,lang:'tr',dark:false}))),...['login-default-invalid-password','login-server-error-retry-success','invite-new-default','home-approved-empty','home-strategy-missing-populated','onboarding-active','shell-no-workspace','not-found'].flatMap(name=>[390,1440].map(width=>({...cases.find(c=>c.name===name),name:name+'-english-dark',width,lang:'en',dark:true})))];
 if(process.env.JEETA_REVIEW_CASE) variants=variants.filter(v=>new RegExp(process.env.JEETA_REVIEW_CASE).test(v.name));
 try {
  for(const test of variants){
   const context=await browser.newContext({viewport:{width:test.width,height:1000},reducedMotion:'reduce',colorScheme:test.dark?'dark':'light'});
   await context.addInitScript(({lang})=>localStorage.setItem('jeeta-panel-language',lang),{lang:test.lang});
   const page=await context.newPage();page.setDefaultTimeout(8000);
   // A scenario must not be remounted by another contributor's Vite HMR update.
   await page.routeWebSocket('**', socket=>socket.close());
   const answers={...defaults(),...clone(test.overrides)}; const calls=[],errors=[],unexpected=[],releases=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==new URL(base).origin)return route.abort();
    if(!url.pathname.startsWith('/api/'))return route.continue();
    const key=request.method()+' '+url.pathname;calls.push({key});
    let answer=answers[key];
    if(answer===undefined){unexpected.push(key);answer=error(501,'INTERNAL','Unexpected fixture request');}
    if(answer?.wait){await new Promise(resolve=>releases.push(resolve));answer=answer.data;}
    if(page.isClosed())return;
    try{await route.fulfill({status:Number.isInteger(answer?.status)?answer.status:200,contentType:'application/json',body:JSON.stringify(Number.isInteger(answer?.status)?answer.data:answer)});}catch(e){if(!page.isClosed())throw e;}
   });
   const captures=[],axeChecks=[];
   const capture=async suffix=>{
    const file=`${test.name}-${test.width}${suffix?'-'+suffix:''}.png`;await page.screenshot({path:path.join(output,file),fullPage:true});captures.push(file);
    if(await page.evaluate(()=>document.documentElement.scrollHeight>innerHeight+1)){const viewport=file.replace(/\.png$/,'-viewport.png');await page.screenshot({path:path.join(output,viewport)});captures.push(viewport);}
    if(axeEnabled && (!process.env.JEETA_REVIEW_AXE_CASE || new RegExp(process.env.JEETA_REVIEW_AXE_CASE).test(test.name))){
      if(!await page.evaluate(()=>typeof window.axe==='object')) await page.addScriptTag({path:require.resolve('../../../frontend/node_modules/axe-core/axe.min.js')});
      const audit=await page.evaluate(async()=>{const r=await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}});return {violations:r.violations.map(v=>({id:v.id,impact:v.impact,description:v.description,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary,html:n.html}))})),incomplete:r.incomplete.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary,html:n.html}))})),passes:r.passes.length,contrast:r.passes.filter(v=>v.id==='color-contrast').flatMap(v=>v.nodes.flatMap(n=>n.any.filter(check=>check.id==='color-contrast').map(check=>({target:n.target,...check.data}))))};});
      axeChecks.push({capture:file,...audit});
    }
   };
   const result={name:test.name,width:test.width,language:test.lang,dark:test.dark,captures,axe:axeChecks};
   try{
    await page.goto(base+test.url,{waitUntil:'domcontentloaded'});
    await page.locator('main').waitFor();await page.waitForTimeout(350);
    const t=test.lang==='en'?en:tr;
    if(!test.name.includes('loading')&&!test.name.startsWith('shell-')) await expect(page.getByRole('heading',{level:1}).first()).toBeVisible();
    if(test.name.includes('default-invalid-password'))await capture('default');
    if(test.act)await test.act(page,{t,answers,calls,capture});
    await page.waitForTimeout(100);
    await capture('');
    result.overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
    result.brokenImages=await page.locator('img').evaluateAll(images=>images.filter(i=>i.getBoundingClientRect().width&&i.complete&&i.naturalWidth===0).map(i=>i.src));
    if(result.overflow)throw Error('Document horizontal overflow');
    if(result.brokenImages.length)throw Error('Broken visible images');
    if(errors.length)throw Error('Page errors: '+errors.join('; '));
    if(unexpected.length)throw Error('Unexpected API: '+unexpected.join('; '));
    // First tabbable control is the global skip link, which moves focus into main.
    await page.mouse.click(1,1); await page.keyboard.press('Control+Home');
    await page.evaluate(()=>{document.activeElement?.blur();});
    await page.keyboard.press('Tab');
    const skip=page.locator('a[href="#main-content"]');await skip.focus();await expect(skip).toBeFocused();
    result.skipVisible=await skip.evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.left>=0;});
    if(!result.skipVisible)throw Error('Focused skip link not visible');
    await page.keyboard.press('Enter');await expect(page.locator('#main-content')).toBeFocused();
    result.reducedMotion=await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches);
    if(!result.reducedMotion)throw Error('Reduced motion not active');
    result.reducedMotionCss=await page.locator('a,button,input').first().evaluate(el=>getComputedStyle(el).transitionDuration);
    if(result.reducedMotionCss.split(',').some(v=>parseFloat(v)>0.000011))throw Error('Reduced motion CSS not applied');
    if(axeChecks.some(a=>a.violations.length))throw Error('Axe WCAG violations');
    result.ok=true;
   }catch(e){result.ok=false;result.error=e.message;try{await capture('failure');}catch{}}
   result.apiCalls=calls.map(c=>c.key);result.pageErrors=errors;result.unexpectedApi=unexpected;
   results.push(result);for(const release of releases)release();await context.close();
   process.stdout.write(JSON.stringify({name:result.name,width:result.width,ok:result.ok,error:result.error})+'\n');
   fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));
  }
 }finally{await browser.close();}
 const failures=results.filter(r=>!r.ok);console.log(JSON.stringify({cases:results.length,passed:results.length-failures.length,failed:failures.length,output}));
 if(failures.length)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
