import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { me } from '@/test/fixtures';
import { HOUR, at, connection, key, routine, wake, wakesOf } from '@/test/agents';
import { mockFetch, renderAt, withStatus } from '@/test/render';
import { wakeTime } from '@/lib/wake';
import { AGENT_COPY } from './copy';
import { checkWake, type WakeInput } from './wake';

// The wake address on an agent's row: one compact line when it is set, "Hemen çağrılabilsin"
// when it is not; the small inline form, checked before it is sent, that no password manager
// takes for a login; a member without `team.manage` reads it and nothing more.

const c = AGENT_COPY.tr;
const k = key({ name: 'Gece işleri', scopes: ['workspace.read', 'content.work'] });
const conns = [connection(k, { last_seen_at: at(-20 * 60_000) })];
const member = { ...me, memberships: [{ ...me.memberships[0], permissions: me.memberships[0].permissions.filter((p) => p !== 'team.manage') }] };
const page = (agentWake = wake(k, { last_seen_at: at(-20 * 60_000) }), over: Record<string, unknown> = {}) => mockFetch({
  'GET /api/auth/me': me, 'GET /api/agents': conns, 'GET /api/api-keys': [k], 'GET /api/agents/wakes': wakesOf(agentWake), ...over,
});
const row = () => screen.findByRole('article', { name: 'Gece işleri' });

describe('the wake address on an agent’s row', () => {
  it('offers to set one when there is none, and sets a Claude routine from its trigger URL', async () => {
    const user = userEvent.setup();
    const calls = page(undefined, { [`PUT /api/agents/${k.id}/wake`]: wakesOf(wake(k, { address: routine(), run_now: { api_key_id: k.id, after: null } })) });
    renderAt('/agents');
    const r = await row();
    expect(within(r).queryByTestId('wake-line')).not.toBeInTheDocument();
    await user.click(within(r).getByRole('button', { name: c.wakeNone }));
    const form = within(r).getByRole('form', { name: 'Gece işleri için çağrı adresi' });
    expect(within(form).getByText(c.routineHelp)).toBeInTheDocument();
    expect(c.routineHelp.split('. ')).toHaveLength(2);
    await user.type(within(form).getByLabelText(c.routineId), 'https://api.anthropic.com/v1/claude_code/routines/trig_01ABC/fire');
    await user.type(within(form).getByLabelText(c.token), 'sk-ant-oat01-abcdef');
    await user.click(within(form).getByRole('button', { name: c.save }));
    await waitFor(() => expect(calls.find((x) => x.method === 'PUT')).toMatchObject({ body: { kind: 'claude_routine', routine_id: 'trig_01ABC', token: 'sk-ant-oat01-abcdef' } }));
    expect(await within(r).findByTestId('wake-line')).toHaveTextContent('İş verilince hemen çağrılır: Claude rutini trig_01ABC');
    expect(document.body.textContent).not.toContain('sk-ant-oat01-abcdef');
    expect(screen.queryByDisplayValue('sk-ant-oat01-abcdef')).not.toBeInTheDocument();
    // Now set, the row offers to run it now.
    expect(within(r).getByRole('button', { name: /Şimdi çalıştır/ })).toBeInTheDocument();
  });

  it('is not a login form: no password field, no user-name-like sibling, ignored by the common managers', async () => {
    const user = userEvent.setup();
    page();
    renderAt('/agents');
    const r = await row();
    await user.click(within(r).getByRole('button', { name: c.wakeNone }));
    const form = within(r).getByRole('form');
    expect(form.querySelector('input[type=password]')).toBeNull();
    expect(form).toHaveAttribute('autocomplete', 'off');
    for (const input of form.querySelectorAll('input')) {
      expect(input).toHaveAttribute('autocomplete', 'off');
      expect(input).toHaveAttribute('data-1p-ignore', 'true');
      expect(input).toHaveAttribute('data-lpignore', 'true');
      expect(input).toHaveAttribute('data-bwignore', 'true');
      expect(input.getAttribute('type')).not.toBe('email');
      expect(input.name).not.toMatch(/user|mail|login|pass/i);
    }
    // The token is a text field with a button that shows it.
    const token = within(form).getByLabelText(c.token);
    expect(token).toHaveAttribute('type', 'text');
    const reveal = within(form).getByRole('button', { name: c.show });
    expect(reveal).toHaveAttribute('aria-pressed', 'false');
    await user.click(reveal);
    expect(within(form).getByRole('button', { name: c.hide })).toHaveAttribute('aria-pressed', 'true');
    // The webhook's signing secret is protected the same way.
    await user.click(within(form).getByRole('button', { name: c.kindWebhook }));
    expect(within(form).getByLabelText(c.secret)).toHaveAttribute('type', 'text');
    expect(form.querySelector('input[type=password]')).toBeNull();
  });

  it('says at each field what is wrong before anything is sent', async () => {
    const user = userEvent.setup();
    const calls = page();
    renderAt('/agents');
    const r = await row();
    await user.click(within(r).getByRole('button', { name: c.wakeNone }));
    const form = within(r).getByRole('form');
    await user.click(within(form).getByRole('button', { name: c.save }));
    expect(within(form).getByText(c.eRoutineEmpty)).toBeInTheDocument();
    expect(within(form).getByText(c.eTokenEmpty)).toBeInTheDocument();
    // What a password manager would have filled: the owner's e-mail and password.
    await user.type(within(form).getByLabelText(c.routineId), 'owner@alpha.example');
    await user.type(within(form).getByLabelText(c.token), 'hunter2!');
    await user.click(within(form).getByRole('button', { name: c.save }));
    expect(within(form).getByText(c.eRoutineEmail)).toBeInTheDocument();
    expect(within(form).getByText(c.eToken)).toBeInTheDocument();
    expect(within(form).getByLabelText(c.routineId)).toHaveAttribute('aria-invalid', 'true');
    // Typing again clears the field's message.
    await user.type(within(form).getByLabelText(c.routineId), 'x');
    expect(within(form).queryByText(c.eRoutineEmail)).not.toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: c.kindWebhook }));
    await user.type(within(form).getByLabelText(c.url), 'http://user:pw@example.com/hook');
    await user.type(within(form).getByLabelText(c.secret), 'has space');
    await user.click(within(form).getByRole('button', { name: c.save }));
    expect(within(form).getByText(c.eUrl)).toBeInTheDocument();
    expect(within(form).getByText(c.eSecret)).toBeInTheDocument();
    expect(calls.some((x) => x.method === 'PUT')).toBe(false);
  });

  it('shows the field the server refused under that field', async () => {
    const user = userEvent.setup();
    page(undefined, { [`PUT /api/agents/${k.id}/wake`]: withStatus(422, { code: 'VALIDATION', message: 'bad token', details: { field: 'token' } }) });
    renderAt('/agents');
    const r = await row();
    await user.click(within(r).getByRole('button', { name: c.wakeNone }));
    const form = within(r).getByRole('form');
    await user.type(within(form).getByLabelText(c.routineId), 'trig_01ABC');
    await user.type(within(form).getByLabelText(c.token), 'sk-ant-oat01-revoked');
    await user.click(within(form).getByRole('button', { name: c.save }));
    expect(await within(form).findByText(c.eToken)).toBeInTheDocument();
  });

  it('says the address, the last call and its session in one line, and removes it after asking', async () => {
    const user = userEvent.setup();
    const last = at(-HOUR);
    const set = wake(k, { address: routine(), last: { at: last, reasons: ['content_revision'], outcome: 'fired', status: 200, session_id: 's1', session_url: 'https://claude.ai/code/session_1' } });
    const calls = page(set, { [`DELETE /api/agents/${k.id}/wake`]: wakesOf(wake(k)) });
    renderAt('/agents');
    const line = within(await row()).getByTestId('wake-line');
    expect(line).toHaveTextContent(`İş verilince hemen çağrılır: Claude rutini trig_01ABC · son çağrı ${wakeTime(last, 'tr')}: ulaştı · oturumu aç`);
    expect(within(line).getByRole('link', { name: c.wakeSession })).toHaveAttribute('href', 'https://claude.ai/code/session_1');
    await user.click(within(line).getByRole('button', { name: c.wakeRemove }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: c.wakeRemove }));
    await waitFor(() => expect(calls.some((x) => x.method === 'DELETE' && x.path === `/api/agents/${k.id}/wake`)).toBe(true));
    expect(await screen.findByText(c.wakeRemoved)).toBeInTheDocument();
  });

  it('names a webhook by its host, and changes an address from an empty form', async () => {
    const user = userEvent.setup();
    page(wake(k, { address: { ...routine()!, kind: 'webhook', target: 'hooks.example.com' } }));
    renderAt('/agents');
    const r = await row();
    expect(within(r).getByTestId('wake-line')).toHaveTextContent('İş verilince hemen çağrılır: hooks.example.com adresine webhook');
    await user.click(within(r).getByRole('button', { name: c.wakeChange }));
    const form = within(r).getByRole('form');
    expect(within(form).getByRole('button', { name: c.kindWebhook })).toHaveAttribute('aria-pressed', 'true');
    expect(within(form).getByLabelText(c.url)).toHaveValue('');
  });

  it('shows a member without team.manage the line and no buttons', async () => {
    page(wake(k, { address: routine() }), { 'GET /api/auth/me': member });
    renderAt('/agents');
    const r = await row();
    expect(within(r).getByTestId('wake-line')).toHaveTextContent('Claude rutini trig_01ABC');
    expect(within(r).queryByRole('button', { name: c.wakeChange })).not.toBeInTheDocument();
    expect(within(r).queryByRole('button', { name: c.wakeRemove })).not.toBeInTheDocument();
    expect(within(r).queryByRole('button', { name: c.wakeNone })).not.toBeInTheDocument();
  });
});

describe('checkWake', () => {
  const routineInput = (routine: string, token: string): WakeInput => ({ kind: 'claude_routine', routine, token, url: '', secret: '' });
  const hook = (url: string, secret = ''): WakeInput => ({ kind: 'webhook', routine: '', token: '', url, secret });
  it('takes a routine id or its trigger URL, and a routine token', () => {
    expect(checkWake(routineInput('trig_01ABC', 'sk-ant-oat01-x'))).toEqual({});
    expect(checkWake(routineInput(' https://api.anthropic.com/v1/claude_code/routines/trig_01ABC/fire ', ' sk-ant-oat01-x '))).toEqual({});
    expect(checkWake(routineInput('trig_', 'sk-ant-oat01-'))).toEqual({ routine_id: 'eRoutine', token: 'eToken' });
    expect(checkWake(routineInput('routine-1', 'sk-ant-api03-x'))).toEqual({ routine_id: 'eRoutine', token: 'eToken' });
    expect(checkWake(routineInput('a@b.co', 'sk-ant-oat01-a b'))).toEqual({ routine_id: 'eRoutineEmail', token: 'eToken' });
    expect(checkWake(routineInput(`trig_${'a'.repeat(130)}`, 'sk-ant-oat01-x'))).toEqual({ routine_id: 'eRoutine' });
  });
  it('takes a public https webhook and a printable secret', () => {
    expect(checkWake(hook('https://hooks.example.com/x'))).toEqual({});
    expect(checkWake(hook('https://hooks.example.com/x', 'abc!123'))).toEqual({});
    expect(checkWake(hook('http://hooks.example.com/x'))).toEqual({ url: 'eUrl' });
    expect(checkWake(hook('https://u:p@hooks.example.com'))).toEqual({ url: 'eUrl' });
    expect(checkWake(hook('not a url', 'tab\there'))).toEqual({ url: 'eUrl', secret: 'eSecret' });
  });
});
