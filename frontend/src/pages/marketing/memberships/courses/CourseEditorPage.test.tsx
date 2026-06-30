import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import CourseEditorPage from './CourseEditorPage';
import marketingApi from '../../../../features/marketing/api/marketingApi';

vi.mock('../../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'en' },
  }),
}));

const baseCourse = {
  id: 'c1',
  workspaceId: 'w1',
  title: 'Test course',
  slug: 'test-course',
  description: null,
  status: 'DRAFT',
  priceCents: null,
  currency: null,
  coverImageUrl: null,
  position: 0,
  createdAt: '',
  updatedAt: '',
};

function renderEditor() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/memberships/courses/c1']}>
        <Routes>
          <Route path="/memberships/courses/:id" element={<CourseEditorPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const mockGet = marketingApi.get as unknown as ReturnType<typeof vi.fn>;

describe('CourseEditorPage — publish guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Enrollments list (the editor may query it lazily) — return empty.
    mockGet.mockImplementation((url: string) => {
      if (url === '/enrollments') return Promise.resolve({ data: [] });
      return Promise.resolve({ data: { ...baseCourse, modules: [] } });
    });
  });

  it('disables Publish when the course has zero lessons', async () => {
    mockGet.mockResolvedValue({ data: { ...baseCourse, modules: [] } });
    renderEditor();
    const publish = await screen.findByRole('button', { name: /^publish$/i });
    expect(publish).toBeDisabled();
  });

  it('enables Publish once the course has at least one lesson', async () => {
    mockGet.mockResolvedValue({
      data: {
        ...baseCourse,
        modules: [
          {
            id: 'm1',
            courseId: 'c1',
            title: 'Module 1',
            position: 0,
            createdAt: '',
            updatedAt: '',
            lessons: [
              {
                id: 'l1',
                moduleId: 'm1',
                title: 'Lesson 1',
                type: 'VIDEO',
                content: null,
                videoUrl: null,
                durationSec: null,
                isPreview: false,
                position: 0,
                createdAt: '',
                updatedAt: '',
              },
            ],
          },
        ],
      },
    });
    renderEditor();
    const publish = await screen.findByRole('button', { name: /^publish$/i });
    expect(publish).toBeEnabled();
  });
});

describe('CourseEditorPage — add-module double-submit guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockImplementation((url: string) =>
      url === '/enrollments'
        ? Promise.resolve({ data: [] })
        : Promise.resolve({ data: { ...baseCourse, modules: [] } }),
    );
    // The add-module POST never resolves → it stays pending while we re-press Enter.
    (marketingApi.post as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise(() => {}),
    );
  });

  it('does not add the same module twice on Enter while the first POST is in flight', async () => {
    const user = userEvent.setup();
    renderEditor();
    const input = await screen.findByPlaceholderText(/getting started/i);
    await user.type(input, 'Intro');
    await user.keyboard('{Enter}'); // first add → pending
    await user.keyboard('{Enter}'); // second Enter while pending → must be ignored
    expect(marketingApi.post).toHaveBeenCalledTimes(1);
  });
});
