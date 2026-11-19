import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentWakeOut, KeySummary, WakesOut } from '@/api/types';
import { agents, keys, me } from '@/test/fixtures';
import { mockFetch, renderAt, withStatus } from '@/test/render';
import { wakeTime } from '@/lib/wake';

// The agents page's wake address, one compact line on each live key's row: set it up, change
// it, remove it; a member without `team.manage` reads it and nothing more.

const KEY = keys[0].id;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const seen = at(-20 * 60_000);
const next = at(40 * 60_000);
const connected = [{ ...agents[0], last_seen_at: seen }];

const agent = (over: Partial<AgentWakeOut> = {}): AgentWakeOut => ({
  api_key_id: KEY, address: null, pending: null, last: null, last_seen_at: seen,
  interval_minutes: 60, interval_learned: true, next_expected_at: next, run_now: null, ...over,
});
const wakes = (...list: AgentWakeOut[]): WakesOut => ({
  agents: list,
  needs: { content: { state: 'no_agent' }, materials: { state: 'no_agent' }, social: { state: 'no_agent' }, ads: { state: 'no_agent' }, research: { state: 'no_agent' }, inbox: { state: 'no_agent' } },
});
const routine = (over: Partial<NonNullable<AgentWakeOut['address']>> = {}): AgentWakeOut['address'] => ({
  kind: 'claude_routine', target: 'trig_01ABC', has_secret: true, set_at: at(-3_600_000), set_by: me.user_id, refused_at: null, ...over,
});
const rowOf = async (name: string) => (await screen.findByRole('heading', { level: 3, name })).closest('li') as HTMLElement;
const member = { ...me, memberships: [{ ...me.memberships[0], permissions: me.memberships[0].permissions.filter((p) => p !== 'team.manage') }] };

describe('the wake address on the agents page', () => {
  it('sets a Claude routine from its trigger URL and its token, and forgets the token', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      'GET /api/auth/me': me, 'GET /api/agents': connected, 'GET /api/api-keys': keys,
      'GET /api/agents/wakes': wakes(agent()),
      [`PUT /api/agents/${KEY}/wake`]: wakes(agent({ address: routine(), run_now: { api_key_id: KEY, after: null } })),
    });
    renderAt('/agents');
    const row = await rowOf('Gece işleri');
    expect(await within(row).findByText(/^Çağrı adresi: yok$/)).toBeInTheDocument();
    expect(within(row).getByText(`Saat başı uğruyor · sıradaki ${wakeTime(next, 'tr')}`)).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Ekle' }));
    expect(within(row).getByText(/^Biri bu ajana iş verdiğinde Jeeta onu saatini beklemeden hemen çağırır\. Belirteci claude\.ai\/code\/routines'ta rutini açıp «Add another trigger» → API → «Generate token» ile alırsınız; yalnızca bir kez gösterilir\.$/)).toBeInTheDocument();
    const id = within(row).getByLabelText('Rutin kimliği');
    expect(id).toHaveAttribute('placeholder', 'trig_… ya da tetikleyici adresi');
    const token = within(row).getByLabelText('Belirteç');
    expect(token).toHaveAttribute('type', 'password');
    expect(token).toHaveAttribute('autocomplete', 'off');
    await user.type(id, 'https://api.anthropic.com/v1/claude_code/routines/trig_01ABC/fire');
    await user.type(token, 'sk-ant-oat01-secret');
    await user.click(within(row).getByRole('button', { name: 'Kaydet' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({ path: `/api/agents/${KEY}/wake`, body: { kind: 'claude_routine', routine_id: 'trig_01ABC', token: 'sk-ant-oat01-secret' } });
    expect(await within(row).findByText('Çağrı adresi: Claude rutini · trig_01ABC')).toBeInTheDocument();
    // The token is nowhere on the page, and changing the address starts from an empty one.
    expect(screen.queryByDisplayValue('sk-ant-oat01-secret')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('sk-ant-oat01-secret');
    await user.click(within(row).getByRole('button', { name: 'Değiştir' }));
    expect(within(row).getByLabelText('Belirteç')).toHaveValue('');
  });

  it('shows the field the server refused under that field', async () => {
    const user = userEvent.setup();
    mockFetch({
      'GET /api/auth/me': me, 'GET /api/agents': connected, 'GET /api/api-keys': keys,
      'GET /api/agents/wakes': wakes(agent()),
      [`PUT /api/agents/${KEY}/wake`]: withStatus(422, { code: 'VALIDATION', message: 'not a public https url', details: { field: 'url' } }),
    });
    renderAt('/agents');
    const row = await rowOf('Gece işleri');
    await user.click(await within(row).findByRole('button', { name: 'Ekle' }));
    await user.click(within(row).getByRole('button', { name: 'Webhook' }));
    expect(within(row).getByText('Biri bu ajana iş verdiğinde Jeeta bu adrese kısa bir POST gönderir (iş alanı, ajan ve neden; içerik yok). Adres herkese açık bir https adresi olmalı.')).toBeInTheDocument();
    expect(within(row).getByLabelText('Gizli anahtar (isteğe bağlı)')).toHaveAttribute('type', 'password');
    await user.type(within(row).getByLabelText('Adres'), 'https://10.0.0.5/wake');
    await user.click(within(row).getByRole('button', { name: 'Kaydet' }));
    const error = await within(row).findByRole('alert');
    expect(error).toHaveTextContent('Herkese açık bir https adresi girin (kullanıcı adı ve parola olmadan).');
    expect(within(row).getByLabelText('Adres')).toHaveAttribute('aria-describedby', error.id);
  });

  it('says the last call and its session, and removes the address after asking', async () => {
    const user = userEvent.setup();
    const last = at(-5 * 60_000);
    const calls = mockFetch({
      'GET /api/auth/me': me, 'GET /api/agents': connected, 'GET /api/api-keys': keys,
      'GET /api/agents/wakes': wakes(agent({ address: routine(), last: { at: last, reasons: ['content_revision'], outcome: 'fired', status: 200, session_id: 's1', session_url: 'https://claude.ai/code/session_1' } })),
      [`DELETE /api/agents/${KEY}/wake`]: wakes(agent()),
    });
    renderAt('/agents');
    const row = await rowOf('Gece işleri');
    expect(await within(row).findByText(`Çağrı adresi: Claude rutini · trig_01ABC · son çağrı ${wakeTime(last, 'tr')}: başarılı ·`, { exact: false })).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'oturumu aç' })).toHaveAttribute('href', 'https://claude.ai/code/session_1');
    expect(within(row).getByRole('button', { name: 'Değiştir' })).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Kaldır' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Çağrı adresi kaldırılsın mı?')).toBeInTheDocument();
    expect(within(dialog).getByText('Ajan yeniden yalnızca kendi saatinde uğrar.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Kaldır' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === `/api/agents/${KEY}/wake`)).toBe(true));
    expect(await within(row).findByText(/^Çağrı adresi: yok$/)).toBeInTheDocument();
  });

  it('says a refused address must be connected again with a new token', async () => {
    const refused = at(-60_000);
    mockFetch({
      'GET /api/auth/me': me, 'GET /api/agents': connected, 'GET /api/api-keys': keys,
      'GET /api/agents/wakes': wakes(agent({ address: routine({ refused_at: refused }), last: { at: refused, reasons: [], outcome: 'refused', status: 401, session_id: null, session_url: null } })),
    });
    renderAt('/agents');
    const row = await rowOf('Gece işleri');
    expect(await within(row).findByText(`Çağrı adresi reddedildi (${wakeTime(refused, 'tr')}); yeni bir belirteçle yeniden bağlayın.`)).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Değiştir' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Kaldır' })).not.toBeInTheDocument();
  });

  it('shows a member without team.manage the address but no form and no buttons', async () => {
    const other: KeySummary = { ...keys[0], id: '0190a000-0000-7000-8000-000000000022', name: 'Sosyal ajan', prefix: 'jt_ef56' };
    mockFetch({
      'GET /api/auth/me': member, 'GET /api/agents': connected, 'GET /api/api-keys': [...keys, other],
      'GET /api/agents/wakes': wakes(agent({ address: routine() }), agent({ api_key_id: other.id, last_seen_at: null, next_expected_at: null })),
    });
    renderAt('/agents');
    const row = await rowOf('Gece işleri');
    expect(await within(row).findByText('Çağrı adresi: Claude rutini · trig_01ABC')).toBeInTheDocument();
    const quiet = await rowOf('Sosyal ajan');
    expect(within(quiet).getByText(/^Çağrı adresi: yok$/)).toBeInTheDocument();
    // An agent that never came has no schedule to tell.
    expect(within(quiet).queryByText(/uğruyor/)).not.toBeInTheDocument();
    for (const name of ['Ekle', 'Değiştir', 'Kaldır']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  });
});
