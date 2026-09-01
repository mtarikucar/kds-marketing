import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import CalendarPage from './CalendarPage';

// Mock the marketing API. A spy rather than a fixed value, so a test can serve
// a month's tasks — or refuse to.
const getMock = vi.fn();
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...args: unknown[]) => getMock(...args),
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
    getMock.mockResolvedValue({ data: [] });
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


/**
 * The month calendar as the person surface's **Takvim** view (2026-09-01
 * design, stage 2).
 *
 * ## Why this page and not `/appointments`
 *
 * "Takvim" could have meant either. `/appointments` is
 * `@MarketingRoles('MANAGER')` + `@RequiresFeature('funnels')` on
 * `MarketingBookingController`, and `navigation.ts` marks it `managerOnly` with
 * `feature: 'funnels'` to match — so sourcing the tab from there would put a
 * whole VIEW of the surface behind a role a rep cannot buy out of and a plan
 * line most workspaces have not bought. `/tasks/calendar` carries neither gate
 * (MarketingTasksController has no @MarketingRoles and no @RequiresFeature on
 * the read path; the backend scopes a REP to their own rows instead), so every
 * user who can reach the surface can reach this view. The person's RANDEVULAR
 * still live on the record card, behind their two gates, exactly as stage 1
 * shipped them.
 */
describe('CalendarPage — embedded as the surface Takvim view', () => {
  const today = new Date();
  const key = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const DUE = `${key(new Date(today.getFullYear(), today.getMonth(), 15))}T09:00:00`;

  const TASK = {
    id: 'ct1',
    title: 'Randevu hatırlat',
    type: 'CALL',
    priority: 'HIGH',
    status: 'PENDING',
    dueDate: DUE,
    assignedTo: null,
    lead: { id: 'lead-1', businessName: 'Acme Kafe' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getMock.mockImplementation((url: string) => {
      if (url === '/tasks/calendar') return Promise.resolve({ data: [TASK] });
      return Promise.resolve({ data: [] });
    });
  });

  it('drops its own page chrome and keeps the month', async () => {
    render(<CalendarPage embedded />, { wrapper });

    expect(await screen.findByTestId('calendar-agenda')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  /**
   * Tailwind v3, no container queries: `CalendarGrid` is `hidden md:block`, and
   * `md:` reads the VIEWPORT — so inside a 40%-wide column on a desktop the
   * seven-column grid still renders, at about 85px a cell, with every task
   * title truncated to nothing. The agenda is the same month, the same day
   * click into the same dialog, and MORE tasks per day (the grid caps at three
   * plus a "+n more"). `/calendar` keeps the grid.
   */
  it('lays the month out as an agenda, not a seven-column grid', async () => {
    render(<CalendarPage embedded />, { wrapper });

    await screen.findByTestId('calendar-agenda');
    expect(screen.queryByTestId('calendar-grid')).not.toBeInTheDocument();
  });

  it('keeps the grid on the standalone page', async () => {
    render(<CalendarPage />, { wrapper });
    expect(await screen.findByTestId('calendar-grid')).toBeInTheDocument();
  });

  it('still edits — a day opens the dialog that creates a task on it', async () => {
    render(<CalendarPage embedded />, { wrapper });

    const agenda = await screen.findByTestId('calendar-agenda');
    await userEvent.click(within(agenda).getAllByRole('button')[0]);

    expect(await screen.findByRole('button', { name: /^create task$/i })).toBeInTheDocument();
  });

  it('still moves between months', async () => {
    render(<CalendarPage embedded />, { wrapper });
    await screen.findByTestId('calendar-agenda');
    getMock.mockClear();

    await userEvent.click(screen.getByRole('button', { name: /previous month/i }));

    await waitFor(() => expect(getMock).toHaveBeenCalledWith('/tasks/calendar', expect.anything()));
  });

  /**
   * The point of the view. A task on the calendar names a person, and clicking
   * that task opens their conversation in the middle column.
   */
  it('reports the person behind a task up to the surface', async () => {
    const onSelectPerson = vi.fn();
    render(<CalendarPage embedded onSelectPerson={onSelectPerson} />, { wrapper });

    await userEvent.click(await screen.findByTestId('calendar-task-ct1'));

    expect(onSelectPerson).toHaveBeenCalledWith(expect.objectContaining({ id: 'lead-1' }));
  });

  it('marks the person the surface has open', async () => {
    render(
      <CalendarPage embedded onSelectPerson={vi.fn()} selectedLeadId="lead-1" />,
      { wrapper },
    );

    expect(await screen.findByTestId('calendar-task-ct1')).toHaveAttribute('aria-current', 'true');
  });

  /**
   * The repo's central rule, and this page did not follow it either: the query
   * read only `isLoading`, so a failed /tasks/calendar drew an EMPTY month.
   * "Nothing due" and "we could not read your month" are the two answers a
   * calendar most needs to keep apart.
   */
  it('says the month could not be read rather than drawing it empty', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/tasks/calendar') return Promise.reject(new Error('boom'));
      return Promise.resolve({ data: [] });
    });
    render(<CalendarPage embedded />, { wrapper });

    // Positive anchor first — the absence below would pass instantly against a
    // month that is merely still loading.
    expect(await screen.findByText('Could not load the calendar.')).toBeInTheDocument();
    expect(screen.queryByTestId('calendar-agenda')).not.toBeInTheDocument();
  });
});
