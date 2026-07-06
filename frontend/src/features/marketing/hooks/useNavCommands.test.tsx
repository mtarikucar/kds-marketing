import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/i18n/config';
import { useMarketingAuthStore, type MarketingUser } from '@/store/marketingAuthStore';
import { useNavCommands } from './useNavCommands';

const MANAGER: MarketingUser = {
  id: 'u1', workspaceId: 'w1', email: 'm@x.io', firstName: 'M', lastName: 'X', role: 'MANAGER',
};
const REP: MarketingUser = { ...MANAGER, id: 'u2', role: 'REP' };

function makeQC() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function loginAs(user: MarketingUser) {
  useMarketingAuthStore.setState({
    user, accessToken: 't', refreshToken: 'r', isAuthenticated: true,
  });
}

/** Renders the hook's output as data-path list items so we can assert on it. */
function Probe() {
  const cmds = useNavCommands();
  return (
    <ul>
      {cmds.map((c) => (
        <li key={c.path} data-path={c.path}>{c.label}</li>
      ))}
    </ul>
  );
}

function pathsOf(container: HTMLElement): (string | null)[] {
  return Array.from(container.querySelectorAll('[data-path]')).map((el) =>
    el.getAttribute('data-path'),
  );
}

function renderProbe() {
  const qc = makeQC();
  return render(
    <QueryClientProvider client={qc}>
      <Probe />
    </QueryClientProvider>,
  );
}

describe('useNavCommands', () => {
  it('includes core destinations for a manager', () => {
    loginAs(MANAGER);
    const { container } = renderProbe();
    const paths = pathsOf(container);
    expect(paths).toContain('/dashboard');
    expect(paths).toContain('/leads');
    // managerOnly + no entitlement flag → visible to a manager.
    expect(paths).toContain('/tags');
  });

  it('hides manager-only destinations from a rep', () => {
    loginAs(REP);
    const { container } = renderProbe();
    const paths = pathsOf(container);
    expect(paths).toContain('/dashboard');
    expect(paths).toContain('/leads');
    expect(paths).not.toContain('/custom-objects');
  });
});
