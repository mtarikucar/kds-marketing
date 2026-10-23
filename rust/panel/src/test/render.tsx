import { StrictMode } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { PROVIDER_FUTURE, ROUTER_FUTURE, routes } from '@/App';
import { setUnauthorizedHandler } from '@/api/client';

/** Canned answers keyed by `"<METHOD> <path>"`, e.g. `"GET /api/team"`. */
export type FetchRoutes = Record<string, unknown>;

const STATUS = Symbol('status');
const DELAY = Symbol('delay');

interface StatusAnswer {
  [STATUS]: number;
  body: unknown;
}

interface DelayedAnswer {
  [DELAY]: number;
  answer: unknown;
}

/** An answer with another status than 200, e.g. `withStatus(401, { code: 'UNAUTHENTICATED', … })`. */
export function withStatus(status: number, body: unknown): StatusAnswer {
  return { [STATUS]: status, body };
}

/** `answer` (a body, `withStatus(…)` or `null`) given only after `ms` milliseconds. */
export function delayed(ms: number, answer: unknown): DelayedAnswer {
  return { [DELAY]: ms, answer };
}

function isStatusAnswer(value: unknown): value is StatusAnswer {
  return typeof value === 'object' && value !== null && STATUS in value;
}

function isDelayedAnswer(value: unknown): value is DelayedAnswer {
  return typeof value === 'object' && value !== null && DELAY in value;
}

/** A recorded call to the mocked `fetch`. */
export interface FetchCall {
  method: string;
  path: string;
  search: string;
  headers: Headers;
  body: unknown;
}

/**
 * Replaces `fetch` with a stub answering from `answers` (status 200, JSON) and anything else with
 * a structured 404. Returns the calls it saw.
 */
export function mockFetch(answers: FetchRoutes): FetchCall[] {
  const calls: FetchCall[] = [];
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, 'http://panel.test');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path: url.pathname, search: url.search, headers: new Headers(init?.headers), body });
    const key = `${method} ${url.pathname}`;
    if (key in answers) {
      let answer = answers[key];
      if (isDelayedAnswer(answer)) {
        const wait = answer[DELAY];
        answer = answer.answer;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      if (answer === null) return new Response(null, { status: 204 });
      const [status, payload] = isStatusAnswer(answer) ? [answer[STATUS], answer.body] : [200, answer];
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({ code: 'NOT_FOUND', message: 'no such route', details: {} }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', stub);
  return calls;
}

/**
 * Renders the whole panel at `path`, with a fresh query cache and the panel's own routes; with
 * `strict`, under `StrictMode` as `main.tsx` renders it (effects run, are cleaned up and run
 * again on mount in development).
 */
export function renderAt(path: string, { strict = false }: { strict?: boolean } = {}) {
  const router = createMemoryRouter(routes, { initialEntries: [path], future: ROUTER_FUTURE });
  setUnauthorizedHandler((target) => {
    void router.navigate(target);
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tree = (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} future={PROVIDER_FUTURE} />
    </QueryClientProvider>
  );
  const utils = render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return { ...utils, router, client };
}
