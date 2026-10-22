import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '@/i18n/config';
import tr from '@/i18n/tr.json';
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
    expect(screen.getByText('owner@alpha.example')).toBeInTheDocument();
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
      expect(screen.getAllByText(gap.message).length).toBeGreaterThan(0);
    }
    expect(screen.getByRole('button', { name: tr.strategy.approve })).toBeDisabled();
    expect(screen.getByText(tr.strategy.approveOwnerOnly)).toBeInTheDocument();
    // A rep cannot run the consultation: no submit, no note form.
    expect(screen.queryByRole('button', { name: tr.strategy.submit })).not.toBeInTheDocument();
    // The log shows who wrote what.
    expect(await screen.findByText('Hangi ürünü öne çıkaralım?')).toBeInTheDocument();
    expect(screen.getAllByText(tr.actor.agent).length).toBeGreaterThan(0);
  });

  it('lets an owner approve a submitted draft', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      'GET /api/auth/me': me,
      'GET /api/strategy': { ...strategyWithDraft, gaps: [], draft: { ...draftVersion, gaps: [] } },
      [`GET /api/strategy/versions/${DRAFT_ID}/consultation`]: [],
      'GET /api/capability-groups': [],
      'POST /api/strategy/draft/approve': { ...draftVersion, status: 'approved', gaps: [] },
    });
    renderAt('/strategy');
    const approve = await screen.findByRole('button', { name: tr.strategy.approve });
    expect(approve).toBeEnabled();
    await user.click(approve);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/strategy/draft/approve')).toBe(true));
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
    expect(await screen.findByText('at least one channel is required')).toBeInTheDocument();
    expect(screen.getByText(tr.strategy.submitRefused)).toBeInTheDocument();
  });

  it('archives the approved version only once its number is typed', async () => {
    const user = userEvent.setup();
    const calls = mockFetch({
      'GET /api/auth/me': me,
      'GET /api/strategy': approvedOnly,
      [`GET /api/strategy/versions/${APPROVED_ID}/consultation`]: [],
      'GET /api/capability-groups': [],
      'POST /api/strategy/archive': null,
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
