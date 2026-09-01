import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { UpgradeCallout } from './UpgradeCallout';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, d?: unknown) =>
      (typeof d === 'string' ? d : (d as { defaultValue?: string })?.defaultValue) ?? _k,
  }),
}));

describe('UpgradeCallout', () => {
  it('default variant is unchanged — subscription copy plus a link to /billing', () => {
    render(<UpgradeCallout />, { wrapper: MemoryRouter });

    expect(screen.getByText(/requires an active subscription/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view the plan/i })).toHaveAttribute('href', '/billing');
  });

  /**
   * The whole point of the variant: `voiceCampaigns`, `smsOtp` and `fax` are
   * false on JEETA *and on TRIAL*, so "activate the plan to unlock it" in front
   * of one of them tells the customer to buy something that changes nothing.
   */
  it('addOn variant names the add-on and does not promise the plan unlocks it', () => {
    render(<UpgradeCallout addOn="Voice campaigns" />, { wrapper: MemoryRouter });

    expect(screen.getByText(/Voice campaigns — paid add-on/i)).toBeInTheDocument();
    expect(screen.getByText(/Boosts/)).toBeInTheDocument();
    expect(screen.queryByText(/activate the plan/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /see the add-ons/i })).toHaveAttribute(
      'href',
      '/billing',
    );
  });

  /**
   * Several page tests mock `t` to echo `defaultValue` with no interpolation,
   * so the add-on name is concatenated rather than passed through an i18n
   * `{{addOn}}` placeholder. Pin it: a "cleanup" to interpolation would render
   * the literal placeholder here.
   */
  it('never renders a raw i18n placeholder in the title', () => {
    render(<UpgradeCallout addOn="Voice campaigns" />, { wrapper: MemoryRouter });
    expect(screen.queryByText(/\{\{/)).not.toBeInTheDocument();
  });
});
