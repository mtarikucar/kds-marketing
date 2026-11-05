import { expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import { me, workspace } from '@/test/fixtures';
import { mockFetch, renderAt } from '@/test/render';
import { PEOPLE_PAGE } from './PeoplePage';

const person = (i: number) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  workspace_id: workspace.id,
  display_name: `Kişi ${i}`,
  company: i % 2 ? `Şirket ${i}` : '',
  first_touch: { source: 'import', capability_id: null, at: '2026-01-01T00:00:00Z' },
  merged_into: null,
  erased_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});

it('lists every person page by page, including people with no conversation, and searches from page one', async () => {
  const user = userEvent.setup();
  const firstPage = Array.from({ length: PEOPLE_PAGE }, (_, i) => person(i + 1));
  const answers: Record<string, unknown> = {
    'GET /api/auth/me': me,
    'GET /api/workspace': workspace,
    'GET /api/inbox/people': firstPage,
  };
  const calls = mockFetch(answers);
  renderAt('/people');
  expect(await screen.findByText('Kişi 1')).toBeInTheDocument();
  expect(screen.getByText(/Şirket 1$/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Kişi 1\b/ })).toHaveAttribute('href', `/inbox?person=${person(1).id}`);
  expect(screen.getByRole('button', { name: tr.people.previous })).toBeDisabled();
  answers['GET /api/inbox/people'] = [person(PEOPLE_PAGE + 1)];
  await user.click(screen.getByRole('button', { name: tr.people.next }));
  expect(await screen.findByText(`Kişi ${PEOPLE_PAGE + 1}`)).toBeInTheDocument();
  const paged = calls.filter((c) => c.path === '/api/inbox/people').slice(-1)[0];
  expect(new URLSearchParams(paged.search).get('offset')).toBe(String(PEOPLE_PAGE));
  // A short page is the last one.
  expect(screen.getByRole('button', { name: tr.people.next })).toBeDisabled();
  answers['GET /api/inbox/people'] = [person(7)];
  await user.type(screen.getByLabelText(tr.people.search), 'Kişi 7');
  await waitFor(() => expect(screen.getByText('Kişi 7')).toBeInTheDocument());
  const last = calls.filter((c) => c.path === '/api/inbox/people').slice(-1)[0];
  expect(new URLSearchParams(last.search).get('offset')).toBe('0');
  expect(new URLSearchParams(last.search).get('limit')).toBe(String(PEOPLE_PAGE));
});

it('returns to the previous page when a full page is followed by an empty page', async () => {
  const user = userEvent.setup();
  const firstPage = Array.from({ length: PEOPLE_PAGE }, (_, index) => person(index + 1));
  const answers: Record<string, unknown> = {
    'GET /api/auth/me': me,
    'GET /api/workspace': workspace,
    'GET /api/inbox/people': firstPage,
  };
  const requests = mockFetch(answers);
  renderAt('/people');
  await screen.findByText('Kişi 1');
  answers['GET /api/inbox/people'] = [];
  await user.click(screen.getByRole('button', { name: tr.people.next }));
  await screen.findByText(tr.people.noMatch);
  expect(new URLSearchParams(requests.filter(request => request.path === '/api/inbox/people').at(-1)?.search).get('offset')).toBe(String(PEOPLE_PAGE));

  answers['GET /api/inbox/people'] = firstPage;
  await user.click(screen.getByRole('button', { name: tr.people.previous }));
  expect(await screen.findByText('Kişi 1')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: tr.people.previous })).toBeDisabled();
  await waitFor(() => expect(new URLSearchParams(requests.filter(request => request.path === '/api/inbox/people').at(-1)?.search).get('offset')).toBe('0'));
});

it('offers channel setup on a true empty directory only to someone who can manage connections', async () => {
  mockFetch({ 'GET /api/auth/me': me, 'GET /api/workspace': workspace, 'GET /api/inbox/people': [] });
  const first = renderAt('/people');
  expect(await screen.findByRole('link', { name: 'Müşteri kanallarını bağla' })).toHaveAttribute('href', '/capabilities');
  first.unmount();
  const member = { ...me, memberships: me.memberships.map(membership => ({ ...membership, permissions: ['workspace.read' as const] })) };
  mockFetch({ 'GET /api/auth/me': member, 'GET /api/workspace': workspace, 'GET /api/inbox/people': [] });
  renderAt('/people');
  await screen.findByText(tr.people.empty);
  expect(screen.queryByRole('link', { name: 'Müşteri kanallarını bağla' })).not.toBeInTheDocument();
});
