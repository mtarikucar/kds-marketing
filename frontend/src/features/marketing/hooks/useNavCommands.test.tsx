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
const OWNER: MarketingUser = { ...MANAGER, id: 'u3', role: 'OWNER' };

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

/** Seeds the workspace-profile cache so useWorkspaceProfile resolves isAgency. */
function renderProbeInAgency() {
  const qc = makeQC();
  qc.setQueryData(['marketing', 'workspace', 'profile'], { kind: 'AGENCY' });
  return render(
    <QueryClientProvider client={qc}>
      <Probe />
    </QueryClientProvider>,
  );
}

/**
 * Seeds the entitlement cache the way the shell warms it, so `has()` answers a
 * RESOLVED yes/no instead of the fail-closed "no" it gives while
 * `/billing/summary` is in flight. Without this every plan-gated destination is
 * absent for the same reason, and an absence assertion about ONE gate would
 * pass on a hook that had no gates at all.
 */
function renderProbeWithPlan(features: Record<string, boolean>) {
  const qc = makeQC();
  qc.setQueryData(['marketing', 'billing', 'summary'], { entitlements: { features } });
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
    // Segments and Tags left Settings entirely on 2026-09-04 — they are about
    // the people on the Inbox surface. The palette still offers both by name,
    // now as tabs of the surface that took them.
    expect(paths).toContain('/leads?tab=audience');
    expect(paths).toContain('/leads?tab=import');
  });

  it('hides manager-only destinations from a rep', () => {
    loginAs(REP);
    const { container } = renderProbe();
    const paths = pathsOf(container);
    expect(paths).toContain('/dashboard');
    expect(paths).toContain('/leads');
    expect(paths).not.toContain('/custom-objects');
  });

  it('offers a rep the Growth Studio itself', () => {
    // Asserted here as well as on the rail because both read the same
    // `visibleNav`: while /studio was managerOnly the palette's only Studio
    // answer was /reports, so a rep who typed the surface's own name was sent
    // to a different page — the same lie the rail was telling, through a second
    // door. If the sidebar is ever refactored off visibleNav this is what still
    // catches the regression.
    loginAs(REP);
    const { container } = renderProbe();
    expect(pathsOf(container)).toContain('/studio');
  });

  it('includes /agency/* destinations for an agency OWNER (palette mirrors the sidebar)', () => {
    loginAs(OWNER);
    const { container } = renderProbeInAgency();
    const paths = pathsOf(container);
    expect(paths).toContain('/agency/locations');
    expect(paths).toContain('/agency/snapshots');
    expect(paths).toContain('/agency/rebilling');
  });

  it('hides /agency/* from a MANAGER even in an agency workspace (owner-only hub)', () => {
    loginAs(MANAGER);
    const { container } = renderProbeInAgency();
    const paths = pathsOf(container);
    expect(paths).not.toContain('/agency/locations');
  });

  /**
   * THE UNLISTED DESTINATIONS ARRIVE GATED — asserted here, at the wiring.
   *
   * navigation.test.ts already holds `visibleUnlisted` to these three answers,
   * but a pure function nobody calls gates nothing: reverting this hook's loop
   * to a raw `for (const d of UNLISTED_DESTINATIONS)` left the whole frontend
   * suite, `tsc` and the browser test green, because the pure test still passed
   * and Playwright runs as an entitled OWNER. That revert now fails HERE.
   *
   * `/appointments` is the one that matters and the reason the gates were added
   * at all: every route on `MarketingBookingController` is
   * `@MarketingRoles('MANAGER')` + `@RequiresFeature('funnels')`. Since stage 4
   * this palette is the only door those six pages have, so an ungated read here
   * is not a cosmetic slip — it is the product offering a rep a jump into a
   * page that can only answer 403.
   *
   * Each absence is anchored on a POSITIVE hit from the same list, so "the rep
   * is not offered /appointments" can never pass because the loop produced
   * nothing at all.
   */
  it('does not offer /appointments to a REP, even where the plan includes funnels', () => {
    loginAs(REP);
    const { container } = renderProbeWithPlan({ funnels: true });
    const paths = pathsOf(container);
    // The unlisted loop ran, and the ungated departures are on the rep's list.
    expect(paths).toContain('/companies');
    expect(paths).toContain('/tasks');
    expect(paths).not.toContain('/appointments');
  });

  it('does not offer /appointments to a manager whose plan lacks funnels', () => {
    loginAs(MANAGER);
    const { container } = renderProbeWithPlan({ funnels: false });
    const paths = pathsOf(container);
    expect(paths).toContain('/companies');
    expect(paths).toContain('/tasks');
    expect(paths).not.toContain('/appointments');
  });

  it('offers /appointments to a manager whose plan includes funnels', () => {
    loginAs(MANAGER);
    const { container } = renderProbeWithPlan({ funnels: true });
    const paths = pathsOf(container);
    // The other half of the gate: hiding it from everyone would satisfy the two
    // assertions above and take the page away from the people it belongs to.
    expect(paths).toContain('/appointments');
  });
});

/**
 * THE MERGE'S SIDE OF THE BARGAIN.
 *
 * Six pairs of settings pages became six pages with tabs on 2026-09-03. That
 * made the sidebar shorter, and it would have made this list WORSE unless the
 * absorbed names came with it: somebody who knows the thing is called "Roles"
 * types it, finds nothing, and concludes it was removed.
 *
 * The list is something you scan; the palette is something you ask. Only the
 * list was too long.
 */
describe('useNavCommands — the merged pages keep every name they absorbed', () => {
  it('offers each absorbed page by its own name, aimed at its tab', () => {
    loginAs(MANAGER);
    const { container } = renderProbe();
    const byPath = new Map(
      Array.from(container.querySelectorAll('[data-path]')).map((el) => [
        el.getAttribute('data-path'),
        el.textContent,
      ]),
    );

    // Path → the label the person is likely to type.
    const ABSORBED: [string, RegExp][] = [
      ['/users?tab=roles', /rol/i],
      ['/users?tab=targets', /hedef|target/i],
      ['/settings/webhooks?tab=inbound', /gelen|inbound/i],
      ['/settings/api-keys?tab=connector', /claude|ba.lay/i],
      // The second pass: selling took the whole sale, the business page took the
      // deal stages, and the inbox took what shapes its people. The GATED
      // halves (workflows, research, invoicing, telephony, funnels) are absent
      // here on purpose — see the entitlement test below.
      ['/products?tab=order-forms', /sipari|order/i],
      ['/branding?tab=pipelines', /hat|pipeline/i],
      ['/leads?tab=fields', /alan|field/i],
    ];
    for (const [path, label] of ABSORBED) {
      expect({ path, present: byPath.has(path) }).toEqual({ path, present: true });
      expect(byPath.get(path) ?? '').toMatch(label);
    }
  });

  it('does not offer the first tab twice under two names', () => {
    // The bare path already opens it. Two entries onto one view is the exact
    // duplication the merge removed from the sidebar.
    loginAs(MANAGER);
    const { container } = renderProbe();
    const paths = pathsOf(container);
    expect(paths).toContain('/users');
    expect(paths).not.toContain('/users?tab=members');
    expect(paths).not.toContain('/leads?tab=people');
    expect(paths).not.toContain('/products?tab=products');
  });

  it('never offers a tab for a feature the workspace has not bought', () => {
    // /calls carried `telephony` before it became a tab of Voice. Folding it in
    // without the gate would put a jump in the palette that lands on a blank
    // panel — worse than the long list this merge replaced.
    loginAs(MANAGER);
    const { container } = renderProbe();
    const paths = pathsOf(container);
    // The default test entitlement set is empty, so every gated half is absent
    // while its ungated siblings are present.
    expect(paths).toContain('/studio/strategy');
    expect(paths).not.toContain('/studio/strategy?tab=research');
    expect(paths).not.toContain('/products?tab=invoices');
    expect(paths).not.toContain('/voice?tab=calls');
  });

  it('never offers a tab of a page the person cannot reach', () => {
    // The tabs ride on the child, so the child's role/plan gate decides. A rep
    // who cannot open Team must not be offered its Roles tab either.
    loginAs(REP);
    const { container } = renderProbe();
    const paths = pathsOf(container);
    expect(paths).not.toContain('/users');
    expect(paths).not.toContain('/users?tab=roles');
  });
});
