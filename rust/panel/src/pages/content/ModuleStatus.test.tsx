import { expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { contentFetch } from '@/test/content';
import { renderAt } from '@/test/render';
import { legacyModules } from '@/test/modules';
import { agents, budgetItems } from '@/test/fixtures';
import { knowledge } from '@/test/knowledge';

// The content and social pages' status lines became Paylaşımlar' agent line and waits (design
// 2026-11-19 §2.9.4, §2.12 #15; PostsPage.test.tsx). The ads page keeps its lines.
it('explains a missing ad budget in Kurallar and in Bütçe only in ads', async () => {
  contentFetch({ answers: { 'GET /api/budget/items': [], 'GET /api/knowledge': { ...knowledge, rules: { ...knowledge.rules, ad_cap: null } } } });
  renderAt('/ads');
  expect(await screen.findByRole('link', { name: "Kurallar'da reklam bütçesi yok." }, { timeout: 5000 })).toHaveAttribute('href', '/knowledge#kurallar');
  expect(await screen.findByRole('link', { name: "Bütçe’de reklam bütçesi yok; kampanyalar bekler." })).toHaveAttribute('href', '/budget');
});
it('says when the connected ad account may only be read, and nothing when it may create ads', async () => {
  const account = (scopes: string[]) => ({ capability: { id: 'ad-1', kind_key: 'meta_ads', name: 'Hesap', connector_public: { access: { scopes } } }, effective_status: 'verified' });
  const text = 'Bağlı reklam hesabının reklam oluşturma izni yok (ads_management); kampanyalar kurulamaz. Hesabı yeniden bağlayın ve izin ekranında bu izni verin.';
  contentFetch({ answers: { 'GET /api/capabilities': [account(['ads_read'])] } });
  const first = renderAt('/ads');
  expect(await screen.findByRole('link', { name: text }, { timeout: 5000 })).toHaveAttribute('href', '/capabilities');
  first.unmount();
  const calls = contentFetch({ answers: { 'GET /api/capabilities': [account(['ads_read', 'ads_management'])] } });
  const { client } = renderAt('/ads');
  await waitFor(() => expect(calls.some(c => c.path === '/api/capabilities')).toBe(true));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(screen.queryByRole('link', { name: text })).not.toBeInTheDocument();
});
it('renders nothing when all is well, including an unassigned connected agent', async () => {
  const calls = contentFetch({ answers: { 'GET /api/budget/items': budgetItems.map(b => ({ ...b, item: { ...b.item, general: b.item.kind === 'ad_budget' } })) } });
  const { client } = renderAt('/ads');
  await waitFor(() => expect(client.isFetching()).toBe(0));
  await waitFor(() => expect(calls.some(c => c.path === '/api/budget/items')).toBe(true));
  expect(screen.queryByRole('region', { name: 'Modül durumu' })).not.toBeInTheDocument();
});

it('follows the server’s paid rule: Kurallar’s ad budget above zero, whatever the frame says', async () => {
  const general = budgetItems.map(b => ({ ...b, item: { ...b.item, general: b.item.kind === 'ad_budget' } }));
  const withCap = (amount_minor: number) => ({ ...knowledge, rules: { ...knowledge.rules, ad_cap: { amount_minor, period: 'monthly' as const, currency: 'TRY' } } });
  contentFetch({ answers: { 'GET /api/budget/items': general, 'GET /api/knowledge': withCap(0) } });
  const first = renderAt('/ads');
  expect(await screen.findByRole('link', { name: "Kurallar'da reklam bütçesi yok." }, { timeout: 5000 })).toBeVisible();
  first.unmount();
  const calls = contentFetch({ answers: { 'GET /api/budget/items': general, 'GET /api/knowledge': withCap(1_000_000) } });
  const { client } = renderAt('/ads');
  await waitFor(() => expect(client.isFetching()).toBe(0));
  await waitFor(() => expect(calls.some(c => c.path === '/api/knowledge')).toBe(true));
  expect(screen.queryByRole('link', { name: "Kurallar'da reklam bütçesi yok." })).not.toBeInTheDocument();
});
