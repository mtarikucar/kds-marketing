import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RecordFormDialog } from './RecordFormDialog';
import type { CustomFieldDef } from '../crm/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? (Array.isArray(k) ? k[0] : k),
    i18n: { language: 'en' },
  }),
}));

const boolField: CustomFieldDef = {
  id: 'f1',
  key: 'active',
  label: 'Active?',
  type: 'BOOL',
  required: true,
  archived: false,
  options: [],
} as unknown as CustomFieldDef;

const textField: CustomFieldDef = {
  id: 'f2',
  key: 'title',
  label: 'Title',
  type: 'TEXT',
  required: false,
  archived: false,
  options: [],
} as unknown as CustomFieldDef;

describe('RecordFormDialog — input is not wiped by a fields-prop re-render', () => {
  it('keeps the in-progress value when fields arrives as a new array reference', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <RecordFormDialog
        open
        onOpenChange={vi.fn()}
        fields={[textField]}
        record={null}
        objectLabel="Property"
        onSubmit={vi.fn()}
        isPending={false}
      />,
    );

    const input = screen.getByRole('textbox');
    await user.type(input, 'My draft');
    expect(input).toHaveValue('My draft');

    // The parent re-renders (e.g. a background refetch on window refocus) and
    // passes a FRESH `fields` array of the same field set. The in-progress input
    // must survive — re-seeding here would silently discard the user's typing.
    rerender(
      <RecordFormDialog
        open
        onOpenChange={vi.fn()}
        fields={[{ ...textField }]}
        record={null}
        objectLabel="Property"
        onSubmit={vi.fn()}
        isPending={false}
      />,
    );

    expect(screen.getByRole('textbox')).toHaveValue('My draft');
  });
});

describe('RecordFormDialog — required BOOL', () => {
  it('submits a required BOOL the user never toggled as false (not undefined)', async () => {
    const onSubmit = vi.fn();
    render(
      <RecordFormDialog
        open
        onOpenChange={vi.fn()}
        fields={[boolField]}
        record={null}
        objectLabel="Property"
        onSubmit={onSubmit}
        isPending={false}
      />,
    );

    // Save WITHOUT toggling the switch — must still send `active: false`.
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toEqual({ active: false });
  });
});
