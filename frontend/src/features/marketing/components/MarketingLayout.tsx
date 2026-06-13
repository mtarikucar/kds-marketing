import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import MarketingSidebar from './MarketingSidebar';
import MarketingHeader from './MarketingHeader';
import AskAiPanel from './AskAiPanel';
import { ErrorBoundary } from '../../../components/ErrorBoundary';
import { Bars3Icon, XMarkIcon } from '@heroicons/react/24/outline';

export default function MarketingLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar - desktop */}
      <div className="hidden lg:block">
        <MarketingSidebar />
      </div>

      {/* Sidebar - mobile */}
      <div
        className={`fixed inset-y-0 left-0 z-50 transform lg:hidden transition-transform duration-300 ease-in-out ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <MarketingSidebar onNavigate={() => setSidebarOpen(false)} />
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <div className="flex items-center lg:hidden px-4 py-3 border-b bg-white">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-2 rounded-lg hover:bg-gray-100"
          >
            {sidebarOpen ? (
              <XMarkIcon className="w-5 h-5" />
            ) : (
              <Bars3Icon className="w-5 h-5" />
            )}
          </button>
        </div>
        <MarketingHeader />
        <main className="flex-1 min-h-0 p-4 lg:p-6 overflow-y-auto">
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
