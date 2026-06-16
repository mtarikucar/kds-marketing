import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import AnalyticsPage from './AnalyticsPage';
import { SegmentedControl } from '../../../components/ui/SegmentedControl';

// ── mock marketingApi ─────────────────────────────────────────────────────────

vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: null }),
  },
}));

// ── mock auth store ───────────────────────────────────────────────────────────

vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: () => ({
    user: { role: 'MANAGER', name: 'Test Manager' },
  }),
}));

// ── helpers ───────────────────────────────────────────────────────────────────

function renderPage(initialTab = 'funnel') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // MemoryRouter initialEntries sets the path; the page renders whichever tab
  // is default. To land on attribution directly, we rely on the page's own
  // default state — we click the tab trigger in the test.
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <AnalyticsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('AnalyticsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mounts and shows the page header', () => {
    renderPage();
    expect(screen.getByText('Analytics')).toBeDefined();
  });

  it('renders tab list with all manager tabs', () => {
    renderPage();
    expect(screen.getByText('Funnel')).toBeDefined();
    expect(screen.getByText('By Source')).toBeDefined();
    expect(screen.getByText('By Business Type')).toBeDefined();
    expect(screen.getByText('Rep Performance')).toBeDefined();
    expect(screen.getByText('Attribution')).toBeDefined();
  });

  it('attribution model toggle — SegmentedControl renders and switches selection', () => {
    // Test the SegmentedControl component (used by the attribution tab) directly
    // since Radix Tabs only mounts active tab content in the DOM.
    const options = [
      { value: 'first' as const, label: 'First-touch' },
      { value: 'last' as const, label: 'Last-touch' },
      { value: 'linear' as const, label: 'Linear' },
    ];
    let selected: 'first' | 'last' | 'linear' = 'last';
    const onChange = vi.fn((v: 'first' | 'last' | 'linear') => { selected = v; });

    const { rerender } = render(
      <SegmentedControl
        options={options}
        value={selected}
        onChange={onChange}
        aria-label="Attribution model"
      />,
    );

    const lastBtn = screen.getByText('Last-touch').closest('button')!;
    const firstBtn = screen.getByText('First-touch').closest('button')!;
    expect(lastBtn.getAttribute('aria-pressed')).toBe('true');
    expect(firstBtn.getAttribute('aria-pressed')).toBe('false');

    // Simulate switching to first-touch
    fireEvent.click(firstBtn);
    expect(onChange).toHaveBeenCalledWith('first');

    rerender(
      <SegmentedControl
        options={options}
        value={selected}
        onChange={onChange}
        aria-label="Attribution model"
      />,
    );
    expect(screen.getByText('First-touch').closest('button')?.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Last-touch').closest('button')?.getAttribute('aria-pressed')).toBe('false');
  });
});
