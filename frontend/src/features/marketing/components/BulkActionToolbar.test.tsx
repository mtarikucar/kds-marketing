/**
 * BulkActionToolbar — bulk-enroll confirmation guard.
 *
 * Enrolling the selected leads into a workflow can fan out automated outbound
 * messages to real customers — a consequential, externally-visible action. It
 * must be confirmed before firing, exactly like the (less severe, reversible
 * soft-)delete next to it. These specs pin that the enroll select asks for
 * confirmation via the design-system ConfirmDialog (not a jarring native
 * window.confirm) and only enrolls when the manager accepts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// Bootstrap i18n so t() resolves instead of returning the raw key.
import '@/i18n/config';

import BulkActionToolbar from './BulkActionToolbar';

const WORKFLOWS = [{ id: 'wf-1', name: 'Welcome sequence' }];

function renderToolbar(onEnroll: (id: string) => void) {
  return render(
    <BulkActionToolbar
      selectedCount={3}
      reps={[]}
      onBulkAssign={() => undefined}
      onClear={() => undefined}
      workflows={WORKFLOWS}
      onEnroll={onEnroll}
    />,
  );
}

describe('BulkActionToolbar — enroll confirmation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens the ConfirmDialog (not a native confirm) and snaps the select back', () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const onEnroll = vi.fn();

    renderToolbar(onEnroll);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'wf-1' } });

    // No native prompt; the design-system dialog gates the action instead.
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onEnroll).not.toHaveBeenCalled();
    // The picked workflow never lingers as the visible selection.
    expect(select.value).toBe('');
  });

  it('does NOT enroll when the manager dismisses the confirmation', () => {
    const onEnroll = vi.fn();

    renderToolbar(onEnroll);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'wf-1' } });

    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));

    expect(onEnroll).not.toHaveBeenCalled();
  });

  it('enrolls with the chosen workflow id when the manager confirms', () => {
    const onEnroll = vi.fn();

    renderToolbar(onEnroll);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'wf-1' } });

    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^enroll$/i }));

    expect(onEnroll).toHaveBeenCalledWith('wf-1');
  });
});
