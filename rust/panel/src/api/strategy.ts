import { request } from './client';
import type { StrategyOut } from './types';

// The strategy page became Bilgi bankası (design 2026-11-19 §4.11, `./knowledge.ts`); its writes
// are gone from the panel. What stays is the compatibility read (§5.4): the internal frame in the
// shape older readers know, whose audience names the research and prospects pages show.

/** `GET /api/strategy`: the frame in force as `approved` (null until a card has text). */
export function getStrategy(): Promise<StrategyOut> {
  return request('GET', '/api/strategy');
}
