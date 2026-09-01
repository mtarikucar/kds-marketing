import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import StudioOneScreen from './StudioOneScreen';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => (typeof d === 'string' ? d : k), i18n: { language: 'tr' } }),
}));

// The three panels and the drawer are each their own reviewed unit with their
// own tests. What is under test HERE is the arrangement: which regions exist,
// which panel is in which, and that the drawer is driven by the URL.
vi.mock('./AccountStatsPanel', () => ({ default: () => <div>stats-panel</div> }));
vi.mock('./IdeasPanel', () => ({ default: () => <div>ideas-panel</div> }));
vi.mock('./TodayQueuePanel', () => ({ default: () => <div>today-panel</div> }));
vi.mock('./AutopilotStatusBar', () => ({
  AutopilotStatusBar: ({ onOpenConsole }: { onOpenConsole: () => void }) => (
    <button type="button" onClick={onOpenConsole}>
      autopilot-bar
    </button>
  ),
}));
vi.mock('./StudioToolsDrawer', () => ({
  StudioToolsDrawer: ({ open, tool }: { open: boolean; tool: string | null }) =>
    open ? <div>drawer:{tool}</div> : null,
}));

function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="loc">{loc.search}</output>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/studio"
          element={
            <>
              <StudioOneScreen />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * The shape the owner asked for, in their words: "sağda bugün neler paylaşılacak
 * onun listesi olsun, solda da ikiye böl orayı — üstte bağlı olan hesapların
 * istatistikleri, altında da kampanya fikirleri".
 *
 * These assertions are deliberately about ARRANGEMENT rather than markup: which
 * region holds which panel, and that all three are on screen at once. A future
 * refactor is free to change every class name here; what it may not do is put
 * the ideas back behind a tab, which is the thing this screen exists to undo.
 */
describe('StudioOneScreen', () => {
  it('shows all three regions at once — nothing is behind a tab', async () => {
    renderAt('/studio');

    expect(await screen.findByText('today-panel')).toBeInTheDocument();
    expect(screen.getByText('stats-panel')).toBeInTheDocument();
    expect(screen.getByText('ideas-panel')).toBeInTheDocument();
    // The old surface's tab strip is the thing being replaced; if one reappears
    // at this level the screen has quietly become a hub again.
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('puts the queue on the right and the stats above the ideas on the left', async () => {
    renderAt('/studio');
    await screen.findByText('today-panel');

    const stats = screen.getByTestId('studio-stats');
    const ideas = screen.getByTestId('studio-ideas');
    const today = screen.getByTestId('studio-today');

    expect(stats).toContainElement(screen.getByText('stats-panel'));
    expect(ideas).toContainElement(screen.getByText('ideas-panel'));
    expect(today).toContainElement(screen.getByText('today-panel'));

    // Stats and ideas share a parent (the left column); the queue does not —
    // it is the sibling column. `compareDocumentPosition` also pins the
    // stats-then-ideas order, which is the "ikiye böl, üstte istatistik" half.
    expect(stats.parentElement).toBe(ideas.parentElement);
    expect(today.parentElement).not.toBe(stats.parentElement);
    expect(stats.compareDocumentPosition(ideas) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the drawer closed until the URL asks for a tool', async () => {
    renderAt('/studio');
    await screen.findByText('today-panel');
    expect(screen.queryByText(/^drawer:/)).not.toBeInTheDocument();
  });

  it('opens the drawer straight from a ?tool= deep link', async () => {
    // The drawer lives in the URL so the old ?view=tools links, the rest of the
    // app, and the back button can all reach it — a useState could do none of those.
    renderAt('/studio?tool=calendar');
    expect(await screen.findByText('drawer:calendar')).toBeInTheDocument();
  });

  /**
   * This array is what VALIDATES `?tool=`, and a value missing from it does not
   * error — it falls through to `null` and the drawer opens on the Autopilot
   * console. So a tool added to the drawer's union but forgotten here is a link
   * that silently opens the wrong thing, with no type error anywhere.
   */
  it.each(['money', 'ops', 'audience'])('resolves ?tool=%s to that tool, not the fallback', async (tool) => {
    renderAt(`/studio?tool=${tool}`);
    expect(await screen.findByText(`drawer:${tool}`)).toBeInTheDocument();
  });

  it('ignores a ?tool= value that is not a real tool', async () => {
    renderAt('/studio?tool=not-a-tool');
    await screen.findByText('today-panel');
    expect(screen.queryByText(/^drawer:/)).not.toBeInTheDocument();
  });

  it('the autopilot bar opens the console drawer and writes it to the URL', async () => {
    const user = userEvent.setup();
    renderAt('/studio');
    await screen.findByText('today-panel');

    await user.click(screen.getByRole('button', { name: 'autopilot-bar' }));

    expect(await screen.findByText('drawer:autopilot')).toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent('tool=autopilot');
  });
});
