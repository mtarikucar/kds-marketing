import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Menu } from 'lucide-react';
import MarketingSidebar from './MarketingSidebar';
import MarketingHeader from './MarketingHeader';
import HubSubNav from './HubSubNav';
import SettingsLayout from './SettingsLayout';
import AskAiPanel from './AskAiPanel';
import WebphoneHost from '../webphone/WebphoneHost';
import { ErrorBoundary } from '../../../components/ErrorBoundary';
import { IconButton } from '@/components/ui/IconButton';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/Sheet';
import { NAV_HUBS, findActiveHub } from '../navigation';

export default function MarketingLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();

  // Area detection is structural (no gating needed) — the active hub's `area`.
  const isSettings = findActiveHub(NAV_HUBS, location.pathname)?.area === 'settings';

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
            <MarketingSidebar onNavigate={() => setSidebarOpen(false)} />
          </SheetContent>
        </Sheet>
      </div>

      {/* Main content */}
      <div className="flex min-w-0 min-h-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <div className="flex items-center border-b border-border bg-surface px-4 py-3 lg:hidden">
          <IconButton aria-label="Open menu" onClick={() => setSidebarOpen(true)}>
            <Menu className="h-5 w-5" />
          </IconButton>
        </div>
        <MarketingHeader />
        {/* Hub sub-nav (sibling pages of the active hub) — not in the Settings area. */}
        {!isSettings && <HubSubNav />}
        <main className="min-h-0 flex-1 overflow-hidden bg-background">
          <ErrorBoundary key={location.pathname}>
            {isSettings ? (
              <SettingsLayout>
                <div className="p-4 lg:p-6">
                  <Outlet />
                </div>
              </SettingsLayout>
            ) : (
              <div className="h-full overflow-y-auto p-4 lg:p-6">
                <Outlet />
              </div>
            )}
          </ErrorBoundary>
        </main>
      </div>
      {/* Global Ask-AI slide-over (gated on the askAi feature server-side). */}
      <AskAiPanel />
      {/* App-wide webphone: keeps the rep's dahili registered on every page so
          click-to-dial actually rings. Inert when telephony isn't configured. */}
      <WebphoneHost />
    </div>
  );
}
