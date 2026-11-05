// Read-only browser review. Uses a disposable local account; never submits a form or changes data.
// ADMIN_ACCOUNT is a JSON file with email/password. ADMIN_BASE defaults to the local Vite server.
const { chromium } = require('../../../frontend/node_modules/playwright');
const fs = require('node:fs');
const base = process.env.ADMIN_BASE || 'http://localhost:5180';
const account = process.env.ADMIN_ACCOUNT || '/workspace/kds-runtime/rust-account.json';
const output = process.env.ADMIN_OUTPUT || '/tmp/jeeta-admin-review';
fs.mkdirSync(output, { recursive: true });
const routes = ['/team','/roles','/api-keys','/agents','/budget','/ledger','/billing','/capabilities','/connect'];
const openers = {'/team':['Üye davet et'], '/roles':['Rol oluştur'], '/api-keys':['Anahtar oluştur'], '/budget':['Bütçe kalemi oluştur'], '/capabilities':['Kabiliyet bildir']};
(async () => {
  const browser = await chromium.launch({args:['--no-sandbox']});
  const results=[];const pageErrors=[];
  try {
    const page=await browser.newPage();page.on('pageerror',error=>pageErrors.push(error.message));
    await page.goto(base+'/login');
    const credentials=JSON.parse(fs.readFileSync(account,'utf8'));
    await page.locator('input[type=email]').fill(credentials.email);
    await page.locator('input[type=password]').fill(credentials.password);
    await page.locator('button[type=submit]').click();
    await page.waitForURL(base+'/');
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:900});
      for(const route of routes) {
        if(route==='/api-keys') { await page.goto(base+'/',{waitUntil:'networkidle'}); await page.evaluate(()=>{history.pushState({},'', '/api-keys');dispatchEvent(new PopStateEvent('popstate'));}); await page.getByRole('heading',{level:1}).waitFor(); } else { await page.goto(base+route,{waitUntil:'networkidle'}); }
        await page.screenshot({path:`${output}/${route.slice(1)}-${width}.png`,fullPage:true});
        const record={width,route,overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),dialogs:[]};
        for(const label of openers[route] || []) {
          const button=page.getByRole('button',{name:label,exact:true});
          if(await button.count() && await button.first().isEnabled()) {
            await button.first().click();
            const dialog=page.getByRole('dialog');
            if(await dialog.count()) {
              await dialog.screenshot({path:`${output}/${route.slice(1)}-${width}-dialog.png`});
              record.dialogs.push({opener:label,title:await dialog.getByRole('heading').first().textContent(),overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)});
              await page.keyboard.press('Escape');
            }
          }
        }
        results.push(record);
      }
    }
    const rows=results.flatMap(r=>[{route:r.route,case:'page',width:r.width,outcome:r.overflow?'overflow':'pass'},...r.dialogs.map(d=>({route:r.route,case:`dialog: ${d.opener}`,width:r.width,outcome:d.overflow?'overflow':'pass'}))]);
    if(process.env.ADMIN_RESULTS)fs.writeFileSync(process.env.ADMIN_RESULTS,JSON.stringify({results:rows,pageErrors},null,2));
    console.log(JSON.stringify(results,null,2));if(pageErrors.length||rows.some(r=>r.outcome==='overflow'))process.exitCode=1;
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
