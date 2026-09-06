import { chromium } from 'playwright-core';
const [,, htmlPath, pdfPath] = process.argv;
const exe = process.env.PW_CHROME || '/home/tarik/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: exe });
const p = await b.newPage();
await p.goto('file://' + htmlPath, { waitUntil: 'networkidle' });
await p.emulateMedia({ media: 'print' });
await p.pdf({ path: pdfPath, format: 'A4', printBackground: true,
  margin: { top: '0', bottom: '0', left: '0', right: '0' } });
await b.close();
console.log('PDF yazıldı: ' + pdfPath);
