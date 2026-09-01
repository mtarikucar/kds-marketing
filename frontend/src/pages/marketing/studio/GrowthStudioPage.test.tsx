import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import GrowthStudioPage from './GrowthStudioPage';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: string) => (typeof o === 'string' ? o : k), i18n: { language: 'tr' } }) }));
// The tool tabs are FeatureGate-wrapped; entitle everything so the shell renders
// the (stubbed) surfaces, not the upgrade callout. FeatureGate reads this hook,
// which otherwise needs a QueryClient this shell test doesn't set up.
vi.mock('@/features/marketing/hooks/useEntitlements', () => ({
  useEntitlements: () => ({ has: () => true }),
}));
// Stub the heavy surfaces so the shell renders in isolation. The one-screen is
// the default body; the rest are the ?view=tools surface.
vi.mock('./StudioOneScreen', () => ({ default: () => <div>one-screen</div> }));
const nul = { default: () => null };
vi.mock('./StudioCalendarTab', () => nul);
vi.mock('../trends/TrendsPage', () => nul);
vi.mock('../CampaignsPage', () => nul);
vi.mock('../socialCampaigns/SocialCampaignsPage', () => nul);
vi.mock('../social', () => nul);
vi.mock('../social/AiStudioPage', () => nul);
vi.mock('../personas/PersonasPage', () => nul);
vi.mock('../emailTemplates', () => nul);
vi.mock('../ReviewsPage', () => nul);
// The workspace's affiliate MANAGEMENT page. The tab used to mount the public
// token-authenticated portal instead — pinning the module path here is what
// stops that coming back.
vi.mock('../experiments/affiliates', () => nul);

function renderAt(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><GrowthStudioPage /></MemoryRouter>);
}

/**
 * 2026-08, owner-directed: /studio IS one working screen. What used to be the
 * front door — the ad-budget console, plus a "Manual tools" button hiding five
 * tabs — is gone; the Autopilot is a status bar and a drawer on that screen.
 *
 * The `?view=tools` surface survives, and this file is where that promise is
 * kept: six routes redirect into it with an exact tab/sub pair, and one of them
 * carries router state a redirect would drop. The tests below pin those URLs,
 * not the front door's old shape.
 */
describe('GrowthStudioPage', () => {
  it('renders the one-screen studio by default, with no tab bar', async () => {
    renderAt('/studio');
    expect(await screen.findByText('one-screen')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('ignores a stale ?tab= on the front door rather than opening the tools surface', async () => {
    // `?tab=budget` is a link from the shape before last. It must land somewhere
    // sensible instead of resurrecting a tab strip.
    renderAt('/studio?tab=budget');
    expect(await screen.findByText('one-screen')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('honors the ?view=tools deep link and its nested ?tab=/?sub=', () => {
    renderAt('/studio?view=tools&tab=campaigns&sub=planner');
    expect(screen.getByRole('tab', { name: 'Kampanyalar', selected: true })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Sosyal Planlayıcı' })).toHaveAttribute('data-state', 'active');
  });

  it('honors ?view=tools&tab=create defaulting to the AI Studio sub-tab', () => {
    // AiStudioPage's "add to post" navigates to ?tab=campaigns&sub=planner with
    // router state; this is the other half of that contract and the reason the
    // tools surface may not be collapsed into the drawer.
    renderAt('/studio?view=tools&tab=create');
    expect(screen.getByRole('tab', { name: 'AI Stüdyo' })).toHaveAttribute('data-state', 'active');
  });

  it('keeps all five tool tabs, and no Autopilot tab among them', () => {
    renderAt('/studio?view=tools');
    for (const label of ['İçerik Takvimi', 'Üret', 'Kampanyalar', 'Trendler', 'Diğer']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole('tab', { name: 'Autopilot' })).not.toBeInTheDocument();
  });

  it('More still offers Email/Reviews/Affiliates, not Trigger Links', () => {
    // These three now ALSO have a permanent home in Settings, but the bookmarked
    // ?tab=more&sub=… URLs keep working — nothing was moved out from under anyone.
    renderAt('/studio?view=tools&tab=more');
    expect(screen.queryByRole('tab', { name: 'Trigger Links' })).not.toBeInTheDocument();
    for (const label of ['E-posta Şablonları', 'Yorumlar', 'Ortaklar']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
  });

  it('returns from the tools surface to the one screen', async () => {
    const user = userEvent.setup();
    renderAt('/studio?view=tools&tab=trends');
    await user.click(screen.getByRole('button', { name: 'Growth Studio’ya dön' }));
    expect(await screen.findByText('one-screen')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });
});
