/**
 * BulkActionToolbar — bulk-enroll confirmation guard.
 *
 * Enrolling the selected leads into a workflow can fan out automated outbound
 * messages to real customers — a consequential, externally-visible action. It
 * must be confirmed before firing, exactly like the (less severe, reversible
 * soft-)delete next to it. These specs pin that the enroll select asks for
 * confirmation and only enrolls when the manager accepts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

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

  it('does NOT enroll when the manager cancels the confirmation', () => {
    const onEnroll = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    renderToolbar(onEnroll);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'wf-1' } });

    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(onEnroll).not.toHaveBeenCalled();
    // Select returns to its placeholder so the cancelled workflow isn't left selected.
    expect(select.value).toBe('');
  });

  it('enrolls with the chosen workflow id when the manager confirms', () => {
    const onEnroll = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderToolbar(onEnroll);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'wf-1' } });

    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(onEnroll).toHaveBeenCalledWith('wf-1');
  });
});
