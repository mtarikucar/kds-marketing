import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import MarketingSidebar from './MarketingSidebar';
import MarketingHeader from './MarketingHeader';
import HubSubNav from './HubSubNav';
import SettingsLayout from './SettingsLayout';
import AskAiPanel from './AskAiPanel';
import CommandPalette from './CommandPalette';
import ProductTour from './ProductTour';
import { AgencyImpersonationBanner } from './AgencyImpersonationBanner';
import WebphoneHost from '../webphone/WebphoneHost';
import { ErrorBoundary } from '../../../components/ErrorBoundary';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/Sheet';
import { NAV_HUBS, findActiveHub, findActiveChild } from '../navigation';
import { useCommandPaletteStore } from '../../../store/commandPaletteStore';
import { usePageViewTracking } from '../hooks/usePageViewTracking';

export default function MarketingLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();
  const toggleCommandPalette = useCommandPaletteStore((s) => s.toggle);

  // Which screens actually get opened — the evidence the next round of
  // page-retiring has to rest on. Anonymous and aggregate; see the hook.
  usePageViewTracking();

  // Area detection is structural (no gating needed) — the active hub's `area`,
  // minus the pages that opt out of the settings chrome. A `fullBleed` item is
  // a settings page everywhere EXCEPT here: the workflow builder is a
  // viewport-height canvas, and the settings pane is a bare `overflow-y-auto`
  // column beside a 240px sidebar, which would render it as a canvas in a
  // letterbox. Giving that pane `h-full` would fix the height and leave the
  // canvas jammed next to the sidebar, so the page leaves the area instead.
  const isSettings =
    findActiveHub(NAV_HUBS, location.pathname)?.area === 'settings' &&
    !findActiveChild(NAV_HUBS, location.pathname)?.fullBleed;

  // Global command palette shortcut (Cmd/Ctrl+K) — a deliberate app-wide
  // override, so it fires even while a form field is focused (like Slack/Linear).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        toggleCommandPalette();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleCommandPalette]);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar - desktop (static, hidden below lg) */}
      <div className="hidden lg:block">
        <MarketingSidebar />
      </div>

      {/* Sidebar - mobile (Sheet drawer, hidden on lg+) */}
      <div className="lg:hidden">
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent side="left" hideClose className="w-64 max-w-[85vw] p-0">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SheetDescription className="sr-only">Main navigation menu</SheetDescription>
            <MarketingSidebar onNavigate={() => setSidebarOpen(false)} forceExpanded />
          </SheetContent>
        </Sheet>
      </div>

      {/* Main content */}
      <div className="flex min-w-0 min-h-0 flex-1 flex-col">
        <AgencyImpersonationBanner />
        <MarketingHeader onMenuClick={() => setSidebarOpen(true)} />
        {/* Hub sub-nav (sibling pages of the active hub) — not in the Settings area. */}
        {!isSettings && <HubSubNav />}
        <main className="min-h-0 flex-1 overflow-hidden bg-background">
          <ErrorBoundary key={location.pathname}>
            {isSettings ? (
              <SettingsLayout>
                <div className="px-4 pt-4 pb-28 lg:px-6 lg:pt-6">
                  <Outlet />
                </div>
              </SettingsLayout>
            ) : (
              // Extra bottom padding so page content (e.g. a bottom-right action
              // button) clears the fixed Ask-AI + webphone widgets.
              <div className="h-full overflow-y-auto px-4 pt-4 pb-28 lg:px-6 lg:pt-6">
                <Outlet />
              </div>
            )}
          </ErrorBoundary>
        </main>
      </div>
      {/* Global command palette (Cmd/Ctrl+K) — page-jump + quick actions. */}
      <CommandPalette />
      {/* One-time guided tour (managers); relaunchable from the profile menu. */}
      <ProductTour />
      {/* Global Ask-AI slide-over (gated on the askAi feature server-side). */}
      <AskAiPanel />
      {/* App-wide webphone: keeps the rep's dahili registered on every page so
          click-to-dial actually rings. Inert when telephony isn't configured. */}
      <WebphoneHost />
    </div>
  );
}
