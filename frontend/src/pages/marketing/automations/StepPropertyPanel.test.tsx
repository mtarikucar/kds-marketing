import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StepPropertyPanel } from './StepPropertyPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string | string[], d?: unknown) => (typeof d === 'string' ? d : Array.isArray(k) ? k[0] : k),
    i18n: { language: 'en' },
  }),
}));

const noop = vi.fn();

describe('StepPropertyPanel', () => {
  it('shows a hint when nothing is selected', () => {
    render(
      <StepPropertyPanel index={null} step={null} count={0}
        onPatch={noop} onReplace={noop} onDelete={noop} onMove={noop} />,
    );
    expect(screen.getByText(/click a step to edit/i)).toBeInTheDocument();
  });

  it('edits a send_email subject via onPatch', async () => {
    const onPatch = vi.fn();
    render(
      <StepPropertyPanel index={0} step={{ type: 'send_email', subject: '', body: '' }} count={1}
        onPatch={onPatch} onReplace={noop} onDelete={noop} onMove={noop} />,
    );
    await userEvent.type(screen.getByLabelText(/subject/i), 'Hi');
    expect(onPatch).toHaveBeenCalled();
  });

  it('renders the visual branch editor (no JSON required)', () => {
    render(
      <StepPropertyPanel index={0} step={{ type: 'branch', filters: [] }} count={1}
        onPatch={noop} onReplace={noop} onDelete={noop} onMove={noop} />,
    );
    expect(screen.getByRole('button', { name: /add condition/i })).toBeInTheDocument();
  });

  // Regression: the Advanced-JSON editor holds the step text in local state. When
  // the user switches steps with it open, the stale draft must NOT persist — else
  // editing it overwrites the newly-selected step with the previous step's config.
  it("does not carry the previous step's JSON into the Advanced editor on switch", async () => {
    const stepA = { type: 'send_email', subject: 'SUBJECT_A', body: 'hi' };
    const stepB = { type: 'create_task', title: 'TASK_B' };
    const { rerender } = render(
      <StepPropertyPanel index={0} step={stepA as any} count={2}
        onPatch={noop} onReplace={noop} onDelete={noop} onMove={noop} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /advanced/i }));
    expect((screen.getByLabelText(/advanced/i) as HTMLTextAreaElement).value).toContain('SUBJECT_A');

    rerender(
      <StepPropertyPanel index={1} step={stepB as any} count={2}
        onPatch={noop} onReplace={noop} onDelete={noop} onMove={noop} />,
    );
    const ta = screen.queryByLabelText(/advanced/i) as HTMLTextAreaElement | null;
    expect(ta?.value ?? '').not.toContain('SUBJECT_A');
  });
});
