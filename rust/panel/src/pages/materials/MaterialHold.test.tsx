import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch } from '@/test/render';
import { renderMaterialHold } from '@/test/materialHold';
import { materialsAnswers, repMe, shoot } from '@/test/materials';
import tr from '@/i18n/tr.json';
import en from '@/i18n/en.json';
import { FINDING_CODES } from './MaterialsShared';

// Today's slot card when the material check holds the piece (`material_check_hold`, spec §5.6):
// each finding in plain Turkish, the open çekim listesi count, and the release of caption findings
// by an owner or manager (D19).

const h = { id: 'h1', title: 'Atölye hikâyeleri', metric: 'engagement', prior_confidence: 0.4, derived_confidence: null, channel: 'instagram', cadence: {}, state: 'kept' };
const chain = { workspace_id: 'w', born_version_id: 'v1', hypothesis_id: 'h1', arm_id: 'a1' };
const slot = { id: 's1', chain, capability_id: 'c1', scheduled_at: new Date(Date.now() + 3600_000).toISOString(), state: 'ready', revision: 4 };
function overview(details: unknown[], nextAction = 'fix_piece', shoots: unknown[] = []) {
  return {
    strategy: { id: 'v1', number: 3 },
    goals: { objective: 'Daha çok sipariş', kpis: [] },
    hypotheses: [h],
    control: { revision: 2, brake_engaged: false, lanes: {} },
    lane_support: { organic: { visible: true, supported: true }, paid: { visible: false, supported: false } },
    slots: [slot],
    today: {
      slots: [{ slot, overdue: false }],
      approvals: [],
      budget_moves: [],
      blockers: [{ target: { slot: 's1' }, reason: 'material_check_hold', next_action: nextAction, details }],
      paid_alerts: [],
      ...(shoots.length ? { shoot_requests: shoots } : {}),
    },
    learned: { hypotheses: [], arms: [{ arm: { id: 'a1', key: { hypothesis_id: 'h1', lane: 'organic', channel: 'instagram', content_type: 'figur.bitmis_urun' }, alpha: 1, beta: 1, weight: 1 }, evidence: [] }], lane_performance: [], spend_vs_cap: [], trends: [], judgments: [] },
    bindings: [],
  };
}
const detail = (check?: unknown) => ({
  slot,
  piece: { text: 'Kadıköy atölyemizden', media: [{ kind: 'file', id: 'file-m1' }], adaptations: {} },
  hypothesis: h,
  brand_rules: { identity: { voice: 'Sıcak' }, prohibitions: [] },
  learned: { id: 'a1', key: { hypothesis_id: 'h1', lane: 'organic', channel: 'instagram', content_type: 'x' }, alpha: 1, beta: 1, weight: 1 },
  attempts: [],
  measurements: [],
  ...(check ? { material_check: check } : {}),
});
const base = {
  ...materialsAnswers,
  'GET /api/work/pending': { items: [], agent: { overdue: false, interval_minutes: 60, last_seen_at: null }, strategy: { approved: { number: 3 } } },
  'GET /api/studio/slots/s1': detail(),
};

describe('Material check hold component', () => {
  it.each([
    ['other_olay', 'Bu materyal başka bir olaya ait.'],
    ['out_of_season', 'Sezon penceresinin dışında.'],
    ['share_unset', 'Paylaşım izni verilmedi.'],
    ['no_material', 'Bu parça hiçbir materyale dayanmıyor.'],
    ['olay_unconfirmed', 'Bağlı olduğu olay henüz onaylanmadı.'],
    ['names_other_olay', 'Metin başka bir olayın adını, yerini veya müşterisini anıyor.'],
  ])('says %s in plain Turkish', async (code, sentence) => {
    mockFetch({
      ...base,
      'GET /api/studio/overview': overview([{ kind: 'hard', code, material_id: 'm1' }]),
    });
    renderMaterialHold();
    const hold = await screen.findByTestId('material-hold-s1');
    expect(within(hold).getByText('Materyal kontrolü bu içeriği durduruyor')).toBeInTheDocument();
    expect(within(hold).getByText(sentence, { exact: false })).toBeInTheDocument();
    expect(within(hold).getByRole('link', { name: 'Materyali aç' })).toHaveAttribute(
      'href',
      '/materials?view=olays&material=m1',
    );
  });

  it('has a sentence for every finding code, in Turkish and English', () => {
    for (const code of FINDING_CODES) {
      expect(tr.materials.finding[code]).toBeTruthy();
      expect(en.materials.finding[code]).toBeTruthy();
    }
  });

  it('names how many çekim listesi requests are open, with the way there', async () => {
    mockFetch({
      ...base,
      'GET /api/studio/overview': overview([{ kind: 'hard', code: 'no_eligible_material' }], 'fix_piece', [
        shoot('r1'),
        shoot('r2'),
      ]),
    });
    const { router } = renderMaterialHold();
    const hold = await screen.findByTestId('material-hold-s1');
    expect(within(hold).getByText(/Çekim listesinde 2 açık istek var\./)).toBeInTheDocument();
    // A hard finding is never released.
    expect(within(hold).queryByRole('button', { name: 'Metni bu hâliyle yayınla' })).not.toBeInTheDocument();
    await userEvent.click(within(hold).getByRole('link', { name: 'Çekim listesini aç' }));
    await screen.findByTestId('materials-shoots');
    expect(router.state.location.search).toBe('?view=shoots');
  });

  it('lets an owner release caption findings with the digest the check shows', async () => {
    const digest = 'a'.repeat(64);
    const calls = mockFetch({
      ...base,
      'GET /api/studio/overview': overview(
        [{ kind: 'caption', code: 'date_outside_olay', matched: '16 kasım', olay_id: 'o1' }],
        'fix_piece_or_release',
      ),
      'GET /api/studio/slots/s1': detail({
        revision: 4,
        findings: [{ code: 'date_outside_olay', olay_id: 'o1', matched: '16 kasım' }],
        digest,
        released: false,
        hard: [],
        holds: true,
      }),
      'POST /api/studio/slots/s1/material-check/release': detail(),
    });
    renderMaterialHold();
    const hold = await screen.findByTestId('material-hold-s1');
    expect(within(hold).getByText(/Metindeki tarih olayın günlerinin dışında\. \(“16 kasım”\)/)).toBeInTheDocument();
    await userEvent.click(await within(hold).findByRole('button', { name: 'Metni bu hâliyle yayınla' }));
    const dialog = await screen.findByRole('dialog', { name: 'Metin bu hâliyle yayınlansın mı?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Yayınlanabilir' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/studio/slots/s1/material-check/release')?.body).toEqual({
        expected_revision: 4,
        digest,
      }),
    );
  });

  it('offers no release to a member who is no owner or manager', async () => {
    mockFetch({
      ...base,
      'GET /api/auth/me': repMe,
      'GET /api/studio/overview': overview([{ kind: 'caption', code: 'archive_year_missing', matched: '2025' }], 'fix_piece_or_release'),
      'GET /api/studio/slots/s1': detail({ revision: 4, findings: [{ code: 'archive_year_missing', matched: '2025' }], digest: 'b'.repeat(64), released: false, hard: [], holds: true }),
    });
    renderMaterialHold();
    const hold = await screen.findByTestId('material-hold-s1');
    expect(within(hold).getByText(/olayın yılı metinde geçmiyor/)).toBeInTheDocument();
    expect(within(hold).queryByRole('button', { name: 'Metni bu hâliyle yayınla' })).not.toBeInTheDocument();
  });
});
