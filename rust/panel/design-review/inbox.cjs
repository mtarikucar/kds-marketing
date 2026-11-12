/**
 * Fixture-backed inbox/CRM/calls visual review. Requires a running panel Vite server and the
 * repository's existing frontend Playwright installation; makes no requests to a real API.
 *
 * PANEL_URL=http://127.0.0.1:5180 node design-review/inbox.cjs
 * REVIEW_CASE=consent REVIEW_WIDTHS=390 REVIEW_DIR=/tmp/inbox-review node design-review/inbox.cjs
 * Screenshots and results.json are written outside the repository by default.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const panel = path.resolve(__dirname, '..');
const { chromium } = require(path.resolve(panel, '../../frontend/node_modules/playwright'));
const ts = require(path.join(panel, 'node_modules/typescript'));
const baseURL = process.env.PANEL_URL || 'http://127.0.0.1:5180';
const output = process.env.REVIEW_DIR || '/tmp/jeeta-inbox-review';
const widths = (process.env.REVIEW_WIDTHS || '1440,390').split(',').map(Number);
const selected = process.env.REVIEW_CASE;
const theme = process.env.REVIEW_THEME || 'light';
fs.mkdirSync(output, { recursive: true });

function fixture(file) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('exports', 'require', 'module', code)(module.exports, ref => fixture(path.resolve(path.dirname(file), ref) + '.ts'), module);
  return module.exports;
}
const { workspace, USER_ID } = fixture(path.join(panel, 'src/test/fixtures.ts'));
const { inboxAnswers, inboxMe, conversation, context, person, journey, merge } = fixture(path.join(panel, 'src/test/inbox.ts'));
const copy = value => structuredClone(value);
const owner = { ...inboxMe, memberships: inboxMe.memberships.map(member => ({ ...member, permissions: [...member.permissions, 'calls.work', 'calls.manage'] })) };
const rep = { ...owner, memberships: owner.memberships.map(member => ({ ...member, role_key: 'rep', permissions: ['workspace.read', 'inbox.work', 'calls.work'] })) };
const denied = { ...owner, memberships: owner.memberships.map(member => ({ ...member, permissions: ['workspace.read'] })) };
const response = (body, status = 200, delay = 0) => ({ fixtureResponse: true, body, status, delay });
const failure = (code = 'VALIDATION', details = {}) => response({ code, message: 'Synthetic design-review failure', details }, 400);
const future = '2099-01-02T10:00';
const inHours = hours => new Date(Date.now() + hours * 3_600_000).toISOString();
const pending = { ours: [], reopen_questions: [], merges: [], tasks_due: [], public_due: [], approvals: [] };
const call = {
  id: 'call-1', capability_id: 'cap-1', person_id: 'person-1', journey_id: 'journey-1', direction: 'outbound', purpose: 'commercial',
  mode: { kind: 'human', rep_extension: '101' }, state: 'live', counterpart: '+90 5** *** ** 67', started_at: '2026-10-22T08:00:00Z',
  answered_at: '2026-10-22T08:00:10Z', ended_at: null, end_cause: null, outcome: null, summary: null, duration_s: 95, cost_minor: 300, recording: { state: 'off' },
};
const policy = {
  greeting_inbound: 'Merhaba, nasıl yardımcı olabiliriz?', voicemail_text: 'Size en kısa sürede döneceğiz.', recording_announcement: 'Görüşmemiz kaydedilebilir.',
  disclose_assistant: true, disclosure_sentence: 'Ben dijital asistanınızım.', holding_default: ['Bir saniye, hemen bakıyorum.'],
  max_duration_s: 360, slow_agent_s: 4, holding_again_s: 10, fallback_after_s: 20, caller_silence_s: 6, caller_silence_close_s: 15,
  handoff_extension: '101', estimated_minor_per_minute: 30, opening_outbound: 'Merhaba, Jeeta dijital asistanınız.', transcript_notice: 'Görüşme yazıya dökülür.', closing: 'İyi günler.',
  phrases: { acknowledgements: ['Anladım.'], fillers: ['Kontrol ediyorum.'], long_wait: ['Beklediğiniz için teşekkürler.'], not_heard: ['Tekrar eder misiniz?'], still_there: ['Hâlâ orada mısınız?'], fault: ['Sizi geri arayacağız.'] },
};
const quotes = [
  { id: 'quote-1', amount_minor: 120000, currency: 'TRY', valid_until: '2099-01-02T10:00:00Z', file_ref: 'asset:proposal-for-customer', state: 'sent' },
  { id: 'quote-2', amount_minor: 95000, currency: 'TRY', valid_until: '2026-01-02T10:00:00Z', file_ref: null, state: 'accepted' },
  { id: 'quote-3', amount_minor: 99000, currency: 'TRY', valid_until: '2026-01-02T10:00:00Z', file_ref: null, state: 'expired' },
];
const appointments = ['booked', 'held', 'cancelled'].map((state, index) => ({ id: 'appointment-' + index, state, location: 'Alfa Atölye, görüşme odası ' + (index + 1), starts_at: '2099-01-02T10:00:00Z', ends_at: '2099-01-02T11:00:00Z' }));
const commissionRows = ['pending', 'approved', 'no_payee', 'paid'].map((state, index) => ({ id: state, journey_id: 'journey-' + index, payee: state === 'no_payee' ? null : USER_ID, amount_minor: (index + 1) * 12345, currency: 'TRY', rate_bp: 250, state }));
function publicItem(id, answer = { state: 'awaiting' }, moderation = 'visible') {
  return { id, workspace_id: person.workspace_id, capability_id: 'cap-ig', conversation_id: 'conv-2', message_id: 'message-' + id, subject_id: 'subject-1',
    kind: 'comment', external_id: 'external-' + id, parent_external_id: null, root_external_id: 'external-' + id, created_at: '2026-10-23T10:00:00Z', taken_at: '2026-10-23T10:00:00Z',
    deadline: inHours(2), private_reply_until: inHours(24 * 6), live: false, answer, moderation, private_reply_message_id: null, agent_answers: 0, checked_at: null, updated_at: '2026-10-23T10:00:00Z' };
}
function entry(item, owed = false) {
  return { item, subject: { id: 'subject-1', kind: 'post', external_id: 'post-1', title: 'Yeni sezon atölyeleri', url: 'https://example.test/post', facts: {} },
    thread: [{ author: 'them', text: 'Bu atölye hakkında bilgi alabilir miyim? ' + item.id, external_id: item.external_id, at: item.created_at }, { author: 'us', text: 'Elbette, yardımcı olalım.', at: item.created_at }], owed };
}
function publicFixtures(extra = {}) {
  const rows = [entry(publicItem('item-1'), true), entry(publicItem('item-2', { state: 'pending' })), entry(publicItem('item-3', { state: 'answered', by: 'us', at: '2026-10-23T11:00:00Z', message_id: null })),
    entry(publicItem('item-4', { state: 'answered', by: 'elsewhere', at: '2026-10-23T11:00:00Z', message_id: null })), entry(publicItem('item-5', { state: 'rejected', reason: 'Platform review' })),
    entry(publicItem('item-6', { state: 'handled' })), entry(publicItem('item-7', { state: 'expired' })), ...['hidden', 'deleted', 'removed'].map(state => entry(publicItem('item-' + state, { state: 'awaiting' }, state)))];
  return {
    'GET /api/inbox/conversations/conv-2': { ...conversation, id: 'conv-2', executor: 'agent', surface: 'public', channel: 'instagram_comment', kind_key: 'instagram', owed_items: 1 },
    'GET /api/inbox/conversations/conv-2/context': { ...context, public: { channel: 'instagram_comment', rules: { public: { min: 1, max: 100 }, private: { window_s: 604800, max_chars: 60 }, one_answer: false, moderated: false, hide: true, delete: true }, approval_required: false, items: rows } },
    'GET /api/inbox/conversations/conv-2/messages': { items: [], next_cursor: null }, ...extra,
  };
}
function defaults() {
  return { ...copy(inboxAnswers), 'GET /api/auth/me': copy(owner), 'GET /api/workspace': workspace, 'GET /api/inbox/pending': copy(pending),
    'GET /api/inbox/journeys/journey-1/quotes': copy(quotes), 'GET /api/inbox/journeys/journey-1': { journey, events: [], notes: [], tasks: [], appointments: copy(appointments) },
    'GET /api/inbox/commissions': copy(commissionRows), 'GET /api/calls': [copy(call)], 'GET /api/calls/policy': copy(policy),
    'GET /api/calls/call-1': { call: copy(call), turns: [{ seq: 1, kind: { kind: 'utterance' }, text: 'Evet, buyurun.', at: call.started_at, meta: {} }, { seq: 2, kind: { kind: 'say', by: 'agent' }, text: 'Randevunuz yarın 14:00.', at: call.started_at, meta: { latency_ms: 950 } }] },
  };
}

const scenarios = [];
const scenario = (name, url, overrides, run) => scenarios.push({ name, url, overrides, run });
const exactButton = (page, name) => page.getByRole('button', { name, exact: true });
async function focusReturns(page, trigger) {
  await page.waitForFunction(node => document.activeElement === node, await trigger.elementHandle(), { timeout: 2000 });
}
async function openSection(page, title) { await page.getByRole('button', { name: new RegExp('^' + title) }).click(); }
async function fillQuote(page) {
  const form = page.getByRole('form', { name: 'Send quote' });
  await form.getByLabel('Amount', { exact: true }).fill('1200');
  await form.getByLabel('Valid until', { exact: true }).fill(future);
  await form.getByLabel('Message', { exact: true }).fill('Teklifimiz ektedir.');
  return form;
}
async function dialogCheck(ctx, trigger, submit, phrase) {
  await trigger.click();
  const dialog = ctx.page.getByRole('dialog');
  await dialog.waitFor();
  assert(await dialog.getByRole('button', { name: submit, exact: true }).isDisabled(), 'Destructive action requires confirmation');
  await dialog.getByRole('textbox').fill('wrong');
  assert(await dialog.getByRole('button', { name: submit, exact: true }).isDisabled());
  await dialog.getByRole('textbox').fill(phrase);
  assert(await dialog.getByRole('button', { name: submit, exact: true }).isEnabled());
  for (let index = 0; index < 8; index++) {
    await ctx.page.keyboard.press('Tab');
    assert(await dialog.evaluate(node => node.contains(document.activeElement)), 'Dialog retains keyboard focus through Tab wrapping');
  }
  await ctx.page.keyboard.press('Shift+Tab');
  assert(await dialog.evaluate(node => node.contains(document.activeElement)), 'Dialog retains reverse keyboard focus');
  ctx.checks.push('typed confirmation rejects wrong text; Tab and Shift+Tab stay in dialog');
  await ctx.capture('confirmed-dialog');
  return dialog;
}

scenario('queues-search-approvals', '/inbox', {}, async ctx => {
  await ctx.capture('queues');
  await exactButton(ctx.page, 'Awaiting approval').click();
  await ctx.page.getByText('No reply awaits approval.').waitFor();
  await ctx.capture('approvals-empty');
  await ctx.page.getByLabel('Search people').fill('nobody');
  await ctx.page.getByText('No matching people.').waitFor();
  await ctx.capture('search-empty');
  await exactButton(ctx.page, 'Clear search').click();
  assert.equal(await ctx.page.getByLabel('Search people').inputValue(), '');
});
scenario('approvals-populated', '/inbox', { 'GET /api/inbox/pending': { ...pending, approvals: [{ outbox_id: 'held-1', conversation_id: 'conv-1', deadline: '2099-01-02T10:00:00Z' }] } }, async ctx => {
  await exactButton(ctx.page, 'Awaiting approval').click();
  await ctx.page.getByTestId('approval').waitFor();
  await ctx.capture('approval-link');
  assert((await ctx.page.getByTestId('approval').getAttribute('href')).endsWith('/conv-1'));
});
scenario('thread-controls', '/inbox/conv-1', {}, async ctx => {
  await ctx.page.getByRole('textbox', { name: 'Your reply', exact: true }).waitFor();
  for (const [label, action] of [['Take over', 'take-over'], ['Hand back to agent', 'hand-to-agent'], ['Close conversation', 'close']]) {
    ctx.data['POST /api/inbox/conversations/conv-1/' + action] = conversation;
    await exactButton(ctx.page, label).click();
    await ctx.saw('POST /api/inbox/conversations/conv-1/' + action);
  }
  await ctx.page.getByRole('textbox', { name: 'Your reply', exact: true }).fill('Elbette, yardımcı olalım.');
  await exactButton(ctx.page, 'Send reply').click();
  await ctx.saw('POST /api/inbox/conversations/conv-1/reply');
  await ctx.page.getByLabel('Snooze until (local time)').fill(future);
  ctx.data['POST /api/inbox/conversations/conv-1/snooze'] = conversation;
  await exactButton(ctx.page, 'Snooze').click();
  await ctx.saw('POST /api/inbox/conversations/conv-1/snooze');
  await ctx.capture('controls-after-success');
});
for (const fence of ['lost', 'erased', 'merged']) {
  const personValue = { ...person, ...(fence === 'erased' ? { erased_at: '2026-11-01T10:00:00Z' } : fence === 'merged' ? { merged_into: 'person-2' } : {}) };
  scenario('thread-fence-' + fence, '/inbox/conv-1', { 'GET /api/inbox/conversations/conv-1/context': { ...context, person: personValue, journey: fence === 'lost' ? { ...journey, status: 'lost', lost_reason: { reason_key: 'fiyat', reason_label: 'Bütçeye uygun değil' } } : null } }, async ctx => {
    const reply = ctx.page.getByRole('textbox', { name: 'Your reply', exact: true });
    await reply.waitFor(); assert(await reply.isDisabled()); await ctx.capture('disabled-composer');
  });
}
scenario('thread-mailbox-refusal', '/inbox/conv-1', { 'GET /api/inbox/conversations/conv-1': { ...conversation, kind_key: 'mailbox' }, 'POST /api/inbox/conversations/conv-1/reply': response({ code: 'FORBIDDEN', message: 'Fixture', details: { reason: 'suppressed' } }, 403) }, async ctx => {
  await ctx.page.getByLabel('Email subject').fill('Teklifiniz');
  await ctx.page.getByRole('textbox', { name: 'Your reply', exact: true }).fill('Teklifiniz ektedir.');
  await exactButton(ctx.page, 'Send reply').click(); await ctx.page.getByRole('alert').first().waitFor(); await ctx.capture('reply-refused');
  ctx.data['POST /api/inbox/conversations/conv-1/reply'] = { message_id: 'reply-2', state: 'sent' };
  await exactButton(ctx.page, 'Try again').click(); await exactButton(ctx.page, 'Send reply').click(); await ctx.saw('POST /api/inbox/conversations/conv-1/reply', 2);
});
scenario('thread-snoozed-empty', '/inbox/conv-1', { 'GET /api/inbox/conversations/conv-1': { ...conversation, state: { snoozed: { until: '2099-01-02T10:00:00Z' } } }, 'GET /api/inbox/conversations/conv-1/messages': { items: [], next_cursor: null }, 'GET /api/inbox/conversations/conv-1/context': { ...context, journey: null } }, async ctx => {
  await exactButton(ctx.page, 'Unsnooze').click(); await ctx.saw('POST /api/inbox/conversations/conv-1/unsnooze'); await ctx.capture('empty-thread-no-journey');
});
scenario('consent-history-and-errors', '/inbox?person=person-1', { 'GET /api/inbox/people/person-1/consents': { consents: ['pending', 'sent', 'failed', 'failed_final'].map((sync_state, index) => ({ id: 'consent-' + index, channel: 'email', kind: index === 2 ? 'withdrawn' : 'explicit', source: 'customer', at: '2026-10-23T10:00:00Z', sync_state })), suppressions: [{ channel: 'email', reason: 'bounce' }, { channel: 'sms', reason: 'manual' }] } }, async ctx => {
  await openSection(ctx.page, 'Consent and suppressions'); await ctx.page.getByRole('region', { name: 'Recorded permissions' }).waitFor(); await ctx.capture('records-and-restrictions');
  const form = ctx.page.getByRole('form', { name: 'Record consent' });
  await form.getByLabel('Effective time').fill('2020-01-02T10:00');
  await form.getByLabel('Decision').selectOption('withdrawn');
  ctx.data['POST /api/inbox/people/person-1/consents'] = failure();
  await form.getByRole('button', { name: 'Record consent', exact: true }).click(); await ctx.saw('POST /api/inbox/people/person-1/consents'); await ctx.capture('consent-error');
  ctx.data['POST /api/inbox/people/person-1/consents'] = {};
  await form.getByRole('button', { name: 'Record consent', exact: true }).click(); await ctx.saw('POST /api/inbox/people/person-1/consents', 2);
  ctx.data['POST /api/inbox/people/person-1/suppressions'] = {};
  await form.getByRole('button', { name: 'Block selected channel' }).click(); await ctx.saw('POST /api/inbox/people/person-1/suppressions');
  ctx.data['DELETE /api/inbox/people/person-1/suppressions/email/bounce'] = {};
  await exactButton(ctx.page, 'Remove suppression: Email / Bounce').click(); await ctx.saw('DELETE /api/inbox/people/person-1/suppressions/email/bounce');
  const commercial = ctx.page.getByRole('form', { name: 'Send commercial message' });
  await commercial.getByLabel('Message', { exact: true }).fill('Yeni atölyelerimiz hakkında bilgi.');
  ctx.data['POST /api/inbox/people/person-1/send'] = failure('FORBIDDEN');
  await commercial.getByRole('button', { name: 'Send commercial message' }).click(); await ctx.saw('POST /api/inbox/people/person-1/send'); await ctx.capture('commercial-send-error');
});
scenario('consent-empty-read-only', '/inbox?person=person-1', { 'GET /api/auth/me': rep }, async ctx => {
  await openSection(ctx.page, 'Consent and suppressions'); await ctx.page.getByText('No permission records.').waitFor();
  assert.equal(await exactButton(ctx.page, 'Block selected channel').count(), 0);
  assert.equal(await exactButton(ctx.page, 'Erase personal data').count(), 0); await ctx.capture('empty-consent-rep');
});
scenario('erase-guard-and-error', '/inbox?person=person-1', {}, async ctx => {
  const trigger = exactButton(ctx.page, 'Erase personal data');
  let dialog = await dialogCheck(ctx, trigger, 'Erase permanently', 'ERASE');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await focusReturns(ctx.page, trigger);
  ctx.checks.push('cancelled erasure without API request'); assert(!ctx.requests.some(row => row.key.endsWith('/erase')));
  dialog = await dialogCheck(ctx, trigger, 'Erase permanently', 'ERASE');
  ctx.data['POST /api/inbox/people/person-1/erase'] = failure('CONFLICT');
  await dialog.getByRole('button', { name: 'Erase permanently' }).click(); await ctx.saw('POST /api/inbox/people/person-1/erase'); await ctx.capture('erasure-error');
  ctx.data['POST /api/inbox/people/person-1/erase'] = { person_id: 'person-1', erased: true };
  await dialog.getByRole('button', { name: 'Erase permanently' }).click(); await ctx.page.waitForURL('**/inbox');
});
scenario('quotes-forms-and-delivery', '/inbox?person=person-1', {}, async ctx => {
  await openSection(ctx.page, 'Quotes'); await ctx.page.getByText('asset:proposal-for-customer').waitFor(); await ctx.capture('quote-states');
  ctx.data['POST /api/inbox/quotes/quote-1/accept'] = {}; await exactButton(ctx.page, 'Accept quote').click(); await ctx.saw('POST /api/inbox/quotes/quote-1/accept');
  const form = await fillQuote(ctx.page);
  ctx.data['POST /api/inbox/journeys/journey-1/quotes'] = { quote: quotes[0], delivery: { message_id: 'msg-1', state: 'unknown' } };
  await form.getByRole('button', { name: 'Send quote', exact: true }).click(); await form.getByText('Delivery state: Unknown; do not resend.').waitFor(); await ctx.capture('quote-unknown-delivery');
  await form.getByLabel('Message', { exact: true }).fill('İkinci teklif.'); ctx.data['POST /api/inbox/journeys/journey-1/quotes'] = failure();
  await form.getByRole('button', { name: 'Send quote', exact: true }).click(); await ctx.saw('POST /api/inbox/journeys/journey-1/quotes', 2); await ctx.capture('quote-send-error');
});
scenario('appointments-forms-and-actions', '/inbox?person=person-1', {}, async ctx => {
  await openSection(ctx.page, 'Appointments'); await ctx.page.getByText('Alfa Atölye, görüşme odası 1').waitFor(); await ctx.capture('appointment-states');
  for (const [label, action] of [['Cancel appointment', 'cancel'], ['Meeting held', 'held']]) { ctx.data['POST /api/inbox/appointments/appointment-0/' + action] = {}; await exactButton(ctx.page, label).click(); await ctx.saw('POST /api/inbox/appointments/appointment-0/' + action); }
  const form = ctx.page.getByRole('form', { name: 'Book appointment' });
  await form.getByLabel('Start', { exact: true }).fill(future); await form.getByLabel('End', { exact: true }).fill('2099-01-02T11:00'); await form.getByLabel('Location').fill('Alfa Atölye');
  ctx.data['POST /api/inbox/journeys/journey-1/appointments'] = { appointment: appointments[0], notification: { state: 'refused', message_id: null } };
  await form.getByRole('button', { name: 'Book appointment' }).click(); await form.getByText('Notification: Refused').waitFor(); await ctx.capture('booking-notification-refused');
});
scenario('journey-event-forms', '/inbox?person=person-1', {}, async ctx => {
  const form = ctx.page.getByRole('form', { name: 'Record event' }); await form.waitFor();
  const event = form.getByRole('combobox').first();
  ctx.data['POST /api/inbox/journeys/journey-1/events'] = { transition: null, effects: [], duplicate: false };
  for (const kind of ['call_made', 'appointment_booked', 'meeting_held', 'quote_accepted', 'won', 'lost', 'snoozed']) {
    await event.selectOption(kind);
    if (kind === 'won') { await form.getByLabel('Product').fill('Atölye paketi'); await form.getByLabel('Amount', { exact: true }).fill('1200'); }
    if (kind === 'lost') await form.getByLabel('Lost reason').selectOption('fiyat');
    if (kind === 'snoozed') await form.getByLabel('Snooze until (local time)').fill(future);
    await ctx.capture('event-' + kind); await form.getByRole('button', { name: 'Record event' }).click();
  }
  await ctx.saw('POST /api/inbox/journeys/journey-1/events', 7);
  const task = ctx.page.getByRole('form', { name: 'Add task' });
  await task.getByLabel('Task title').fill('Teklifi takip et'); await task.getByLabel('Due date (local time)').fill(future);
  ctx.data['POST /api/inbox/journeys/journey-1/tasks'] = { id: 'task-2' }; await task.getByRole('button', { name: 'Add task' }).click(); await ctx.saw('POST /api/inbox/journeys/journey-1/tasks');
  await ctx.page.getByLabel('New note', { exact: true }).fill('Müşteri akşam aranmak istiyor.'); ctx.data['POST /api/inbox/journeys/journey-1/notes'] = { id: 'note-2' };
  await exactButton(ctx.page, 'Add note').click(); await ctx.saw('POST /api/inbox/journeys/journey-1/notes');
});
scenario('journey-terminal-empty-offers', '/inbox/conv-1', { 'GET /api/inbox/journeys/journey-1': { journey: { ...journey, status: 'lost', lost_reason: { reason_key: 'fiyat', reason_label: 'Bütçeye uygun değil' } }, tasks: [], notes: [], events: [], appointments: [] }, 'GET /api/inbox/journeys/journey-1/quotes': [] }, async ctx => {
  await exactButton(ctx.page, 'Reopen?').waitFor(); await openSection(ctx.page, 'Quotes'); await openSection(ctx.page, 'Appointments'); await ctx.capture('terminal-empty-offers');
  assert.equal(await ctx.page.getByRole('form', { name: 'Send quote' }).count(), 0); assert.equal(await ctx.page.getByRole('form', { name: 'Book appointment' }).count(), 0);
  ctx.data['POST /api/inbox/journeys/journey-1/events'] = { transition: null, effects: [], duplicate: false }; await exactButton(ctx.page, 'Reopen?').click(); await ctx.saw('POST /api/inbox/journeys/journey-1/events');
});
scenario('commissions-transitions-and-rate', '/inbox/commissions', {}, async ctx => {
  await ctx.page.getByTestId('commission-paid').waitFor(); await ctx.capture('all-payment-states');
  for (const [id, action, label, next] of [['pending', 'approve', 'Approve', 'approved'], ['approved', 'pay', 'Mark as paid', 'paid']]) {
    ctx.data['POST /api/inbox/commissions/' + id + '/' + action] = () => { ctx.data['GET /api/inbox/commissions'].find(row => row.id === id).state = next; return {}; };
    await ctx.page.getByTestId('commission-' + id).getByRole('button', { name: label, exact: true }).click(); await ctx.saw('POST /api/inbox/commissions/' + id + '/' + action);
  }
  await ctx.page.getByLabel('Rate (basis points)').fill('250'); ctx.data['PUT /api/inbox/commission-rates'] = failure();
  await exactButton(ctx.page, 'Save rate').click(); await ctx.saw('PUT /api/inbox/commission-rates'); await ctx.capture('rate-error');
  ctx.data['GET /api/inbox/commissions'] = []; await ctx.page.getByLabel('Commission state').selectOption('paid'); await ctx.page.getByText('No commissions found').waitFor(); await ctx.capture('filtered-empty');
});
scenario('commissions-rep', '/inbox/commissions', { 'GET /api/auth/me': rep }, async ctx => { await ctx.page.getByTestId('commission-paid').waitFor(); assert.equal(await exactButton(ctx.page, 'Save rate').count(), 0); assert.equal(await exactButton(ctx.page, 'Approve').count(), 0); await ctx.capture('read-only-payments'); });
scenario('merges-and-guarded-undo', '/inbox/merges', { 'GET /api/inbox/merges': [{ ...merge, id: 'merge-suggested' }, { ...merge, id: 'merge-applied', status: 'applied' }] }, async ctx => {
  await exactButton(ctx.page, 'Undo merge').waitFor(); await ctx.capture('merge-states');
  const suggestion = ctx.page.locator('#merge-merge-suggested'); await suggestion.getByLabel('Person to keep').selectOption('person-2');
  ctx.data['POST /api/inbox/merges/merge-suggested/apply'] = failure('CONFLICT'); await suggestion.getByRole('button', { name: 'Merge', exact: true }).click(); await ctx.saw('POST /api/inbox/merges/merge-suggested/apply'); await ctx.capture('merge-conflict');
  ctx.data['POST /api/inbox/merges/merge-suggested/refuse'] = {}; await suggestion.getByRole('button', { name: 'Refuse' }).click(); await ctx.saw('POST /api/inbox/merges/merge-suggested/refuse');
  const dialog = await dialogCheck(ctx, exactButton(ctx.page, 'Undo merge'), 'Undo', 'UNDO');
  ctx.data['POST /api/inbox/merges/merge-applied/undo'] = failure('CONFLICT'); await dialog.getByRole('button', { name: 'Undo', exact: true }).click(); await ctx.saw('POST /api/inbox/merges/merge-applied/undo'); await ctx.capture('undo-error');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await focusReturns(ctx.page, exactButton(ctx.page, 'Undo merge'));
});
scenario('public-states-and-reply', '/inbox/conv-2', publicFixtures(), async ctx => {
  await ctx.page.getByTestId('public-conversation').waitFor(); await ctx.capture('public-items');
  const items = ctx.page.getByRole('list', { name: 'Comments and questions' });
  await items.evaluate(node => node.scrollTop = node.scrollHeight); await ctx.capture('moderation-states');
  await exactButton(ctx.page, 'Private (DM)').click(); await ctx.page.getByRole('textbox', { name: 'Your reply', exact: true }).fill('x'.repeat(61));
  assert(await exactButton(ctx.page, 'Send the reply').isDisabled()); await ctx.capture('private-length-limit');
  await ctx.page.getByRole('textbox', { name: 'Your reply', exact: true }).fill('Bilgileri DM ile paylaştık.'); ctx.data['POST /api/inbox/conversations/conv-2/reply'] = { message_id: 'reply-2', state: 'sent' };
  await exactButton(ctx.page, 'Send the reply').click(); await ctx.saw('POST /api/inbox/conversations/conv-2/reply');
});
scenario('public-moderation-and-delete', '/inbox/conv-2', publicFixtures(), async ctx => {
  const first = ctx.page.getByTestId('public-item').first(); await first.waitFor();
  for (const [label, suffix] of [['Hide', '/items/item-1/hide'], ['No reply needed', '/items/handled']]) { ctx.data['POST /api/inbox' + suffix] = {}; await first.getByRole('button', { name: label, exact: true }).click(); await ctx.saw('POST /api/inbox' + suffix); }
  const dialog = await dialogCheck(ctx, first.getByRole('button', { name: 'Delete', exact: true }), 'Delete for good', 'DELETE');
  ctx.data['POST /api/inbox/items/item-1/delete'] = failure(); await dialog.getByRole('button', { name: 'Delete for good' }).click(); await ctx.saw('POST /api/inbox/items/item-1/delete'); await ctx.capture('delete-error');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await focusReturns(ctx.page, first.getByRole('button', { name: 'Delete', exact: true }));
});
scenario('public-held-edit-and-errors', '/inbox/conv-2', publicFixtures({ 'GET /api/inbox/pending': { ...pending, approvals: [{ outbox_id: 'held-1', item_id: 'item-1', conversation_id: 'conv-2', deadline: '2099-01-02T10:00:00Z' }] }, 'GET /api/inbox/conversations/conv-2/messages': { items: [{ id: 'draft-1', direction: 'outbound', status: 'queued', author: 'agent', body: 'Taslak yanıtımız.', item: { item_id: 'item-1' }, at: conversation.created_at }], next_cursor: null } }), async ctx => {
  const held = ctx.page.getByTestId('held-reply'); await held.waitFor(); await held.getByRole('button', { name: 'Edit and approve' }).click(); await held.getByLabel('Draft text').fill('Düzenlenmiş yanıt.');
  ctx.data['POST /api/inbox/replies/held-1/approve'] = failure(); await held.getByRole('button', { name: 'Approve and send' }).click(); await ctx.saw('POST /api/inbox/replies/held-1/approve'); await ctx.capture('held-edit-error');
  await held.getByRole('button', { name: 'Cancel', exact: true }).click(); ctx.data['POST /api/inbox/replies/held-1/discard'] = {}; await held.getByRole('button', { name: 'Discard' }).click(); await ctx.saw('POST /api/inbox/replies/held-1/discard');
});
scenario('calls-filter-and-place-refusal', '/calls', {}, async ctx => {
  await ctx.page.getByRole('table', { name: 'Calls' }).waitFor(); await exactButton(ctx.page, 'Inbound').click(); await ctx.page.getByText('No calls in this direction').waitFor(); await ctx.capture('direction-empty'); await exactButton(ctx.page, 'Show all calls').click();
  await exactButton(ctx.page, 'Place a call').click(); const dialog = ctx.page.getByRole('dialog');
  await dialog.getByLabel('Person or phone').fill('05321234567'); await dialog.getByLabel('Your extension', { exact: true }).fill('101');
  await dialog.getByRole('radio', { name: /^Commercial/ }).check(); ctx.data['POST /api/calls'] = response({ code: 'CONFLICT', message: 'Fixture', details: { reason: 'consent_missing' } }, 409);
  await dialog.getByRole('button', { name: 'Call', exact: true }).click(); await ctx.saw('POST /api/calls'); await ctx.capture('place-call-refusal');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await focusReturns(ctx.page, exactButton(ctx.page, 'Place a call'));
});
scenario('call-policy-error', '/calls', { 'PUT /api/calls/policy': failure('VALIDATION', { field: 'policy' }) }, async ctx => {
  const form = ctx.page.getByRole('form', { name: 'Call policy' }); await form.waitFor();
  await form.getByLabel('Inbound greeting').fill('Yeni karşılama.'); await form.getByLabel('Maximum call duration (s)').fill('600');
  await form.getByRole('button', { name: 'Save', exact: true }).click(); await ctx.saw('PUT /api/calls/policy'); await form.getByRole('alert').waitFor(); await ctx.capture('policy-save-error');
});
scenario('call-outcome-and-errors', '/calls/call-1', {}, async ctx => {
  const form = ctx.page.getByRole('form', { name: 'Close the call' }); await form.waitFor();
  await form.getByRole('radio', { name: 'Appointment booked' }).check(); await form.getByLabel('Summary').fill('Randevu yarın saat 14:00.');
  ctx.data['POST /api/calls/call-1/end'] = failure('CONFLICT'); await form.getByRole('button', { name: 'Record the outcome' }).click(); await ctx.saw('POST /api/calls/call-1/end'); await form.getByRole('alert').waitFor(); await ctx.capture('outcome-error');
  ctx.data['POST /api/calls/call-1/end'] = { call: { ...call, state: 'ended', outcome: 'appointment' }, turns: [] };
  ctx.data['GET /api/calls/call-1'] = ctx.data['POST /api/calls/call-1/end']; await form.getByRole('button', { name: 'Record the outcome' }).click(); await form.waitFor({ state: 'detached' }); await ctx.capture('outcome-recorded-empty-flow');
});
scenario('people-search-and-recovery', '/people', {}, async ctx => {
  await ctx.page.getByText('Deniz Örnek', { exact: true }).waitFor(); await ctx.capture('people-list');
  await ctx.page.getByLabel('Search by name or company').fill('nobody'); await ctx.page.getByText('No matching people.').waitFor(); await ctx.capture('people-no-match');
  await exactButton(ctx.page, 'Clear search').click(); await ctx.page.getByText('Deniz Örnek', { exact: true }).waitFor();
});

scenario('journey-records-owner-and-errors', '/inbox?person=person-1', {
  'GET /api/inbox/journeys/journey-1': {
    journey: { ...journey, owner: 'former-member' }, appointments,
    events: ['message_received', { call_made: { connected: false } }, { won: { product: 'Atölye paketi', amount_minor: 120000, currency: 'TRY' } }, { lost: { reason_key: 'fiyat' } }, { snoozed: { until: '2099-01-02T10:00:00Z' } }, { merged: { target: 'person-2' } }].map((kind, index) => ({ id: 'event-' + index, kind, source: index % 2 ? 'agent' : { human: USER_ID }, reason_label: 'Bütçeye uygun değil', at: '2026-10-23T10:00:00Z' })),
    tasks: ['open', 'done', 'cancelled'].map((status, index) => ({ id: 'task-' + index, status, title: 'Teklifi takip et ' + index, due_at: '2099-01-02T10:00:00Z', assignee: index === 1 ? null : USER_ID })),
    notes: [{ id: 'note-1', author: { human: USER_ID }, text: 'Müşteri akşam aranmak istiyor.\nYeni ekip notu.', at: '2026-10-23T10:00:00Z' }],
  },
}, async ctx => {
  await ctx.page.getByText('Teklifi takip et 0').waitFor(); await ctx.capture('timeline-and-tasks');
  const ownerSelect = ctx.page.getByRole('complementary', { name: 'Journey' }).getByRole('combobox').first();
  assert.equal(await ownerSelect.inputValue(), 'former-member');
  ctx.data['POST /api/inbox/journeys/journey-1/owner'] = failure('CONFLICT');
  await ownerSelect.selectOption(USER_ID); await ctx.saw('POST /api/inbox/journeys/journey-1/owner'); await ctx.capture('owner-error');
  ctx.data['POST /api/inbox/tasks/task-0/complete'] = {}; await exactButton(ctx.page, 'Complete').click(); await ctx.saw('POST /api/inbox/tasks/task-0/complete');
  await ctx.page.getByLabel('New note', { exact: true }).fill('İkinci not.'); ctx.data['POST /api/inbox/journeys/journey-1/notes'] = failure();
  await exactButton(ctx.page, 'Add note').click(); await ctx.saw('POST /api/inbox/journeys/journey-1/notes'); await ctx.capture('note-error');
});
scenario('task-person-and-pagination', '/inbox?task=missing', {}, async ctx => {
  await ctx.page.getByText('Task not found.').waitFor(); await ctx.capture('missing-task');
  ctx.data['GET /api/inbox/people/person-1'] = { person, identities: [], open_journey: null, conversations: [] };
  await ctx.page.goto(baseURL + '/inbox?person=person-1'); await ctx.page.getByText('This person has no conversations yet.').waitFor(); await ctx.capture('person-no-conversation');
  ctx.data['GET /api/inbox/conversations'] = ({ url }) => ({ items: url.searchParams.has('cursor') ? [] : [conversation], next_cursor: url.searchParams.has('cursor') ? null : 'page-2' });
  await ctx.page.goto(baseURL + '/inbox'); await exactButton(ctx.page, 'Load more').click();
  assert(ctx.requests.some(row => row.key === 'GET /api/inbox/conversations' && row.query.includes('cursor=page-2'))); await ctx.capture('queue-next-page');
});
scenario('public-no-private-reply-and-empty', '/inbox/conv-2', publicFixtures(), async ctx => {
  const part = ctx.data['GET /api/inbox/conversations/conv-2/context'].public;
  part.rules.private = null; part.approval_required = true;
  part.items = [entry(publicItem('comment-1'), true)]; part.items[0].subject = { kind: 'post', title: 'Atölye seti', external_id: 'post-2', url: null };
  await ctx.page.reload(); await ctx.page.getByTestId('public-conversation').waitFor();
  assert.equal(await exactButton(ctx.page, 'Private (DM)').count(), 0); await ctx.capture('no-private-reply-guidance');
  part.items = []; await ctx.page.reload(); await ctx.page.getByText('No comment is waiting for a reply.').waitFor(); await ctx.capture('no-owed-items');
});
scenario('public-held-approval-and-permission', '/inbox/conv-2', publicFixtures({
  'GET /api/auth/me': rep,
  'GET /api/inbox/pending': { ...pending, approvals: [{ outbox_id: 'held-1', item_id: 'item-1', conversation_id: 'conv-2', deadline: '2000-01-02T10:00:00Z' }] },
  'GET /api/inbox/conversations/conv-2/messages': { items: [{ id: 'draft-1', direction: 'outbound', status: 'queued', author: 'agent', body: 'Taslak yanıtımız.', item: { item_id: 'item-1' }, at: conversation.created_at }], next_cursor: null },
}), async ctx => {
  await ctx.page.getByTestId('held-reply').waitFor(); assert.equal(await exactButton(ctx.page, 'Delete').count(), 0); await ctx.capture('rep-held-expired-deadline');
  ctx.data['POST /api/inbox/replies/held-1/approve'] = { message_id: 'reply-3', state: 'sent' };
  await ctx.page.getByTestId('held-reply').getByRole('button', { name: 'Approve', exact: true }).click(); await ctx.saw('POST /api/inbox/replies/held-1/approve');
  assert.deepEqual(ctx.requests.find(row => row.key.endsWith('/held-1/approve')).body, {});
  ctx.data['GET /api/inbox/pending'] = failure(); await ctx.page.reload(); await ctx.page.getByTestId('public-conversation').getByRole('button', { name: 'Try again' }).waitFor(); await ctx.capture('approval-read-error');
});
scenario('calls-states-and-success', '/calls', { 'GET /api/calls': ['planned', 'dialing', 'ringing', 'live', 'holding', 'ending', 'ended'].map((state, index) => ({ ...call, id: 'call-' + index, state, direction: index % 2 ? 'inbound' : 'outbound', mode: index % 2 ? { kind: 'agent' } : call.mode, outcome: state === 'ended' ? 'voicemail' : null })) }, async ctx => {
  await ctx.page.getByRole('table', { name: 'Calls' }).waitFor(); await ctx.capture('all-call-states');
  await exactButton(ctx.page, 'Place a call').click(); const dialog = ctx.page.getByRole('dialog');
  await dialog.getByLabel('Person or phone').fill('person-1'); await dialog.getByLabel('Your extension', { exact: true }).fill('101');
  await dialog.getByRole('radio', { name: /^Callback/ }).check(); ctx.data['POST /api/calls'] = response(call, 200, 2500);
  await dialog.getByRole('button', { name: 'Call', exact: true }).click();
  await ctx.page.waitForFunction(button => button.disabled, await dialog.getByRole('button', { name: 'Cancel', exact: true }).elementHandle()); await ctx.capture('call-placing');
  await dialog.waitFor({ state: 'detached' });
});
scenario('call-detail-summary-latency-rep', '/calls/call-1', { 'GET /api/auth/me': rep }, async ctx => {
  const out = ctx.data['GET /api/calls/call-1'];
  const percentiles = { n: 2, p50: 620, p95: 1400 };
  out.call = { ...call, state: 'ended', summary: 'Randevu onaylandı.\n' + 'Teklifdetayı'.repeat(30), end_cause: { cause: 'caller_hangup', detail: 'Customer disconnected.' }, latency: { turns: 2, perceived: percentiles, content: percentiles, agent: percentiles, barge_in_stop: { n: 0, p50: null, p95: null }, alerts: ['perceived_p95_over_1s'] } };
  out.turns.push({ seq: 3, kind: { kind: 'holding' }, text: 'Bir saniye.', at: call.started_at, meta: {} }, { seq: 4, kind: { kind: 'event', name: 'ended' }, text: '', at: call.started_at, meta: {} });
  await ctx.page.reload(); await ctx.page.getByText('Latency (p50 / p95)').waitFor(); assert.equal(await exactButton(ctx.page, 'Record the outcome').count(), 0); await ctx.capture('summary-latency-script-line');
});
scenario('people-pagination', '/people', { 'GET /api/inbox/people': Array.from({ length: 50 }, (_, index) => ({ ...person, id: 'person-' + index, display_name: 'Contact ' + index })) }, async ctx => {
  await ctx.page.getByText('Contact 49', { exact: true }).waitFor(); assert(await exactButton(ctx.page, 'Previous').isDisabled());
  ctx.data['GET /api/inbox/people'] = [{ ...person, display_name: 'Contact 50' }]; await exactButton(ctx.page, 'Next').click(); await ctx.page.getByText('Contact 50', { exact: true }).waitFor(); assert(await exactButton(ctx.page, 'Next').isDisabled()); await ctx.capture('last-people-page');
});
scenario('journey-won-and-empty-quote-forms', '/inbox?person=person-1', { 'GET /api/inbox/journeys/journey-1': { journey: { ...journey, status: 'won' }, tasks: [], notes: [], events: [], appointments: [] }, 'GET /api/inbox/journeys/journey-1/quotes': [] }, async ctx => {
  await openSection(ctx.page, 'Quotes'); await openSection(ctx.page, 'Appointments'); await ctx.capture('won-terminal');
  assert.equal(await ctx.page.getByRole('form', { name: 'Record event' }).count(), 0);
  ctx.data['GET /api/inbox/journeys/journey-1'].journey = journey; await ctx.page.reload(); await openSection(ctx.page, 'Quotes'); await openSection(ctx.page, 'Appointments'); await ctx.capture('open-empty-offer-forms');
});
scenario('merge-person-read-error', '/inbox/merges', { 'GET /api/inbox/merges': [merge], 'GET /api/inbox/people/person-2': failure() }, async ctx => {
  await exactButton(ctx.page, 'Try again').waitFor(); await ctx.capture('merge-person-error');
});
scenario('remaining-queue-and-task-branches', '/inbox', {
  'GET /api/inbox/conversations': { items: ['private', 'public', 'public', 'relay'].map((surface, index) => ({ ...conversation, id: 'queue-' + index, surface, channel: index === 2 ? 'facebook_comment' : 'instagram_comment', owed_items: 2, held_replies: 1, next_deadline: inHours(1) })), next_cursor: null },
  'GET /api/inbox/tasks': [{ id: 'task-1', journey_id: 'journey-1', title: 'Teklifi takip et', due_at: '2099-01-02T10:00:00Z', status: 'open', assignee: USER_ID }],
}, async ctx => {
  await ctx.capture('surface-badges-and-deadlines'); await ctx.page.goto(baseURL + '/inbox?task=task-1');
  await ctx.page.getByRole('complementary', { name: 'Journey' }).waitFor(); await ctx.capture('resolved-task-journey');
  ctx.data['GET /api/team'] = failure(); await ctx.page.reload(); await ctx.page.getByRole('button', { name: 'Try again' }).waitFor(); await ctx.capture('team-read-error');
  ctx.data['GET /api/team'] = inboxAnswers['GET /api/team']; ctx.data['GET /api/inbox/lost-reasons'] = failure(); await ctx.page.reload();
  await ctx.page.getByRole('form', { name: 'Record event' }).getByRole('combobox').first().selectOption('lost');
  await ctx.page.getByRole('form', { name: 'Record event' }).getByRole('button', { name: 'Try again' }).waitFor(); await ctx.capture('lost-reasons-read-error');
});
scenario('people-empty-next-page', '/people', { 'GET /api/inbox/people': Array.from({ length: 50 }, (_, index) => ({ ...person, id: 'person-' + index, display_name: 'Contact ' + index })) }, async ctx => {
  await ctx.page.getByText('Contact 49', { exact: true }).waitFor(); ctx.data['GET /api/inbox/people'] = [];
  await exactButton(ctx.page, 'Next').click(); await ctx.page.getByText('No matching people.').waitFor(); await ctx.capture('empty-next-page');
  ctx.data['GET /api/inbox/people'] = [{ ...person, display_name: 'Contact 49' }]; await exactButton(ctx.page, 'Previous').click(); await ctx.page.getByText('Contact 49', { exact: true }).waitFor();
});

// Each request boundary is exercised independently: initial spinner, recoverable read failure,
// retry control, and its healthy rendering. This is intentionally not every state cross-product.
for (const [name, url, key, setup] of [
  ['queue', '/inbox', 'GET /api/inbox/conversations'], ['thread', '/inbox/conv-1', 'GET /api/inbox/conversations/conv-1'],
  ['messages', '/inbox/conv-1', 'GET /api/inbox/conversations/conv-1/messages'], ['context', '/inbox/conv-1', 'GET /api/inbox/conversations/conv-1/context'],
  ['person', '/inbox?person=person-1', 'GET /api/inbox/people/person-1'], ['journey', '/inbox?person=person-1', 'GET /api/inbox/journeys/journey-1'],
  ['consents', '/inbox?person=person-1', 'GET /api/inbox/people/person-1/consents', page => openSection(page, 'Consent and suppressions')],
  ['quotes', '/inbox?person=person-1', 'GET /api/inbox/journeys/journey-1/quotes', page => openSection(page, 'Quotes')],
  ['approvals', '/inbox', 'GET /api/inbox/pending', page => exactButton(page, 'Awaiting approval').click()],
  ['tasks', '/inbox?task=missing', 'GET /api/inbox/tasks'],
  ['commissions', '/inbox/commissions', 'GET /api/inbox/commissions'], ['merges', '/inbox/merges', 'GET /api/inbox/merges'],
  ['calls', '/calls', 'GET /api/calls'], ['policy', '/calls', 'GET /api/calls/policy'], ['call-detail', '/calls/call-1', 'GET /api/calls/call-1'], ['people', '/people', 'GET /api/inbox/people'],
]) {
  scenario('read-boundary-' + name, url, {}, async ctx => {
    const healthy = ctx.data[key]; ctx.data[key] = failure();
    await ctx.page.reload(); if (setup) await setup(ctx.page);
    await ctx.page.getByRole('button', { name: 'Try again', exact: true }).first().waitFor(); await ctx.capture('read-error');
    ctx.data[key] = response(healthy, 200, 1400); await ctx.page.getByRole('button', { name: 'Try again', exact: true }).first().click();
    await ctx.page.getByRole('status', { name: 'Loading' }).first().waitFor(); await ctx.capture('retry-loading');
    ctx.data[key] = healthy; await ctx.page.getByRole('status', { name: 'Loading' }).first().waitFor({ state: 'detached' }); await ctx.capture('read-recovered');
  });
}
for (const [name, url] of [['inbox', '/inbox'], ['commissions', '/inbox/commissions'], ['merges', '/inbox/merges'], ['calls', '/calls']]) {
  scenario('permission-' + name, url, { 'GET /api/auth/me': denied }, async ctx => { await ctx.page.getByRole('alert').or(ctx.page.getByRole('status')).first().waitFor(); await ctx.capture('permission-guidance'); });
}
for (const [name, url, key, value] of [['people', '/people', 'GET /api/inbox/people', []], ['calls', '/calls', 'GET /api/calls', []], ['merges', '/inbox/merges', 'GET /api/inbox/merges', []]]) {
  scenario('empty-' + name, url, { [key]: value }, async ctx => { await ctx.capture('initial-empty'); });
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const results = [];
  for (const item of scenarios.filter(item => !selected || selected.split(',').some(name => item.name.includes(name)))) {
    for (const width of widths) {
      const page = await browser.newPage({ viewport: { width, height: width < 600 ? 844 : 1100 }, reducedMotion: 'reduce' });
      await page.addInitScript(value => { localStorage.setItem('jeeta-panel-language', 'en'); localStorage.setItem('jeeta-panel-theme', value); }, theme);
      page.setDefaultTimeout(6000);
      page.setDefaultNavigationTimeout(30000);
      const result = { case: item.name, width, theme, captures: [], checks: [], runtimeErrors: [], unhandledAPI: [] };
      const data = { ...defaults(), ...copy(item.overrides) };
      const requests = [];
      page.on('pageerror', error => result.runtimeErrors.push(error.message));
      await page.route('**/api/**', async route => {
        const url = new URL(route.request().url()); if (!url.pathname.startsWith('/api/')) return route.continue();
        const key = route.request().method() + ' ' + url.pathname;
        const body = route.request().postData() ? route.request().postDataJSON() : undefined;
        requests.push({ key, body, query: url.search });
        let answer = data[key];
        if (key === 'GET /api/inbox/people' && url.searchParams.get('q')) answer = [];
        if (typeof answer === 'function') answer = answer({ body, url });
        if (answer === undefined) { result.unhandledAPI.push(key); answer = response({ code: 'NOT_FOUND', message: 'No fixture', details: {} }, 404); }
        const wrapped = answer?.fixtureResponse ? answer : response(answer);
        if (wrapped.delay) await new Promise(resolve => setTimeout(resolve, wrapped.delay));
        await route.fulfill({ status: wrapped.status, contentType: 'application/json', body: JSON.stringify(wrapped.body) });
      });
      const ctx = {
        page, data, requests, checks: result.checks,
        saw: async (key, count = 1) => { await page.waitForFunction(() => true); for (let i = 0; i < 100 && requests.filter(row => row.key === key).length < count; i++) await page.waitForTimeout(30); assert(requests.filter(row => row.key === key).length >= count, 'Expected request: ' + key); result.checks.push(key); },
        capture: async label => {
          await page.waitForTimeout(100);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
          const dialogOverflow = await page.getByRole('dialog').evaluateAll(nodes => nodes.some(node => node.scrollWidth > node.clientWidth + 1 || node.getBoundingClientRect().left < 0 || node.getBoundingClientRect().right > innerWidth));
          assert(!overflow, 'Document horizontal overflow at ' + label); assert(!dialogOverflow, 'Dialog horizontal overflow at ' + label);
          const file = `${width}-${item.name}-${label}.png`;
          const hasDialog = await page.getByRole('dialog').count() > 0;
          if (!hasDialog) await page.evaluate(() => window.scrollTo(0, 0));
          await page.screenshot({ path: path.join(output, file), fullPage: !hasDialog });
          result.captures.push({ label, file, overflow, dialogOverflow });
        },
      };
      try {
        await page.goto(baseURL + item.url, { waitUntil: 'domcontentloaded', timeout: 30000 }); await page.locator('main').waitFor(); await page.waitForTimeout(220);
        await item.run(ctx); assert.equal(result.runtimeErrors.length, 0, 'Browser runtime errors'); result.passed = true;
      } catch (error) {
        result.passed = false; result.error = error.message;
        await page.screenshot({ path: path.join(output, `${width}-${item.name}-FAILED.png`), fullPage: true }).catch(() => {});
      }
      results.push(result); fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
      console.log(JSON.stringify({ case: item.name, width, passed: result.passed, captures: result.captures.length, error: result.error }));
      await page.close();
    }
  }
  await browser.close();
  console.log(`Review output: ${output}`);
  if (results.some(result => !result.passed)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
