# Running the E2E suite

Browser tests run against a **real backend** on a **dedicated database**
(`marketing_e2e`). They never touch the dev database, never send email and
never take payment.

## One-time

```bash
docker compose up -d postgres        # host port 5433
cd frontend && npm ci
npx playwright install chromium
```

## Every run

Two terminals.

```bash
# 1 — API on :3101 against marketing_e2e (creates + migrates + seeds it)
node ops/e2e/up.mjs

# 2 — the suite (starts Vite itself)
cd frontend && npm run e2e
```

`npm run e2e:ui` opens the Playwright UI runner; `npm run e2e:report` opens the
last HTML report.

To prepare the database without holding a terminal open:

```bash
node ops/e2e/up.mjs --db-only
```

## What the launcher overrides, and why

`backend/.env` holds **real** provider credentials copied from production. The
launcher forces these before Nest boots — do not remove them:

| Override | Reason |
|---|---|
| `DATABASE_URL` → `marketing_e2e` | The dev DB has diverged from main (branch-local migrations); E2E must be free to create and destroy data. |
| `EMAIL_*` → empty | `.env` contains a live GoDaddy SMTP account. Without this a campaign test sends real mail. |
| `PAYTR_TEST_MODE=1`, `STRIPE_*` empty | No real charges. |
| `AI_DISABLED=1` | Determinism, and no live LLM spend. Set `E2E_AI_DISABLED=0` for a spec that deliberately exercises a real AI path. |
| `PORT=3101` | Leaves the normal dev API on 3100 alone. |
| `CORS_ORIGIN` | The backend allow-lists exact origins; a Vite that auto-increments off 5173 fails CORS **in the browser only**, which reads like an auth bug. The config pins `--strictPort` for the same reason. |

## Gotcha: `backend/.env` breaks six unit tests

A populated `backend/.env` makes jest fail 6 tests in 4 suites — `sms-otp`,
`sales-call`, `review-sync` and `two-factor`. Those specs assert *unconfigured*
behaviour ("fails closed when `MARKETING_SECRET_KEY` is missing", "is inert when
no review provider is set"), and jest loads `.env`, so real credentials make the
"unconfigured" branch unreachable.

Nothing is wrong with the code. CI has no `.env` and is unaffected. To get a
clean local run:

```bash
cd backend && mv .env .env.hidden && npx jest ; mv .env.hidden .env
```

(Verified: 522 suites / 5406 tests pass with `.env` moved aside.)

## How a test gets a session

Four throttles shape the whole design, all measured against a live backend:

| Route | Limit | Consequence |
|---|---|---|
| `register-workspace` | 3/60s, **10-min block** | One registration per RUN (`global-setup.ts`). Observed: `201, 429, 429, 429`. |
| `login` | 5/60s, **5-min block** | ONE login per run, taken in `global-setup.ts` and shared by every worker. Authenticating per worker put the budget one careless re-run away from a 5-minute lockout — running the suite twice in a row did exactly that. |
| `POST /auth/refresh` | 30/60s | Avoided entirely by seeding the access token (see below). |
| global | 300/60s | Sized for one human. `THROTTLE_GLOBAL_LIMIT` raises it for the E2E stack only; production keeps 300. |
| `POST /marketing/workspaces` | none | The per-test isolation primitive. |

The session is injected into `sessionStorage` before the first navigation
(`support/session.ts`). Playwright's `storageState` **cannot** be used: the
auth store persists to sessionStorage for per-tab isolation, so the standard
recipe yields a silently logged-out browser.

Both tokens are seeded. The app itself never persists the access token, but
zustand rehydrates whatever it finds in storage — and seeding it removes the
401 → `POST /auth/refresh` that otherwise begins every page load. That endpoint
is throttled at **30/60s**, so a suite of forty tests spent its whole refresh
budget on setup and later tests silently landed on `/login`, which reads as
broken auth rather than as a rate limit.

## In CI

`.github/workflows/ci.yml` → the `frontend-e2e` job runs the same suite on every
push: postgres service → migrate → **seed packages** → build and start the
compiled API → build the frontend → Playwright against `vite preview`.

Two differences from local, both deliberate:
- CI tests the **production build**, not the dev server. The dev bundle never
  exercises the tsc gate, the chunking or the console-drop that ships.
- `reuseExistingServer` is off, so CI can never test a stale server.

On failure the job tails the API log and uploads `playwright-report/` and
`test-results/` (screenshots, video, trace) for 7 days.

## Writing a test

```ts
import { test, expect } from './support/fixtures';

test('leads list is empty for a new workspace', async ({ app }) => {
  await app.goto('/leads');
  await expect(app.getByText(/henüz lead yok/i)).toBeVisible();
});
```

`app` is a page already signed into a workspace created fresh for that test.
`workspace` gives you its id, and `api` is a request context for setup calls.

Locale is pinned to `tr-TR` in the config — the app auto-detects from
`navigator.languages` across five locales, so copy assertions would otherwise
pass or fail depending on the machine.
