import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { enrollmentsKey, useEnrollments, useLeadEnrollments } from './hooks';

const get = vi.fn();
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: { get: (...a: unknown[]) => get(...a) },
}));

const COURSE_ROW = { id: 'en-course', courseId: 'c1', leadId: 'other', progressPct: 90 };
const LEAD_ROW = { id: 'en-lead', courseId: 'c1', leadId: 'p1', progressPct: 40 };

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const testClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => {
  get.mockReset();
  get.mockImplementation((_url: string, cfg?: { params?: { leadId?: string } }) =>
    Promise.resolve({ data: cfg?.params?.leadId ? [LEAD_ROW] : [COURSE_ROW] }),
  );
});

/**
 * `GET /enrollments` takes EITHER filter, and the two callers must never be
 * served each other's answer.
 *
 * `enrollmentsKey` is `{ courseId: courseId ?? null }`. Widening it to hold both
 * filters — the obvious way to add a per-person read — would put two different
 * result sets under one cache entry: the course editor's Enrollees panel asks
 * for `{courseId: 'c1'}` and the record card's Eğitimler section asks for
 * `{leadId: 'p1'}`, and a shared shape lets either answer stand in for the
 * other's question.
 */
describe('useLeadEnrollments', () => {
  it('asks the same route with the leadId filter', async () => {
    const qc = testClient();
    const { result } = renderHook(() => useLeadEnrollments('p1'), { wrapper: wrap(qc) });

    await waitFor(() => expect(result.current.data).toEqual([LEAD_ROW]));
    expect(get).toHaveBeenCalledWith('/enrollments', { params: { leadId: 'p1' } });
  });

  it('asks for nothing when nobody is selected', () => {
    const qc = testClient();
    renderHook(() => useLeadEnrollments(null), { wrapper: wrap(qc) });
    expect(get).not.toHaveBeenCalled();
  });

  /**
   * The cross-pollution this key shape exists to prevent, in the only form it
   * could ever be observed: a warm course-scoped entry must not answer the
   * person-scoped question.
   */
  it('does not serve the course editor’s cached rows to the person’s section', async () => {
    const qc = testClient();
    // The course editor has been here first.
    qc.setQueryData(enrollmentsKey('c1'), [COURSE_ROW]);

    const { result } = renderHook(() => useLeadEnrollments('p1'), { wrapper: wrap(qc) });

    await waitFor(() => expect(result.current.data).toEqual([LEAD_ROW]));
    // …and the course editor's own entry is untouched by the person's read.
    expect(qc.getQueryData(enrollmentsKey('c1'))).toEqual([COURSE_ROW]);
  });

  it('leaves the course-scoped hook reading by courseId', async () => {
    const qc = testClient();
    const { result } = renderHook(() => useEnrollments('c1'), { wrapper: wrap(qc) });

    await waitFor(() => expect(result.current.data).toEqual([COURSE_ROW]));
    expect(get).toHaveBeenCalledWith('/enrollments', { params: { courseId: 'c1' } });
  });
});
