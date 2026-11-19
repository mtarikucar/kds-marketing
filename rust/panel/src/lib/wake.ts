import { useEffect, useState } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { getWakes } from '@/api/agents';
import type { NeedKey, NeedWake, WakesOut } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { formatWhen } from './format';

// Waking an agent when a person gives it work (`jt_app::usecases::wake`): the one read every
// page shares, and the words its sentences are made of.

/** Every wake read's query key starts with this. */
export const WAKES_KEY = ['agent-wakes'] as const;

/** The mutations of this module mark themselves so their own success does not read again. */
export const WAKE_META = { wake: true } as const;

/** Whether something moves soon: an agent at work, a call on its way or just made. */
export function wakesBusy(data: WakesOut | undefined): boolean {
  if (!data) return false;
  return Object.values(data.needs).some((n) => n.state === 'calling' || n.state === 'called' || n.state === 'working')
    || data.agents.some((a) => a.pending);
}

/**
 * `GET /api/agents/wakes`, shared by every page that says what an agent will do: read every ten
 * seconds while a call is on its way, was just made or an agent is at work, else every minute.
 * A person's action that gives an agent work records a wake on the server in the same
 * transaction, so any successful mutation reads it again at once.
 */
export function useAgentWakes() {
  const session = useSession();
  const workspace = session.data?.current_workspace;
  const client = useQueryClient();
  useEffect(() => client.getMutationCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    if ((event.mutation.options.meta as { wake?: boolean } | undefined)?.wake) return;
    void client.invalidateQueries({ queryKey: WAKES_KEY });
  }), [client]);
  return useQuery({
    queryKey: [...WAKES_KEY, workspace ?? undefined],
    queryFn: getWakes,
    enabled: !!workspace,
    refetchInterval: (query) => (wakesBusy(query.state.data) ? 10_000 : 60_000),
  });
}

/** Puts a mutation's answer (the wake states after it) in the cache: the lines change at once. */
export function putWakes(client: QueryClient, workspace: string | null | undefined, out: WakesOut) {
  client.setQueryData([...WAKES_KEY, workspace ?? undefined], out);
}

/** What `need`'s waiting work can expect; `undefined` until known (or when the read failed). */
export function useNeedWake(need: NeedKey): NeedWake | undefined {
  return useAgentWakes().data?.needs[need];
}

const RANK: Record<NeedWake['state'], number> = { working: 0, calling: 1, called: 2, schedule: 3, refused: 4, no_agent: 5 };

/**
 * Of the needs whose work waits (`counts`), the one whose state promises the most (an agent at
 * work, then a call on its way, a call made, a schedule, a refused address, no agent), with how
 * much of it waits; `null` when nothing waits or the states are not known.
 */
export function pickNeed(data: WakesOut | undefined, counts: Partial<Record<NeedKey, number>>): { need: NeedKey; waiting: number; state: NeedWake } | null {
  if (!data) return null;
  let best: { need: NeedKey; waiting: number; state: NeedWake } | null = null;
  for (const [need, waiting] of Object.entries(counts) as [NeedKey, number][]) {
    const state = data.needs[need];
    if (!state || !(waiting > 0)) continue;
    if (!best || RANK[state.state] < RANK[best.state.state]) best = { need, waiting, state };
  }
  return best;
}

/** The current time, read again every `ms` milliseconds (none: never). */
export function useNow(ms: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ms) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * How often an agent checks in, in words that sit mid-sentence: "saat başı", "30 dakikada bir",
 * "3 saatte bir", "günde bir".
 */
export function everyPhrase(t: TFunction, minutes: number): string {
  if (!(minutes > 0)) return t('wake.every.own');
  if (minutes === 60) return t('wake.every.hour');
  if (minutes === 1440) return t('wake.every.day');
  if (minutes > 60 && minutes % 60 === 0) return t('wake.every.hours', { n: minutes / 60 });
  return t('wake.every.minutes', { n: minutes });
}

/** `text` with its first letter in capitals, as `language` writes it ("saat başı" → "Saat başı"). */
export function capitalise(text: string, language: string): string {
  return text.charAt(0).toLocaleUpperCase(language.startsWith('tr') ? 'tr-TR' : 'en-GB') + text.slice(1);
}

const UNITS = ['', 'bir', 'iki', 'üç', 'dört', 'beş', 'altı', 'yedi', 'sekiz', 'dokuz'];
const TENS = ['', 'on', 'yirmi', 'otuz', 'kırk', 'elli', 'altmış', 'yetmiş', 'seksen', 'doksan'];

/** The last word of `n` read aloud in Turkish ("14" → "dört", "30" → "otuz", "2000" → "bin"). */
function lastWord(n: number): string {
  if (n === 0) return 'sıfır';
  if (n % 10) return UNITS[n % 10];
  if (n % 100) return TENS[Math.floor(n / 10) % 10];
  return n % 1000 ? 'yüz' : 'bin';
}

/**
 * The Turkish case ending a time or date takes as it is read aloud: locative ("14:00'te",
 * "14:30'da") or ablative ("14:05'ten"). A time ending in ":00" is read by its hour.
 */
export function trSuffix(text: string, kase: 'loc' | 'abl'): string {
  const time = /(\d{1,2})[:.](\d{2})\s*$/.exec(text);
  const number = /(\d+)\s*$/.exec(text);
  let word = 'sıfır';
  if (time) word = Number(time[2]) ? lastWord(Number(time[2])) : lastWord(Number(time[1]));
  else if (number) word = lastWord(Number(number[1]));
  else return '';
  const vowel = [...word].reverse().find((c) => 'aeıioöuü'.includes(c)) ?? 'e';
  const back = 'aıou'.includes(vowel);
  const hard = 'çfhkpsşt'.includes(word.at(-1) ?? '');
  return `'${hard ? 't' : 'd'}${back ? 'a' : 'e'}${kase === 'abl' ? 'n' : ''}`;
}

/** A moment as the lines say it: the time today, else the day and time (`formatWhen`). */
export function wakeTime(iso: string, language: string): string {
  return formatWhen(iso, language);
}

/**
 * A moment with the case ending Turkish needs before "gidecek" / "sonra" ("14:00'te",
 * "14:05'ten"); other languages say "at" / "after" in the sentence itself.
 */
export function wakeTimeIn(iso: string, language: string, kase: 'loc' | 'abl'): string {
  const time = wakeTime(iso, language);
  return language.startsWith('tr') ? `${time}${trSuffix(time, kase)}` : time;
}

/**
 * A Claude routine's id from what a person pasted: the bare `trig_…` id, or the trigger's URL
 * (`…/routines/trig_01ABC/fire`) claude.ai shows beside its token. Anything else as typed.
 */
export function routineIdOf(input: string): string {
  const typed = input.trim();
  return /trig_[A-Za-z0-9_-]+/.exec(typed)?.[0] ?? typed;
}
