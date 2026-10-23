import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import tr from '@/i18n/tr.json';
import { mockFetch, renderAt } from '@/test/render';

describe('LoginPage', () => {
  it('renders the sign-in form', async () => {
    mockFetch({});
    renderAt('/login');
    expect(await screen.findByRole('heading', { level: 1, name: tr.login.title })).toBeInTheDocument();
    expect(screen.getByLabelText(tr.fields.email, { exact: false })).toBeInTheDocument();
    expect(screen.getByLabelText(tr.fields.password, { exact: false })).toBeInTheDocument();
  });
});
