import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import CalendarPage from './CalendarPage';

// Mock the marketing API
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: { id: '1' } }),
  },
}));

// Suppress i18next console noise
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { returnObjects?: boolean; defaultValue?: string }) => {
      if (opts?.returnObjects && key === 'calendar.weekdayShort') {
        return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      }
      if (opts?.defaultValue) return opts.defaultValue;
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('CalendarPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mounts and renders the page header heading', () => {
    render(<CalendarPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('renders prev/next month icon buttons', () => {
    render(<CalendarPage />, { wrapper });
    expect(screen.getByRole('button', { name: /previous month/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next month/i })).toBeInTheDocument();
  });

  it('renders a Today button', () => {
    render(<CalendarPage />, { wrapper });
    expect(screen.getByRole('button', { name: /^today$/i })).toBeInTheDocument();
  });

  it('opens the DayDialog when a calendar day cell is clicked', async () => {
    render(<CalendarPage />, { wrapper });
    // Day cells have aria-label containing "task"
    const dayCells = await screen.findAllByRole('button', { name: /task/i });
    expect(dayCells.length).toBeGreaterThan(0);
    await userEvent.click(dayCells[0]);
    // Dialog title is the formatted date (a heading inside the dialog)
    // The create-task form's submit button is type="submit"
    const submitBtn = await screen.findByRole('button', { name: /^create task$/i });
    expect(submitBtn).toBeInTheDocument();
  });

  it('DayDialog shows required field validation when submitted empty', async () => {
    render(<CalendarPage />, { wrapper });
    const dayCells = await screen.findAllByRole('button', { name: /task/i });
    await userEvent.click(dayCells[0]);
    const submitBtn = await screen.findByRole('button', { name: /^create task$/i });
    await userEvent.click(submitBtn);
    // Multiple alerts can appear (title required + dueDate validation)
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
  });
});
