import { expect, it } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderAt, withStatus } from '@/test/render';
import { inboxAnswers } from '@/test/inbox';

it('requires typed confirmation before erasing a person', async () => {
  const calls = mockFetch({ ...inboxAnswers, 'POST /api/inbox/people/person-1/erase': { person_id: 'person-1', erased: true } });
  renderAt('/inbox?person=person-1');
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Kişisel verileri sil' }));
  const dialog = screen.getByRole('dialog');
  const submit = within(dialog).getByRole('button', { name: 'Kalıcı olarak sil' });
  expect(submit).toBeDisabled();
  expect(calls.some(c => c.path.endsWith('/erase'))).toBe(false);
  const confirmation = within(dialog).getByRole('textbox');
  await user.type(confirmation, 'wrong');
  expect(submit).toBeDisabled();
  await user.clear(confirmation);
  await user.type(confirmation, 'SİL');
  await user.click(submit);
  await waitFor(() => expect(calls.find(c => c.path.endsWith('/erase'))?.body).toEqual({ confirm: true }));
});

it('cancels erasure without a request, restores focus, and clears a previous failure on reopening', async () => {
  const calls = mockFetch({ ...inboxAnswers, 'POST /api/inbox/people/person-1/erase': withStatus(409, { code: 'CONFLICT', message: 'conflict', details: {} }) });
  renderAt('/inbox?person=person-1');
  const user = userEvent.setup();
  const trigger = await screen.findByRole('button', { name: 'Kişisel verileri sil' });
  await user.click(trigger);
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Vazgeç' }));
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(calls.some(call => call.path.endsWith('/erase'))).toBe(false);

  await user.click(trigger);
  let dialog = screen.getByRole('dialog');
  await user.type(within(dialog).getByRole('textbox'), 'SİL');
  await user.click(within(dialog).getByRole('button', { name: 'Kalıcı olarak sil' }));
  expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Vazgeç' }));
  await user.click(trigger);
  dialog = screen.getByRole('dialog');
  expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  expect(within(dialog).getByRole('textbox')).toHaveValue('');
  expect(within(dialog).getByRole('button', { name: 'Kalıcı olarak sil' })).toBeDisabled();
});
