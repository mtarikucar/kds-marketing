import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { NeedWake, WakesOut } from '@/api/types';
import { me } from '@/test/fixtures';
import { mockFetch, withStatus } from '@/test/render';
import { everyPhrase, routineIdOf, trSuffix, wakeTime, wakeTimeIn } from '@/lib/wake';
import i18n from '@/i18n/config';
import { AgentWakeLine } from './AgentWakeLine';

// The one sentence a page says about the agent that will take its waiting work, as the owner
// reads it, for each state the server answers.

const KEY = '0190a000-0000-7000-8000-000000000020';
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const MIN = 60_000;

const wakes = (content: NeedWake): WakesOut => ({
  agents: [],
  needs: { content, materials: { state: 'no_agent' }, social: { state: 'no_agent' }, ads: { state: 'no_agent' }, research: { state: 'no_agent' }, inbox: { state: 'no_agent' } },
});
const schedule = (over: Partial<Extract<NeedWake, { state: 'schedule' }>> = {}): NeedWake => ({
  state: 'schedule', next_expected_at: at(40 * MIN), interval_minutes: 60, has_address: true, failed_at: null, run_now: { api_key_id: KEY, after: null }, ...over,
});

function show(state: NeedWake, waiting = 2, answers: Record<string, unknown> = {}) {
  const calls = mockFetch({ 'GET /api/agents/wakes': wakes(state), ...answers });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(['session'], me);
  const utils = render(
    <QueryClientProvider client={client}>
      <MemoryRouter><AgentWakeLine need="content" waiting={waiting} /></MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, calls, client };
}
const line = () => screen.findByTestId('agent-wake-line');

describe('AgentWakeLine', () => {
  it('says the agent is at work, in seconds then minutes', async () => {
    show({ state: 'working', api_key_id: KEY, last_seen_at: at(-20_000) });
    expect(await line()).toHaveTextContent(/^Ajan çalışıyor · son uğrama 2\d sn önce$/);
  });

  it('says how long the agent has been at work in minutes past one', async () => {
    show({ state: 'working', api_key_id: KEY, last_seen_at: at(-90_000) });
    expect(await line()).toHaveTextContent('Ajan çalışıyor · son uğrama 1 dk önce');
  });

  it('counts down to the call, then says it is calling', async () => {
    const first = show({ state: 'calling', api_key_id: KEY, due_at: at(40_000), waiting_for: 'settle' });
    expect(await line()).toHaveTextContent(/^Ajan (39|40) sn içinde çağrılacak$/);
    first.unmount();
    show({ state: 'calling', api_key_id: KEY, due_at: at(-1000), waiting_for: 'settle' });
    expect(await line()).toHaveTextContent('Ajan çağrılıyor…');
  });

  it('says when a call held back by the rate limits goes out, and when a failed one is tried again', async () => {
    const due = at(5 * MIN);
    const first = show({ state: 'calling', api_key_id: KEY, due_at: due, waiting_for: 'rate' });
    expect(await line()).toHaveTextContent(`Ajan az önce çağrıldı; yeni çağrı ${wakeTimeIn(due, 'tr', 'loc')} gidecek`);
    first.unmount();
    show({ state: 'calling', api_key_id: KEY, due_at: due, waiting_for: 'retry' });
    expect(await line()).toHaveTextContent(`Ajana ulaşılamadı; ${wakeTimeIn(due, 'tr', 'loc')} yeniden denenecek`);
  });

  it('says the agent was called and takes a minute or two', async () => {
    const called = at(-30_000);
    show({ state: 'called', api_key_id: KEY, at: called });
    expect(await line()).toHaveTextContent(`Ajan çağrıldı (${wakeTime(called, 'tr')}); çalışmaya başlaması bir iki dakika sürer`);
  });

  it('gives the schedule and "Şimdi çalıştır" when the agent can be woken', async () => {
    const next = at(40 * MIN);
    show(schedule({ next_expected_at: next }));
    const shown = await line();
    expect(shown).toHaveTextContent(`Ajan saat başı uğruyor; sıradaki ${wakeTime(next, 'tr')}. Hemen başlasın istersen: Şimdi çalıştır`);
    expect(within(shown).getByRole('button', { name: 'Şimdi çalıştır' })).toBeEnabled();
  });

  it('keeps "Şimdi çalıştır" off until the rate limits allow it, and says from when', async () => {
    const after = at(4 * MIN);
    show(schedule({ run_now: { api_key_id: KEY, after } }));
    const shown = await line();
    expect(within(shown).getByRole('button', { name: 'Şimdi çalıştır' })).toBeDisabled();
    expect(shown).toHaveTextContent(`${wakeTimeIn(after, 'tr', 'abl')} sonra çalıştırabilirsin.`);
  });

  it('says nothing of running now without the permission to', async () => {
    show(schedule({ run_now: null }));
    const shown = await line();
    expect(shown).toHaveTextContent(/^Ajan saat başı uğruyor; sıradaki [^.]+\.$/);
    expect(within(shown).queryByRole('button')).not.toBeInTheDocument();
  });

  it('points to the agents page when no agent has a wake address', async () => {
    const next = at(2 * 60 * MIN);
    show(schedule({ has_address: false, run_now: null, interval_minutes: 180, next_expected_at: next }));
    const shown = await line();
    expect(shown).toHaveTextContent(`Ajan 3 saatte bir uğruyor; sıradaki ${wakeTime(next, 'tr')}. Hemen başlaması için ajanlar sayfasından bir çağrı adresi ekle.`);
    expect(within(shown).getByRole('link', { name: 'ajanlar sayfasından' })).toHaveAttribute('href', '/agents');
  });

  it('says the last call failed, then the schedule, with "Şimdi çalıştır"', async () => {
    const failed = at(-10 * MIN);
    const next = at(20 * MIN);
    show(schedule({ failed_at: failed, next_expected_at: next }));
    const shown = await line();
    expect(shown).toHaveTextContent(`Son çağrı (${wakeTime(failed, 'tr')}) ajana ulaşmadı. Ajan saat başı uğruyor; sıradaki ${wakeTime(next, 'tr')}. Şimdi çalıştır`);
    expect(within(shown).getByRole('button', { name: 'Şimdi çalıştır' })).toBeEnabled();
  });

  it('says a late agent is late, and an agent never seen has not come', async () => {
    const expected = at(-15 * MIN);
    const first = show(schedule({ next_expected_at: expected, run_now: null, interval_minutes: 30 }));
    expect(await line()).toHaveTextContent(`Ajan 30 dakikada bir uğruyor; ${wakeTimeIn(expected, 'tr', 'loc')} bekleniyordu, gecikti.`);
    first.unmount();
    show(schedule({ next_expected_at: null, has_address: false, run_now: null }));
    expect(await line()).toHaveTextContent('Ajan henüz uğramadı. Hemen başlaması için ajanlar sayfasından bir çağrı adresi ekle.');
  });

  it('says a refused address must be connected again', async () => {
    show({ state: 'refused', api_key_id: KEY });
    const shown = await line();
    expect(shown).toHaveTextContent('Ajanın çağrı adresi reddedildi; ajanlar sayfasından yeniden bağla.');
    expect(within(shown).getByRole('link', { name: 'ajanlar sayfasından' })).toHaveAttribute('href', '/agents');
  });

  it('says nothing while nothing waits, or when no agent may take the work', async () => {
    const first = show(schedule(), 0);
    await waitFor(() => expect(first.calls.some((c) => c.path === '/api/agents/wakes')).toBe(true));
    await waitFor(() => expect(first.client.isFetching()).toBe(0));
    expect(screen.queryByTestId('agent-wake-line')).not.toBeInTheDocument();
    first.unmount();
    const second = show({ state: 'no_agent' });
    await waitFor(() => expect(second.client.isFetching()).toBe(0));
    expect(screen.queryByTestId('agent-wake-line')).not.toBeInTheDocument();
  });

  it('"Şimdi çalıştır" wakes the agent and the line follows without a reload', async () => {
    const user = userEvent.setup();
    const { calls } = show(schedule(), 2, {
      [`POST /api/agents/${KEY}/wake/run`]: wakes({ state: 'calling', api_key_id: KEY, due_at: at(0), waiting_for: 'settle' }),
    });
    await user.click(within(await line()).getByRole('button', { name: 'Şimdi çalıştır' }));
    await waitFor(() => expect(screen.getByTestId('agent-wake-line')).toHaveTextContent('Ajan çağrılıyor…'));
    expect(calls.filter((c) => c.method === 'POST' && c.path === `/api/agents/${KEY}/wake/run`)).toHaveLength(1);
    // The answer is the read: the page did not read the states again.
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/agents/wakes')).toHaveLength(1);
  });

  it('says from when the agent may be woken again when it was just called', async () => {
    const user = userEvent.setup();
    const retry = at(3 * MIN);
    show(schedule(), 2, {
      [`POST /api/agents/${KEY}/wake/run`]: withStatus(409, { code: 'CONFLICT', message: 'the agent was woken a moment ago', details: { reason: 'rate_limited', retry_at: retry } }),
    });
    await user.click(within(await line()).getByRole('button', { name: 'Şimdi çalıştır' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(`Ajan az önce çağrıldı; ${wakeTimeIn(retry, 'tr', 'abl')} sonra yeniden deneyebilirsin.`);
  });
});

describe('wake words', () => {
  it('puts the case ending a time takes as it is read aloud', () => {
    expect(['14:00', '14:30', '09:05', '10:40', '13:20', '16:00', '00:00', '12:50', '10 Kas 11:00'].map((x) => x + trSuffix(x, 'loc')))
      .toEqual(["14:00'te", "14:30'da", "09:05'te", "10:40'ta", "13:20'de", "16:00'da", "00:00'da", "12:50'de", "10 Kas 11:00'de"]);
    expect(['14:05', '15:00', '09:30'].map((x) => x + trSuffix(x, 'abl'))).toEqual(["14:05'ten", "15:00'ten", "09:30'dan"]);
  });

  it('says how often an agent comes', () => {
    const t = i18n.getFixedT('tr');
    expect([60, 30, 180, 1440, 90, 15].map((m) => everyPhrase(t, m))).toEqual(['saat başı', '30 dakikada bir', '3 saatte bir', 'günde bir', '90 dakikada bir', '15 dakikada bir']);
  });

  it('takes a routine id from the trigger URL claude.ai shows', () => {
    expect(routineIdOf(' https://api.anthropic.com/v1/claude_code/routines/trig_01ABC-x_9/fire ')).toBe('trig_01ABC-x_9');
    expect(routineIdOf('trig_01ABC')).toBe('trig_01ABC');
    expect(routineIdOf(' something ')).toBe('something');
  });
});
