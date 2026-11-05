import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '@/i18n/config';
import tr from '@/i18n/tr.json';
import { gapText } from '@/components/GapList';
import type { MeOut } from '@/api/types';
import {
  APPROVED_ID,
  DRAFT_ID,
  approvedVersion,
  consultation,
  draftGaps,
  draftVersion,
  me,
  repMe,
  strategyWithDraft,
  versions,
} from '@/test/fixtures';
import { mockFetch, renderAt, withStatus } from '@/test/render';

const approvedOnly = { approved: approvedVersion, draft: null, gaps: [] };

describe('StrategyPage', () => {
  it('shows the approved version with its hypotheses', async () => {
    mockFetch({
      'GET /api/auth/me': me,
      'GET /api/strategy': approvedOnly,
      [`GET /api/strategy/versions/${APPROVED_ID}/consultation`]: [],
      'GET /api/capability-groups': [],
    });
    renderAt('/strategy');
    expect(await screen.findByRole('heading', { level: 1, name: tr.strategy.title })).toBeInTheDocument();
    expect(await screen.findByText('Atölye videoları öğrencileri çeker')).toBeInTheDocument();
    expect(screen.getByText(i18n.t('strategy.versionLabel', { number: 1 }))).toBeInTheDocument();
    expect(within(screen.getByRole('main')).getByText('owner@alpha.example')).toBeInTheDocument();
    expect(screen.getByText(tr.strategy.hypotheses.states.kept)).toBeInTheDocument();
  });

  it("shows the draft's gaps and disables Approve for a rep", async () => {
    mockFetch({
      'GET /api/auth/me': repMe,
      'GET /api/strategy': strategyWithDraft,
      [`GET /api/strategy/versions/${DRAFT_ID}/consultation`]: consultation,
      'GET /api/capability-groups': [],
    });
    renderAt('/strategy');
    expect(await screen.findByText(tr.strategy.gapsTitle)).toBeInTheDocument();
    for (const gap of draftGaps) {
      // Each gap in the panel's own words; the server's English message never reaches a person.
      expect(screen.getAllByText(gapText(i18n.t, gap)).length).toBeGreaterThan(0);
      expect(screen.queryByText(gap.message)).not.toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: tr.strategy.approve })).toBeDisabled();
    expect(screen.getByText(tr.strategy.approveOwnerOnly)).toBeInTheDocument();
    // A rep cannot run the consultation: no submit, no note form.
    expect(screen.queryByRole('button', { name: tr.strategy.submit })).not.toBeInTheDocument();
    // The log shows who wrote what.
    expect(await screen.findByText('Hangi ürünü öne çıkaralım?')).toBeInTheDocument();
    expect(screen.getAllByText(tr.actor.agent).length).toBeGreaterThan(0);
  });

  it('lists the assumptions before approving, and approves only once confirmed', async () => {
    const user = userEvent.setup();
    const ready = { ...draftVersion, gaps: [], hypotheses: approvedVersion.hypotheses };
    const calls = mockFetch({
      'GET /api/auth/me': me,
      'GET /api/strategy': { ...strategyWithDraft, gaps: [], draft: ready },
      [`GET /api/strategy/versions/${DRAFT_ID}/consultation`]: [],
      'GET /api/capability-groups': [],
      'POST /api/strategy/draft/approve': { ...ready, status: 'approved', assumptions: [] },
    });
    const approvals = () => calls.filter((c) => c.method === 'POST' && c.path === '/api/strategy/draft/approve');
    renderAt('/strategy');
    const approve = await screen.findByRole('button', { name: tr.strategy.approve });
    expect(approve).toBeEnabled();
    await user.click(approve);

    // The dialog lists what the draft rests on; nothing is sent yet.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(tr.strategy.approveAssumptions)).toBeInTheDocument();
    expect(within(dialog).getByText('Öğrenciler akşamları sipariş verir')).toBeInTheDocument();
    expect(within(dialog).getByText(i18n.t('strategy.approveHypotheses', { count: 1 }))).toBeInTheDocument();
    expect(approvals()).toHaveLength(0);

    // Cancelling sends nothing; confirming sends the draft as it was shown.
    await user.click(within(dialog).getByRole('button', { name: tr.common.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(approvals()).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: tr.strategy.approve }));
    const again = await screen.findByRole('dialog');
    await user.click(within(again).getByRole('button', { name: tr.strategy.approveConfirm }));
    await waitFor(() => expect(approvals()).toHaveLength(1));
    expect(approvals()[0].body).toEqual({ version_id: DRAFT_ID, submitted_at: draftVersion.submitted_at });
  });

  it('says so when the draft changed since it was shown', async () => {
    const user = userEvent.setup();
    const ready = { ...draftVersion, gaps: [], assumptions: [] };
    mockFetch({
      'GET /api/auth/me': me,
      'GET /api/strategy': { ...strategyWithDraft, gaps: [], draft: ready },
      [`GET /api/strategy/versions/${DRAFT_ID}/consultation`]: [],
      'GET /api/capability-groups': [],
      'POST /api/strategy/draft/approve': withStatus(409, {
        code: 'CONFLICT',
        message: 'the draft changed since you read it',
        details: { version_id: DRAFT_ID, submitted_at: '2026-10-22T11:00:00Z' },
      }),
    });
    renderAt('/strategy');
    await user.click(await screen.findByRole('button', { name: tr.strategy.approve }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(tr.strategy.approveNoAssumptions)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: tr.strategy.approveConfirm }));
    expect(await within(dialog).findByText(tr.errors.draftChanged)).toBeInTheDocument();
  });

  it('shows the gaps a refused submission names', async () => {
    const user = userEvent.setup();
    const refusal = withStatus(422, {
      code: 'VALIDATION',
      message: 'the draft is not ready',
      details: { gaps: [{ field: 'channels', message: 'at least one channel is required' }] },
    });
    mockFetch({
      'GET /api/auth/me': me,
      'GET /api/strategy': {
        approved: null,
        draft: { ...draftVersion, submitted_at: null, gaps: [] },
        gaps: [],
      },
      [`GET /api/strategy/versions/${DRAFT_ID}/consultation`]: [],
      'GET /api/capability-groups': [],
      'POST /api/strategy/draft/submit': refusal,
    });
    renderAt('/strategy');
    await user.click(await screen.findByRole('button', { name: tr.strategy.submit }));
    expect(await screen.findByText(tr.strategy.gaps.channel)).toBeInTheDocument();
    expect(screen.getByText(tr.strategy.submitRefused)).toBeInTheDocument();
  });

  it('archives the approved version only once its number is typed', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      'GET /api/auth/me': me,
      'GET /api/strategy': approvedOnly,
      [`GET /api/strategy/versions/${APPROVED_ID}/consultation`]: [],
      'GET /api/capability-groups': [],
      'POST /api/strategy/archive': { version_id: APPROVED_ID, archived: true },
    });
    renderAt('/strategy');
    await user.click(await screen.findByRole('button', { name: tr.strategy.archive }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: tr.strategy.archive });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox'), '1');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/strategy/archive')?.body).toEqual({
        version_id: APPROVED_ID,
        confirm: true,
      }),
    );
  });

  it('lists the versions in a drawer', async () => {
    const user = userEvent.setup();
    mockFetch({
      'GET /api/auth/me': me,
      'GET /api/strategy': approvedOnly,
      [`GET /api/strategy/versions/${APPROVED_ID}/consultation`]: [],
      'GET /api/capability-groups': [],
      'GET /api/strategy/versions': versions,
    });
    renderAt('/strategy');
    await user.click(await screen.findByRole('button', { name: tr.strategy.versions }));
    const sheet = await screen.findByRole('dialog');
    expect(await within(sheet).findByText(i18n.t('strategy.versionLabel', { number: 2 }))).toBeInTheDocument();
    expect(within(sheet).getByText(tr.status.version.draft)).toBeInTheDocument();
  });
});

describe('StrategyPage across a workspace switch', () => {
  it('drops an open editor, so nothing typed in one workspace is saved into another', async () => {
    const user = userEvent.setup();
    const B = '0190a000-0000-7000-8000-0000000000b1';
    const inA: MeOut = {
      ...me,
      memberships: [
        me.memberships[0],
        { ...me.memberships[0], membership_id: '0190a000-0000-7000-8000-0000000000b2', workspace_id: B, workspace_name: 'Beta Fırın', workspace_slug: 'beta-firin' },
      ],
    };
    const inB: MeOut = { ...inA, current_workspace: B };
    const calls = mockFetch({
      'GET /api/auth/me': inA,
      'POST /api/auth/switch-workspace': inB,
      'GET /api/strategy': strategyWithDraft,
      [`GET /api/strategy/versions/${DRAFT_ID}/consultation`]: [],
      'GET /api/capability-groups': [],
    });
    renderAt('/strategy');
    const identity = tr.strategy.sections.identity;
    await screen.findByRole('heading', { name: identity });
    await user.click(screen.getAllByRole('button', { name: tr.common.edit })[0]);
    const form = await screen.findByRole('form', { name: identity });
    await user.type(within(form).getByLabelText(tr.strategy.fields.product, { exact: false }), 'A ürünü');

    await user.click(screen.getByRole('combobox', { name: tr.shell.switchWorkspace }));
    await user.click(await screen.findByRole('option', { name: 'Beta Fırın' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/auth/switch-workspace')).toBe(true));

    // The page is mounted afresh for workspace B: the editor and what was typed are gone.
    await waitFor(() => expect(screen.queryByRole('form', { name: identity })).not.toBeInTheDocument());
    expect(screen.queryByDisplayValue('A ürünü')).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});

describe('Strategy brief workbench', () => {
  const fixtures = (extra: Record<string, unknown> = {}) => ({
    'GET /api/auth/me': me,
    'GET /api/strategy': strategyWithDraft,
    [`GET /api/strategy/versions/${DRAFT_ID}/consultation`]: [],
    'GET /api/capability-groups': [],
    ...extra,
  });

  it('navigates the brief with keyboard focus without opening an editor or writing data', async () => {
    const calls = mockFetch(fixtures());
    renderAt('/strategy');
    const navigation = await screen.findByRole('navigation', { name: 'Brief bölümleri' });
    await userEvent.click(within(navigation).getByRole('button', { name: 'Hedefler ve plan' }));
    const budget = within(navigation).getByRole('link', { name: tr.strategy.sections.budget_frame });
    budget.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(document.getElementById('strategy-section-budget_frame')).toHaveFocus());
    expect(screen.queryByRole('form', { name: tr.strategy.sections.budget_frame })).not.toBeInTheDocument();
    expect(calls.some((call) => call.method !== 'GET')).toBe(false);
  });

  it('opens the first incomplete section, preserves typed work on repeated requests, and returns to reading after saving', async () => {
    const calls = mockFetch(fixtures({
      'PUT /api/strategy/draft/sections/identity': draftVersion,
    }));
    const user = userEvent.setup();
    renderAt('/strategy');
    const next = await screen.findByRole('button', { name: 'İlk eksiği tamamla' });
    await user.click(next);
    const form = await screen.findByRole('form', { name: tr.strategy.sections.identity });
    const product = within(form).getByLabelText(tr.strategy.fields.product, { exact: false });
    expect(product).toHaveFocus();
    await user.clear(product);
    await user.type(product, 'Yeni ürün briefi');
    await user.click(next);
    expect(product).toHaveValue('Yeni ürün briefi');
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    await user.click(within(form).getByRole('button', { name: tr.common.save }));
    await waitFor(() => expect(screen.queryByRole('form', { name: tr.strategy.sections.identity })).not.toBeInTheDocument());
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
    expect(document.getElementById('strategy-section-identity')?.querySelector('button')).toHaveFocus();
  });

  it('makes a missing hypothesis actionable while keeping representatives in read-only mode', async () => {
    const user = userEvent.setup();
    const data = { ...strategyWithDraft, gaps: [{ field: 'hypotheses[0].title', message: 'title required' }] };
    mockFetch(fixtures({ 'GET /api/strategy': data }));
    const first = renderAt('/strategy');
    await user.click(await screen.findByRole('button', { name: 'İlk eksiği tamamla' }));
    expect(await screen.findByRole('form', { name: tr.strategy.sections.hypotheses })).toBeInTheDocument();
    first.unmount();
    const calls = mockFetch(fixtures({ 'GET /api/auth/me': repMe, 'GET /api/strategy': data }));
    renderAt('/strategy');
    await user.click(await screen.findByRole('button', { name: 'İlk eksiğe git' }));
    await waitFor(() => expect(document.getElementById('strategy-section-hypotheses')).toHaveFocus());
    expect(screen.queryByRole('form', { name: tr.strategy.sections.hypotheses })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'İlk eksiği tamamla' })).not.toBeInTheDocument();
    expect(calls.some((call) => call.method !== 'GET')).toBe(false);
  });
  it('shows one category at a time without losing an unfinished edit when moving between categories', async () => {
    const calls = mockFetch(fixtures());
    const user = userEvent.setup();
    renderAt('/strategy');
    const navigation = await screen.findByRole('navigation', { name: 'Brief bölümleri' });
    expect(screen.getByRole('heading', { name: tr.strategy.sections.identity })).toBeVisible();
    expect(screen.queryByRole('heading', { name: tr.strategy.sections.budget_frame })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: tr.strategy.consultation.title })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'İlk eksiği tamamla' }));
    const product = within(await screen.findByRole('form', { name: tr.strategy.sections.identity })).getByLabelText(tr.strategy.fields.product, { exact: false });
    await user.clear(product);
    await user.type(product, 'Kaydedilmemiş ürün');
    await user.click(within(navigation).getByRole('button', { name: 'Hedefler ve plan' }));
    expect(screen.getByRole('heading', { name: tr.strategy.sections.budget_frame })).toBeVisible();
    expect(screen.queryByRole('form', { name: tr.strategy.sections.identity })).not.toBeInTheDocument();
    await user.click(within(navigation).getByRole('button', { name: 'Marka ve kitle' }));
    expect(product).toBeVisible();
    expect(product).toHaveValue('Kaydedilmemiş ürün');
    await user.click(within(navigation).getByRole('button', { name: tr.strategy.consultation.title }));
    expect(screen.getByRole('heading', { name: tr.strategy.consultation.title })).toBeVisible();
    expect(screen.queryByRole('heading', { name: tr.strategy.sections.identity })).not.toBeInTheDocument();
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });

});
