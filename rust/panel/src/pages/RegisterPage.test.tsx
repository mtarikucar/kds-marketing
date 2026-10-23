import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import tr from '@/i18n/tr.json';
import { mockFetch, renderAt } from '@/test/render';

describe('RegisterPage', () => {
  it('renders the registration form', async () => {
    mockFetch({});
    renderAt('/register');
    expect(
      await screen.findByRole('heading', { level: 1, name: tr.register.title }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(tr.fields.workspace_name, { exact: false })).toBeInTheDocument();
  });
});
