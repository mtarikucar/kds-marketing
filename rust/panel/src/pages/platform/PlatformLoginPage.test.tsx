import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import tr from '@/i18n/tr.json';
import { mockFetch, renderAt } from '@/test/render';

describe('PlatformLoginPage', () => {
  it('renders the operator sign-in form', async () => {
    mockFetch({});
    renderAt('/platform/login');
    expect(
      await screen.findByRole('heading', { level: 1, name: tr.platform.login.title }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(tr.fields.password, { exact: false })).toBeInTheDocument();
  });
});
