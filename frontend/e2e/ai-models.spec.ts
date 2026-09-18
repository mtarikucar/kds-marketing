/** Real API/browser checks. Run only against the dedicated E2E stack. */
import { test, expect } from './support/fixtures';

const LAZY = { timeout: 20_000 };

test('compact media summaries open priced catalogues and preserve a saved choice', async ({ app }) => {
  await app.goto('/settings/ai-models');
  await expect(app.getByRole('heading', { name: 'Yapay zeka ayarları' })).toBeVisible(LAZY);
  await expect(app.getByRole('radiogroup')).toHaveCount(0);
  const trigger = app.getByRole('button', { name: 'Video modeli seç' });
  await trigger.focus();
  await app.keyboard.press('Enter');
  const sheet = app.getByRole('dialog', { name: 'Video modeli' });
  await expect(sheet).toBeVisible();
  const video = sheet.getByRole('radiogroup', { name: 'Video modeli' });
  const priced = video.getByRole('radio', { name: /(?:saniyede|işlem başına) \d+ kredi \(\$[\d.]+(?:\/sn)?\)/ });
  await expect(priced).toHaveCount(await video.getByRole('radio').count());
  const premium = video.getByRole('radio', { name: /^Veo 3\.1 Fast — draft tier saniyede 15 kredi/ });
  await expect(premium).toBeVisible();
  await expect(video.getByRole('radio', { name: /^Short video saniyede 3 kredi/ })).toBeVisible();
  await expect(video.getByRole('radio', { name: /^Wan FLF2V.*işlem başına 40 kredi \(\$0.4\)/ })).toBeAttached();
  await expect(video.getByRole('radio', { name: /^Platform varsayılanı \(/ })).toBeChecked();
  await premium.click();
  await app.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(app.getByRole('radiogroup')).toHaveCount(0);
  const saved = app.waitForResponse(response => response.url().endsWith('/marketing/workspaces/media-models') && response.request().method() === 'PATCH');
  await app.getByRole('button', { name: 'Kaydet', exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(200);
  expect(Object.keys(response.request().postDataJSON())).toEqual(['defaultVideoModel']);
  await app.reload();
  await trigger.click();
  await expect(premium).toBeChecked();
  await app.keyboard.press('Escape');
  await app.getByRole('button', { name: 'Görsel modeli seç' }).click();
  const image = app.getByRole('radiogroup', { name: 'Görsel modeli' });
  await expect(image.getByRole('radio', { name: /^Draft image görsel başına \d+ kredi/ })).toBeVisible();
});

test('the page has a door in the Settings menu', async ({ app }) => {
  await app.goto('/branding');
  const nav = app.getByRole('navigation', { name: 'Ayarlar' });
  await nav.getByRole('link', { name: 'Yapay zeka modelleri' }).click();
  await expect(app).toHaveURL(/\/settings\/ai-models$/);
  await expect(app.getByRole('heading', { name: 'Yapay zeka ayarları' })).toBeVisible(LAZY);
});

test('an owner can filter, inspect, save and reload an action without losing its draft', async ({ app }) => {
  await app.goto('/settings/ai-models');
  const actions = app.getByRole('region', { name: 'Yapay zeka işlemleri', exact: true });
  await expect(actions.getByRole('switch')).toHaveCount(31, LAZY);
  const enabled = actions.getByRole('switch', { name: 'Sosyal içerik metni: etkin', exact: true });
  const provider = actions.getByRole('combobox', { name: 'Sosyal içerik metni: sağlayıcı', exact: true });
  await expect(enabled).toBeChecked();
  await provider.click();
  await app.getByRole('option', { name: /^MCP/ }).click();
  await enabled.click();
  const search = actions.getByRole('searchbox', { name: 'İşlem ara' });
  await search.fill('does-not-exist');
  await expect(actions.getByRole('switch')).toHaveCount(0);
  await search.clear();
  await expect(enabled).not.toBeChecked();
  await expect(provider).toContainText('MCP');
  await actions.getByRole('button', { name: 'Sosyal içerik metni: ayrıntılar' }).click();
  await expect(app.getByRole('dialog', { name: 'Sosyal içerik metni', exact: true })).toBeVisible();
  await expect(app.getByText('Kredi tarifesi', { exact: true })).toBeVisible();
  await app.keyboard.press('Escape');
  const saved = app.waitForResponse(response => response.url().endsWith('/marketing/ai/execution-policy') && response.request().method() === 'PATCH');
  await actions.getByRole('button', { name: 'İşlemleri kaydet', exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(200);
  const jobs = response.request().postDataJSON().jobs;
  expect(Object.values(jobs)).toEqual([{ enabled: false, provider: 'MCP' }]);
  await app.reload();
  await expect(enabled).not.toBeChecked();
  await expect(provider).toContainText('MCP');
});

test('the overview, media controls and internally scrolling table fit the desktop viewport', async ({ app }) => {
  await app.setViewportSize({ width: 1366, height: 768 });
  const loaded = app.waitForResponse(response => response.url().endsWith('/marketing/ai/usage-dashboard'));
  await app.goto('/settings/ai-models');
  const response = await loaded;
  expect(response.status()).toBe(200);
  const dashboard = await response.json();
  expect(dashboard.currency).toBe('USD');
  const overview = app.getByRole('region', { name: 'Aylık kullanım' });
  await expect(overview.getByText('Kayıtlı API tokenı', { exact: true })).toBeVisible(LAZY);
  await expect(overview).toContainText(dashboard.period.month);
  const actions = app.getByRole('region', { name: 'Yapay zeka işlemleri', exact: true });
  await expect(actions.getByRole('switch')).toHaveCount(31, LAZY);
  const box = await actions.boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(768);
  await expect(app.getByRole('button', { name: 'Video modeli seç' })).toBeInViewport();
  const scroll = app.getByRole('region', { name: 'Kaydırılabilir işlem tablosu' });
  expect(await scroll.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  expect((await scroll.boundingBox())!.height).toBeLessThan(450);
  const heading = app.getByRole('columnheader', { name: 'İşlem / kategori' });
  const before = await heading.boundingBox();
  await scroll.evaluate(node => { node.scrollTop = 300; });
  expect((await heading.boundingBox())!.y).toBeCloseTo(before!.y, 0);
  await overview.getByText('Kullanım nasıl ölçülür?', { exact: true }).click();
  await expect(overview.getByText(/Firecrawl.*Apify/)).toBeVisible();
  await overview.getByText('Kullanım nasıl ölçülür?', { exact: true }).click();
  await actions.getByText('Sağlayıcılar ve ücretler', { exact: true }).click();
  await expect(actions.getByText(/çağrı başına.*barındırma/)).toBeVisible();
});

test('on mobile the table scrolls horizontally and details remain keyboard accessible', async ({ app }) => {
  await app.setViewportSize({ width: 390, height: 844 });
  await app.goto('/settings/ai-models');
  const scroll = app.getByRole('region', { name: 'Kaydırılabilir işlem tablosu' });
  await expect(scroll).toBeVisible(LAZY);
  expect(await scroll.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  const box = await scroll.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(await app.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const details = app.getByRole('button', { name: 'Sosyal içerik metni: ayrıntılar' });
  await details.focus();
  await app.keyboard.press('Enter');
  await expect(app.getByRole('dialog', { name: 'Sosyal içerik metni', exact: true })).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(details).toBeFocused();
  await expect(app.getByRole('dialog')).toHaveCount(0);
  expect(await app.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('analytics failure is explicit while settings stay usable, and refresh recovers', async ({ app }) => {
  let failed = true;
  await app.route('**/marketing/ai/usage-dashboard', route => failed
    ? route.fulfill({ status: 503, json: { message: 'unavailable' } }) : route.continue());
  await app.goto('/settings/ai-models');
  const overview = app.getByRole('region', { name: 'Aylık kullanım' });
  await expect(overview.getByRole('alert')).toContainText('Kullanım verileri alınamadı', LAZY);
  const enabled = app.getByRole('switch', { name: 'Sosyal içerik metni: etkin', exact: true });
  await expect(enabled).toBeEnabled();
  await enabled.click();
  await expect(app.getByRole('button', { name: 'İşlemleri kaydet', exact: true })).toBeEnabled();
  failed = false;
  await overview.getByRole('button', { name: 'Kullanımı yenile' }).click();
  await expect(overview.getByText('Kayıtlı API tokenı', { exact: true })).toBeVisible();
  await expect(enabled).not.toBeChecked();
});
