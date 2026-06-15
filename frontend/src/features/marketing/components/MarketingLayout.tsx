import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Menu } from 'lucide-react';
import MarketingSidebar from './MarketingSidebar';
import MarketingHeader from './MarketingHeader';
import AskAiPanel from './AskAiPanel';
import { ErrorBoundary } from '../../../components/ErrorBoundary';
import { IconButton } from '@/components/ui/IconButton';
import { Sheet, SheetContent } from '@/components/ui/Sheet';

export default function MarketingLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar - desktop (static, hidden below lg) */}
      <div className="hidden lg:block">
        <MarketingSidebar />
      </div>

      {/* Sidebar - mobile (Sheet drawer, hidden on lg+) */}
      <div className="lg:hidden">
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent side="left" className="p-0">
            <MarketingSidebar onNavigate={() => setSidebarOpen(false)} />
          </SheetContent>
        </Sheet>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Mobile top bar */}
        <div className="flex items-center lg:hidden px-4 py-3 bg-surface border-b border-border">
          <IconButton
            aria-label="Open menu"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="w-5 h-5" />
          </IconButton>
        </div>
        <MarketingHeader />
        <main className="flex-1 min-h-0 p-4 lg:p-6 overflow-y-auto bg-background">
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
      {/* Global Ask-AI slide-over (gated on the askAi feature server-side). */}
      <AskAiPanel />
    </div>
  );
}
