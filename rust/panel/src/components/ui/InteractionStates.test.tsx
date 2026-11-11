import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { useState } from 'react';
import tr from '@/i18n/tr.json';
import { Field } from './Field';
import { Input } from './Input';
import { PasswordInput } from './PasswordInput';
import { ConfirmDialog } from './ConfirmDialog';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from './Sheet';

it('lets a person inspect and conceal a password without changing or submitting it', async () => {
  const submit = vi.fn((event) => event.preventDefault());
  const user = userEvent.setup();
  render(<form onSubmit={submit}><label htmlFor="password">Password</label><PasswordInput id="password" defaultValue="example-secret" /></form>);
  const input = screen.getByLabelText('Password');
  expect(input).toHaveAttribute('type', 'password');
  await user.click(screen.getByRole('button', { name: tr.kit.showPassword }));
  expect(input).toHaveAttribute('type', 'text');
  expect(input).toHaveValue('example-secret');
  await user.click(screen.getByRole('button', { name: tr.kit.hidePassword }));
  expect(input).toHaveAttribute('type', 'password');
  expect(submit).not.toHaveBeenCalled();
});

it('describes a field using only the hint or error that is actually present', () => {
  const field = (error?: string) => <Field label="Name" hint="Use a recognizable name" error={error}>
    {(ids) => <Input id={ids.id} aria-describedby={ids.describedBy} aria-invalid={ids.invalid} />}
  </Field>;
  const { rerender } = render(field());
  expect(screen.getByRole('textbox')).toHaveAccessibleDescription('Use a recognizable name');
  rerender(field('Enter a name'));
  const input = screen.getByRole('textbox');
  expect(input).toHaveAccessibleDescription('Enter a name');
  expect(input).toHaveAttribute('aria-invalid', 'true');
  for (const id of input.getAttribute('aria-describedby')!.split(' ')) expect(document.getElementById(id)).not.toBeNull();
});

it('keeps a confirmation open while saving and restores keyboard dismissal afterward', async () => {
  const user = userEvent.setup();
  const onOpenChange = vi.fn();
  const props = { open: true, onOpenChange, title: 'Revoke access', confirmLabel: 'Revoke', onConfirm: vi.fn() };
  const { rerender } = render(<ConfirmDialog {...props} loading />);
  expect(screen.getByRole('button', { name: tr.common.cancel })).toBeDisabled();
  expect(screen.queryByRole('button', { name: tr.kit.close })).not.toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(onOpenChange).not.toHaveBeenCalled();
  rerender(<ConfirmDialog {...props} />);
  await user.keyboard('{Escape}');
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it.each(['dialog', 'sheet'])('returns focus to an ordinary opener after closing a controlled %s', async (kind) => {
  function Example() {
    const [open, setOpen] = useState(false);
    return <>
      <button onClick={() => setOpen(true)}>Open editor</button>
      {kind === 'dialog' ? <ConfirmDialog open={open} onOpenChange={setOpen} title="Edit record" confirmLabel="Save" onConfirm={() => {}} />
        : <Sheet open={open} onOpenChange={setOpen}><SheetContent><SheetTitle>Edit record</SheetTitle><SheetDescription>Record details</SheetDescription><input aria-label="Name" /></SheetContent></Sheet>}
    </>;
  }
  render(<Example />);
  const user = userEvent.setup();
  const opener = screen.getByRole('button', { name: 'Open editor' });
  await user.click(opener);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(opener).toHaveFocus();
});
