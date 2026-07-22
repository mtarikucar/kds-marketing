import { validateBrief } from './strategy.schema';
import { MarketingStrategyBrief } from './strategy.types';

const goodBrief: MarketingStrategyBrief = {
  identity: {
    product: 'A private Metin2 game server with weekly events.',
    voice: 'Playful, community-first, nostalgic.',
    positioning: 'The most active low-rate Metin2 server for veterans.',
    usp: 'Hand-tuned balance + no pay-to-win, run by ex-competitive players.',
  },
  audience: 'Nostalgic 25–35yo former Metin2 players in TR/EU.',
  channels: [
    { key: 'reddit', fitScore: 0.9, rationale: 'The niche gathers in r/Metin2.' },
    { key: 'discord', fitScore: 0.85, rationale: 'Community lives in Discord servers.' },
  ],
  contentPillars: [
    {
      title: 'Event recaps',
      angle: 'Show the hype of weekly boss events.',
      formats: ['clip', 'meme'],
      tone: 'Hyped',
    },
  ],
  goals: {
    objective: 'Grow the active player base to 500 concurrent.',
    kpis: ['concurrent players', 'discord joins'],
  },
  budget: 'Bootstrap: $0 ads, organic community only.',
  competitors: ['OtherServerX', 'OtherServerY'],
};

describe('validateBrief', () => {
  it('accepts a well-formed brief', () => {
    const res = validateBrief(goodBrief);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.brief.identity.product).toBe(goodBrief.identity.product);
      expect(res.brief.channels[0].key).toBe('reddit');
    }
  });

  it('rejects an empty object', () => {
    const res = validateBrief({});
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(typeof res.error).toBe('string');
      expect(res.error.length).toBeGreaterThan(0);
    }
  });

  it('rejects a brief with a non-numeric channel fitScore', () => {
    const bad = { ...goodBrief, channels: [{ key: 'reddit', fitScore: 'high', rationale: 'x' }] };
    expect(validateBrief(bad).ok).toBe(false);
  });

  it('rejects null/undefined', () => {
    expect(validateBrief(null).ok).toBe(false);
    expect(validateBrief(undefined).ok).toBe(false);
  });
});
