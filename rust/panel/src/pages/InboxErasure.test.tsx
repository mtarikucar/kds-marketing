import { expect, it } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderAt } from '@/test/render';
import { inboxAnswers } from '@/test/inbox';

it('requires explicit confirmation before erasing a person', async () => {
  const calls = mockFetch({ ...inboxAnswers, 'POST /api/inbox/people/person-1/erase': { person_id: 'person-1', erased: true } });
  renderAt('/inbox?person=person-1');
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Kişisel verileri sil' }));
  const dialog = screen.getByRole('dialog');
  const submit = within(dialog).getByRole('button', { name: 'Kalıcı olarak sil' });
  expect(submit).toBeDisabled();
  expect(calls.some(c => c.path.endsWith('/erase'))).toBe(false);
  await user.click(within(dialog).getByRole('checkbox'));
  await user.click(submit);
  await waitFor(() => expect(calls.find(c => c.path.endsWith('/erase'))?.body).toEqual({ confirm: true }));
});
