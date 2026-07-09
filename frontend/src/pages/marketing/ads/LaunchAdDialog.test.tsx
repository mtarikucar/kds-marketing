import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LaunchAdDialog, buildLaunchPayload } from './LaunchAdDialog';
import type { LaunchAdFormOutput } from './adManagementSchemas';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'en' },
  }),
}));

describe('buildLaunchPayload', () => {
  it('builds a PAUSED Meta launch payload with geo targeting from the country', () => {
    const out: LaunchAdFormOutput = {
      generatedAssetId: 'asset_1',
      adsetName: 'Spring US',
      dailyBudget: 25,
      objective: 'OUTCOME_TRAFFIC',
      link: 'https://example.com/landing',
      primaryText: 'Buy now',
      callToAction: 'SHOP_NOW',
      country: 'US',
    };
    expect(buildLaunchPayload(out)).toMatchObject({
      generatedAssetId: 'asset_1',
      adsetName: 'Spring US',
      campaignName: 'Spring US',
      objective: 'OUTCOME_TRAFFIC',
      dailyBudget: 25,
      optimizationGoal: 'LINK_CLICKS',
      billingEvent: 'IMPRESSIONS',
      link: 'https://example.com/landing',
      primaryText: 'Buy now',
      callToAction: 'SHOP_NOW',
      status: 'PAUSED',
      targeting: { geo_locations: { countries: ['US'] } },
    });
  });
});

describe('LaunchAdDialog', () => {
  it('validates the form and submits the built launch payload', async () => {
    const onSubmit = vi.fn();
    render(<LaunchAdDialog open onOpenChange={() => {}} onSubmit={onSubmit} isPending={false} />);

    await userEvent.type(screen.getByLabelText(/Generated asset ID/i), 'asset_9');
    await userEvent.type(screen.getByLabelText(/Ad set name/i), 'My adset');
    await userEvent.type(screen.getByLabelText(/Daily budget/i), '30');
    await userEvent.type(screen.getByLabelText(/Targeting country/i), 'tr');
    await userEvent.type(screen.getByLabelText(/Destination link/i), 'https://foo.test/land');
    await userEvent.type(screen.getByLabelText(/Primary text/i), 'Great deal');

    await userEvent.click(screen.getByRole('button', { name: /Launch/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      generatedAssetId: 'asset_9',
      adsetName: 'My adset',
      dailyBudget: 30,
      objective: 'OUTCOME_TRAFFIC',
      callToAction: 'LEARN_MORE',
      link: 'https://foo.test/land',
      primaryText: 'Great deal',
      status: 'PAUSED',
      // country is upper-cased by the schema transform
      targeting: { geo_locations: { countries: ['TR'] } },
    });
  });

  it('blocks submit and shows validation errors when required fields are empty', async () => {
    const onSubmit = vi.fn();
    render(<LaunchAdDialog open onOpenChange={() => {}} onSubmit={onSubmit} isPending={false} />);

    await userEvent.click(screen.getByRole('button', { name: /Launch/i }));

    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
