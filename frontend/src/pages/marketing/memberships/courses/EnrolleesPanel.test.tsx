import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnrolleesPanel } from './EnrolleesPanel';

// The enroll dialog (always mounted) pulls useLeadOptions from ../hooks — stub it
// out; this test only exercises the per-lesson mark-complete buttons.
vi.mock('./EnrollDialog', () => ({ EnrollDialog: () => null }));

// completeLesson is a SINGLE shared mutation; the per-lesson "Mark complete" button
// must scope its disabled state by the in-flight lesson id, or marking one lesson
// freezes the button on EVERY other not-done/unlocked lesson (per-row loading bleed).
vi.mock('../hooks', () => ({
  useEnrollments: () => ({
    data: [{ id: 'e1', leadId: 'lead-1', status: 'ACTIVE', progressPct: 0 }],
    isLoading: false,
  }),
  useEnrollmentProgress: () => ({
    data: { progressPct: 0, progress: [], lessons: [] },
    isLoading: false,
  }),
  useEnrollmentMutations: () => ({
    enroll: { mutate: vi.fn(), isPending: false },
    unenroll: { mutate: vi.fn(), isPending: false },
    // In-flight for lesson l1 only.
    completeLesson: { mutate: vi.fn(), isPending: true, variables: { id: 'e1', lessonId: 'l1' } },
  }),
  useLeadOptions: () => ({ data: [], isLoading: false }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const course = {
  id: 'c1',
  modules: [
    {
      id: 'm1',
      title: 'Module 1',
      lessons: [
        { id: 'l1', title: 'Lesson 1' },
        { id: 'l2', title: 'Lesson 2' },
      ],
    },
  ],
} as unknown as Parameters<typeof EnrolleesPanel>[0]['course'];

describe('EnrolleesPanel — per-lesson mark-complete loading', () => {
  it('marking one lesson does not disable the other lessons’ Mark complete buttons', async () => {
    const user = userEvent.setup();
    render(<EnrolleesPanel course={course} />);

    // Expand the learner to reveal the per-lesson checklist.
    await user.click(screen.getByRole('button', { name: /view lessons/i }));

    const buttons = await screen.findAllByRole('button', { name: /mark complete/i });
    expect(buttons).toHaveLength(2);
    // completeLesson is in-flight for l1 → only l1's button disabled, l2 stays enabled.
    expect(buttons[0]).toBeDisabled();
    expect(buttons[1]).not.toBeDisabled();
  });
});
