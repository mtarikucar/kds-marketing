import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation, useNavigationType } from 'react-router-dom';
import StudioOneScreen from './StudioOneScreen';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => (typeof d === 'string' ? d : k), i18n: { language: 'tr' } }),
}));

// The panels, the accounts list, the drawer and the idea surface are each their
// own reviewed unit with their own tests. What is under test HERE is the
// arrangement: which regions exist, which panel is in which, how much room each
// one gets, and that the two overlays are driven by the URL.
vi.mock('./AccountStatsPanel', () => ({
  default: ({ range, from, to }: { range: number; from: string; to: string }) => (
    <div>
      stats-panel|{range}|{from}|{to}
    </div>
  ),
}));
vi.mock('./IdeasPanel', () => ({ default: () => <div>ideas-panel</div> }));
vi.mock('./TodayQueuePanel', () => ({ default: () => <div>today-panel</div> }));
vi.mock('./IdeaDetail', () => ({
  default: ({ ideaId, onClose }: { ideaId: string; onClose: () => void }) => (
    <div>
      idea-detail:{ideaId}
      <button type="button" onClick={onClose}>
        close-idea
      </button>
    </div>
  ),
}));
vi.mock('./ConnectedAccountsList', () => ({
  ConnectedAccountsList: ({ from, to }: { from: string; to: string }) => (
    <div>
      accounts-list|{from}|{to}
    </div>
  ),
}));
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
  // The navigation TYPE is load-bearing here: `?tool=` is a mode you toggle and
  // replaces, `?idea=` is navigation and pushes, so the back button is the way
  // out of an idea and not out of the Studio.
  const type = useNavigationType();
  return (
    <output data-testid="loc">
      {loc.search}|{type}
    </output>
  );
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
 * istatistikleri, altında da kampanya fikirleri", plus the re-weighting they
 * asked for afterwards: "içeriklerin boyutu ile kapladıkları alan içeriğin
 * önemine göre doğru değil… fikirler büyüsün… istatistikler de belirli yer
 * kaplasın".
 *
 * These assertions are deliberately about ARRANGEMENT and about the ONE class
 * that carries an argument (how much room a region gets), not about markup in
 * general. A future refactor is free to change every other class name here;
 * what it may not do is put the ideas back behind a tab, or give the stats block
 * the screen back.
 */
describe('StudioOneScreen', () => {
  it('shows all three regions at once — nothing is behind a tab', async () => {
    renderAt('/studio');

    expect(await screen.findByText(/^today-panel/)).toBeInTheDocument();
    expect(screen.getByText(/^stats-panel/)).toBeInTheDocument();
    expect(screen.getByText(/^ideas-panel/)).toBeInTheDocument();
    // The old surface's tab strip is the thing being replaced; if one reappears
    // at this level the screen has quietly become a hub again.
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('puts the accounts list in the top strip, between the console and the tools', async () => {
    renderAt('/studio');
    await screen.findByText(/^today-panel/);

    const bar = screen.getByRole('button', { name: 'autopilot-bar' });
    const list = screen.getByText(/^accounts-list/);
    // The owner asked for the list to live next to the autopilot console, not
    // inside the stats panel where it used to be.
    expect(bar.parentElement).toBe(list.parentElement);
    expect(screen.getByTestId('studio-stats')).not.toContainElement(list);
    expect(bar.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('puts the queue on the right and the stats above the ideas on the left', async () => {
    renderAt('/studio');
    await screen.findByText(/^today-panel/);

    const stats = screen.getByTestId('studio-stats');
    const ideas = screen.getByTestId('studio-ideas');
    const today = screen.getByTestId('studio-today');

    expect(stats).toContainElement(screen.getByText(/^stats-panel/));
    expect(ideas).toContainElement(screen.getByText(/^ideas-panel/));
    expect(today).toContainElement(screen.getByText(/^today-panel/));

    // Stats and ideas share a parent (the left column); the queue does not —
    // it is the sibling column. `compareDocumentPosition` also pins the
    // stats-then-ideas order, which is the "ikiye böl, üstte istatistik" half.
    expect(stats.parentElement).toBe(ideas.parentElement);
    expect(today.parentElement).not.toBe(stats.parentElement);
    expect(stats.compareDocumentPosition(ideas) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /**
   * The re-weighting, asserted rather than described.
   *
   * The first version gave the stats block three fifths of the left column and
   * the queue a fixed 380px rail — area allocated by how much content a region
   * had rather than by how much it mattered, on a screen whose emptiest region
   * was the stats. If any of these three go back, so does the defect.
   */
  it('caps the stats band, lets the ideas grow, and stops the queue being a rail', async () => {
    renderAt('/studio');
    await screen.findByText(/^today-panel/);

    const stats = screen.getByTestId('studio-stats');
    const ideas = screen.getByTestId('studio-ideas');
    const today = screen.getByTestId('studio-today');

    // A defined band that cannot grow: three slots is all it will ever hold.
    expect(stats.className).toMatch(/lg:h-\d/);
    expect(stats.className).not.toMatch(/flex-/);
    // The ideas take everything the band gave up.
    expect(ideas.className).toMatch(/flex-1/);
    // Peers, not a column and a rail. The queue is what the screen is for.
    expect(today.className).not.toMatch(/w-\[380px\]/);
    expect(today.className).toMatch(/lg:flex-1/);
    expect(ideas.parentElement!.className).toMatch(/lg:flex-1/);
  });

  /**
   * One window, computed once, handed to both readers of it.
   *
   * The stats band's range control and the top strip's account popovers key the
   * same insights query on the same `from`/`to`. Two components each computing
   * their own would eventually disagree across a UTC midnight and fork the
   * cache — two identical requests, and two regions describing two windows.
   */
  it('hands the same window to the stats band and to the accounts list', async () => {
    renderAt('/studio');

    const stats = (await screen.findByText(/^stats-panel/)).textContent!;
    const list = screen.getByText(/^accounts-list/).textContent!;
    const [, range, from, to] = stats.split('|');
    expect(range).toBe('30');
    expect(list).toBe(`accounts-list|${from}|${to}`);
  });

  it('keeps the drawer closed until the URL asks for a tool', async () => {
    renderAt('/studio');
    await screen.findByText(/^today-panel/);
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
    await screen.findByText(/^today-panel/);
    expect(screen.queryByText(/^drawer:/)).not.toBeInTheDocument();
  });

  it('the autopilot bar opens the console drawer and writes it to the URL', async () => {
    const user = userEvent.setup();
    renderAt('/studio');
    await screen.findByText(/^today-panel/);

    await user.click(screen.getByRole('button', { name: 'autopilot-bar' }));

    expect(await screen.findByText('drawer:autopilot')).toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent('tool=autopilot');
  });

  it('opens an idea straight from a ?idea= deep link, without losing the screen', async () => {
    renderAt('/studio?idea=act-7');

    expect(await screen.findByText('idea-detail:act-7')).toBeInTheDocument();
    // A layer over the work, not a route that replaces it: the three panels are
    // still mounted, so closing the idea costs no re-fetch and loses no scroll.
    expect(screen.getByText(/^today-panel/)).toBeInTheDocument();
    expect(screen.getByText(/^ideas-panel/)).toBeInTheDocument();
  });

  /**
   * The idea TAKES the work area; it does not stack under it.
   *
   * `flex-1` columns beside an `h-full` sibling shrink to nothing, and three
   * cards at zero height do not vanish — their padding keeps a border's worth of
   * each, which then paints down over the idea. Below `lg` there is no height to
   * fight over and the idea simply landed after the whole screen, so tapping a
   * row looked like it had done nothing. Hidden, never unmounted: closing has to
   * stay free.
   */
  it('gives the idea the work area instead of stacking it under the screen', async () => {
    renderAt('/studio?idea=act-7');
    await screen.findByText('idea-detail:act-7');

    expect(screen.getByTestId('studio-work').className.split(' ')).toContain('hidden');
    expect(screen.getByTestId('studio-idea').className).toMatch(/flex-1/);
  });

  it('leaves the work area in the flow when no idea is open', async () => {
    renderAt('/studio');
    await screen.findByText(/^today-panel/);

    expect(screen.getByTestId('studio-work').className.split(' ')).not.toContain('hidden');
    expect(screen.queryByTestId('studio-idea')).not.toBeInTheDocument();
  });

  it('mounts nothing for a blank ?idea=', async () => {
    // `?idea=` and `?idea=%20` are the two shapes a hand-edited or truncated
    // link arrives in, and neither is an id. Mounting the detail on one would
    // put a "not found" over a screen the reader never asked to leave.
    renderAt('/studio?idea=%20%20');
    await screen.findByText(/^today-panel/);
    expect(screen.queryByText(/^idea-detail:/)).not.toBeInTheDocument();

    renderAt('/studio?idea=');
    expect(screen.queryByText(/^idea-detail:/)).not.toBeInTheDocument();
  });

  it('closes the idea by PUSHING, so the back button is the way out of it', async () => {
    const user = userEvent.setup();
    renderAt('/studio?idea=act-7');
    await screen.findByText('idea-detail:act-7');

    await user.click(screen.getByRole('button', { name: 'close-idea' }));

    expect(screen.queryByText(/^idea-detail:/)).not.toBeInTheDocument();
    // PUSH, not REPLACE. A replace here would send Back to whatever preceded
    // the Studio rather than to the idea the reader just closed — and the ideas
    // panel opens these with a real <Link>, so Back is where people will look.
    expect(screen.getByTestId('loc')).toHaveTextContent('|PUSH');
    expect(screen.getByTestId('loc')).not.toHaveTextContent('idea=');
  });

  it('closes the drawer by REPLACING, so six tools are not six history entries', async () => {
    const user = userEvent.setup();
    renderAt('/studio');
    await screen.findByText(/^today-panel/);

    await user.click(screen.getByRole('button', { name: 'autopilot-bar' }));
    await screen.findByText('drawer:autopilot');

    expect(screen.getByTestId('loc')).toHaveTextContent('|REPLACE');
  });
});
