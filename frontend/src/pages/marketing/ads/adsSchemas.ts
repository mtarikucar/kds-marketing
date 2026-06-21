import { z } from 'zod';
import type { AdProvider } from '../../../features/marketing/api/ads.service';

export const AD_PROVIDERS: AdProvider[] = ['META', 'TIKTOK'];

export const AD_PROVIDER_LABEL: Record<AdProvider, string> = {
  META: 'Meta (Facebook / Instagram)',
  TIKTOK: 'TikTok',
};

/** Connect-account form. `accessToken` is sealed server-side and never echoed. */
export const connectAdAccountSchema = z.object({
  provider: z.enum(['META', 'TIKTOK']),
  externalAdId: z.string().trim().min(1, 'required').max(120, 'tooLong'),
  displayName: z.string().trim().max(160, 'tooLong').optional().or(z.literal('')),
  accessToken: z.string().trim().min(1, 'required').max(4000, 'tooLong'),
  currency: z.string().trim().max(8, 'tooLong').optional().or(z.literal('')),
});

export type ConnectAdAccountFormValues = z.infer<typeof connectAdAccountSchema>;
