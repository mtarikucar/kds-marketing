import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ProviderLogo, providerBrand } from './ProviderLogo';
import type { Provider } from './types';

const ALL: Provider[] = [
  'META', 'LINKEDIN', 'TIKTOK', 'TWITTER', 'PINTEREST', 'GOOGLE', 'SMS', 'EMAIL', 'WEBCHAT', 'VOICE',
];

describe('ProviderLogo', () => {
  it('renders an svg + a brand colour for every provider', () => {
    for (const p of ALL) {
      const { container } = render(<ProviderLogo provider={p} className="h-5 w-5" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
      expect(svg?.getAttribute('aria-hidden')).toBe('true');
      expect(providerBrand(p)).toBeTruthy();
    }
  });
});
