import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BranchConditionBuilder } from './BranchConditionBuilder';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string | string[], d?: unknown) => (typeof d === 'string' ? d : Array.isArray(k) ? k[0] : k),
    i18n: { language: 'en' },
  }),
}));

describe('BranchConditionBuilder', () => {
  it('adds a blank condition row via onPatch', async () => {
    const onPatch = vi.fn();
    render(<BranchConditionBuilder step={{ type: 'branch', filters: [] }} onPatch={onPatch} />);
    await userEvent.click(screen.getByRole('button', { name: /add condition/i }));
    expect(onPatch).toHaveBeenLastCalledWith({ filters: [{ field: '', op: 'eq', value: '' }] });
  });

  it('removes an existing row via onPatch', async () => {
    const onPatch = vi.fn();
    render(
      <BranchConditionBuilder
        step={{ type: 'branch', filters: [{ field: 'lead.status', op: 'eq', value: 'NEW' }] }}
        onPatch={onPatch}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /remove condition/i }));
    expect(onPatch).toHaveBeenLastCalledWith({ filters: [] });
  });
});
