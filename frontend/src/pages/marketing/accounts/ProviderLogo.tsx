import type { FC } from 'react';
import { MessageSquare, Mail, MessageCircle, Phone, Plug, type LucideIcon } from 'lucide-react';
import type { Provider } from './types';

/**
 * Brand logo for each Account Center provider. Real brands get a hand-authored
 * inline SVG (CSP-safe — bundled, no external fetch); the generic channels
 * (SMS/Email/Web chat/Voice/Phone) get a tasteful lucide glyph. Each icon renders
 * in `currentColor`, so the card sets the brand tint via `color`.
 */

type Mark = FC<{ className?: string }>;

const MetaMark: Mark = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
    <path d="M6.9 4.5c-2.2 0-3.9 2.5-4.9 5.7C1 13.4.6 17 2.4 18.8c1.4 1.4 3.4.7 4.8-1 1-1.2 1.9-2.9 2.7-4.5.8 1.6 1.7 3.3 2.7 4.5 1.4 1.7 3.4 2.4 4.8 1 1.8-1.8 1.4-5.4.4-8.6-1-3.2-2.7-5.7-4.9-5.7-1.5 0-2.6 1.2-3 2-.4-.8-1.5-2-3-2Zm0 2.1c.7 0 1.3.9 2 2.5-.9 1.7-1.9 3.6-2.8 4.7-.8 1-1.5 1.1-1.9.7-.8-.8-.5-3.2.2-5.4.7-2 1.6-2.5 2.5-2.5Zm10.2 0c.9 0 1.8.5 2.5 2.5.7 2.2 1 4.6.2 5.4-.4.4-1.1.3-1.9-.7-.9-1.1-1.9-3-2.8-4.7.7-1.6 1.3-2.5 2-2.5Z" />
  </svg>
);

const LinkedInMark: Mark = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
    <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z" />
  </svg>
);

const XMark: Mark = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
    <path d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.66l-5.21-6.82-5.97 6.82H1.68l7.73-8.84L1.25 2.25h6.83l4.71 6.23 5.45-6.23zm-1.16 17.52h1.83L7.08 4.13H5.12l11.96 15.64z" />
  </svg>
);

const TikTokMark: Mark = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
    <path d="M12.53.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z" />
  </svg>
);

const PinterestMark: Mark = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
    <path d="M12.02 0C5.4 0 .03 5.37.03 11.99c0 5.08 3.16 9.42 7.62 11.16-.11-.95-.2-2.4.04-3.44.22-.94 1.4-5.96 1.4-5.96s-.36-.72-.36-1.78c0-1.66.97-2.91 2.17-2.91 1.02 0 1.52.77 1.52 1.69 0 1.03-.65 2.57-.99 3.99-.29 1.19.6 2.16 1.77 2.16 2.13 0 3.77-2.24 3.77-5.49 0-2.86-2.06-4.87-5.01-4.87-3.41 0-5.41 2.56-5.41 5.2 0 1.03.4 2.14.89 2.74.1.12.11.22.08.34-.09.38-.29 1.2-.33 1.36-.05.23-.17.28-.4.17-1.5-.69-2.43-2.88-2.43-4.64 0-3.78 2.75-7.25 7.92-7.25 4.16 0 7.39 2.97 7.39 6.92 0 4.14-2.61 7.46-6.23 7.46-1.21 0-2.35-.63-2.74-1.38l-.74 2.84c-.27 1.04-1 2.35-1.5 3.15 1.12.34 2.31.53 3.55.53 6.6 0 11.99-5.36 11.99-11.99C24 5.37 18.63 0 12.02 0z" />
  </svg>
);

// Google's multi-colour "G" — keeps its own fills (not currentColor).
const GoogleMark: Mark = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.76c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
    <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1a11 11 0 0 0-9.82 6.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38z" />
  </svg>
);

const BRAND: Record<Provider, { Mark?: Mark; Lucide?: LucideIcon; color: string }> = {
  META: { Mark: MetaMark, color: '#1877F2' },
  LINKEDIN: { Mark: LinkedInMark, color: '#0A66C2' },
  TIKTOK: { Mark: TikTokMark, color: '#EE1D52' },
  TWITTER: { Mark: XMark, color: 'var(--foreground)' },
  PINTEREST: { Mark: PinterestMark, color: '#E60023' },
  GOOGLE: { Mark: GoogleMark, color: '#4285F4' },
  SMS: { Lucide: MessageSquare, color: '#F97316' },
  EMAIL: { Lucide: Mail, color: '#6366F1' },
  WEBCHAT: { Lucide: MessageCircle, color: '#8B5CF6' },
  VOICE: { Lucide: Phone, color: '#10B981' },
};

/** The brand accent colour for a provider (for tint chips / badges). */
export function providerBrand(provider: Provider): string {
  return BRAND[provider]?.color ?? 'var(--foreground)';
}

export function ProviderLogo({ provider, className }: { provider: Provider; className?: string }) {
  const entry = BRAND[provider];
  if (entry?.Mark) {
    const Brand = entry.Mark; // hand-authored SVG already sets aria-hidden
    return <Brand className={className} />;
  }
  const Lucide = entry?.Lucide ?? Plug;
  return <Lucide className={className} aria-hidden="true" />;
}
