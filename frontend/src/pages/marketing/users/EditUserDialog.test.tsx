import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditUserDialog } from './EditUserDialog';

/**
 * The backend role enum is MANAGER/REP only. Editing an OWNER must NOT submit
 * role='OWNER' (it 400s the whole update), and must never silently demote the
 * owner. A MANAGER/REP edit still submits the chosen role.
 */
describe('EditUserDialog', () => {
  it('omits role when editing an OWNER (so the update does not 400)', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <EditUserDialog
        open
        onOpenChange={() => {}}
        user={{ id: 'u1', firstName: 'Ada', lastName: 'Owner', phone: '', role: 'OWNER' }}
        onSubmit={onSubmit}
        isPending={false}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('role');
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ firstName: 'Ada', lastName: 'Owner' });
  });

  it('submits the role for a MANAGER/REP user', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <EditUserDialog
        open
        onOpenChange={() => {}}
        user={{ id: 'u2', firstName: 'Rep', lastName: 'One', phone: '', role: 'REP' }}
        onSubmit={onSubmit}
        isPending={false}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ role: 'REP' });
  });
});
