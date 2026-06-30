# TikTok Ads OAuth Frontend — Phase 2/3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add TikTok for Business OAuth connect UI to the Ad Reporting page, mirroring the social-planner OAuth connect pattern, with reconnect flow for TOKEN_EXPIRED accounts and pending-advertiser selection dialog.

**Architecture:** Add three API methods to `ads.service.ts`; add a new `TiktokAdsSelectDialog` component (analogous to social's `AccountSelectDialog`); extend `AdReportingPage` to read `?connect=<id>`/`?connect_error=1` from URL (using `useSearchParams`), show a "Connect TikTok for Business" button, handle post-OAuth dialog with checkbox list + DM toggle, and show a Reconnect button on TOKEN_EXPIRED account cards.

**Tech Stack:** React 18, TypeScript, @tanstack/react-query v5, react-router-dom v6 `useSearchParams`, react-i18next, sonner toasts, shadcn/ui Dialog/Checkbox/Switch components.

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `src/features/marketing/api/ads.service.ts` | Modify | Add 3 TikTok OAuth API methods |
| `src/pages/marketing/ads/TiktokAdsSelectDialog.tsx` | Create | Pending advertiser select + DM toggle dialog |
| `src/pages/marketing/ads/AdReportingPage.tsx` | Modify | URL param handling, Connect TikTok button, Reconnect badge, wire dialog |
| `src/pages/marketing/ads/AdReportingPage.test.tsx` | Modify | Tests for Connect TikTok button + confirm flow |
| `src/i18n/locales/en/marketing.json` | Modify | Add i18n keys for TikTok OAuth UI |

---

## Task 1: Add TikTok OAuth API methods to ads.service.ts

**Files:**
- Modify: `src/features/marketing/api/ads.service.ts`

- [ ] **Step 1: Add the three new exported types and functions**

Open `D:\HDD\projects\kds-marketing\frontend\src\features\marketing\api\ads.service.ts` and add at the bottom:

```typescript
// ── TikTok for Business OAuth ───────────────────────────────────────────────

export interface TiktokAdsPendingAdvertiser {
  externalAdId: string;
  displayName: string;
  currency: string;
}

export interface TiktokAdsPending {
  advertisers: TiktokAdsPendingAdvertiser[];
  messaging: boolean;
}

export interface TiktokAdsConfirmPayload {
  selected: string[];
  enableMessaging?: boolean;
}

export interface TiktokAdsConfirmResult {
  connectedAdAccounts: AdAccount[];
  dmChannel: unknown | null;
}

/** POST /ads/oauth/tiktok/start → { authorizeUrl } */
export const startTiktokAdsOAuth = (): Promise<{ authorizeUrl: string }> =>
  marketingApi.post('/ads/oauth/tiktok/start').then((r) => r.data);

/** GET /ads/oauth/tiktok/pending/:id */
export const getTiktokAdsPending = (id: string): Promise<TiktokAdsPending> =>
  marketingApi.get(`/ads/oauth/tiktok/pending/${id}`).then((r) => r.data);

/** POST /ads/oauth/tiktok/pending/:id/confirm */
export const confirmTiktokAdsPending = (
  id: string,
  payload: TiktokAdsConfirmPayload,
): Promise<TiktokAdsConfirmResult> =>
  marketingApi.post(`/ads/oauth/tiktok/pending/${id}/confirm`, payload).then((r) => r.data);
```

- [ ] **Step 2: Verify TypeScript compiles for this file**

```bash
cd D:\HDD\projects\kds-marketing\frontend && npx tsc --noEmit 2>&1 | head -30
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/features/marketing/api/ads.service.ts
git commit -m "feat(tiktok): add TikTok ads OAuth API methods to ads.service"
```

---

## Task 2: Add i18n keys for TikTok OAuth UI

**Files:**
- Modify: `src/i18n/locales/en/marketing.json`

- [ ] **Step 1: Add new keys to the `ads` section**

Find `"ads"` > `"toast"` block (ends around line 858). After `"pullFailed"`, before the closing `}` of `toast`, add the new toast keys. Also add a new `"oauth"` block inside `"ads"`.

The additions go inside `"ads"`:

```json
"oauth": {
  "tiktokConnect": "Connect TikTok for Business",
  "tiktokNotConfigured": "An admin must add TikTok Business app credentials first",
  "selectTitle": "Choose TikTok advertiser accounts",
  "selectBody": "Select the advertiser accounts to connect to this workspace.",
  "noAdvertisers": "No advertiser accounts found",
  "noAdvertisersHint": "Make sure you granted access to at least one TikTok advertiser account.",
  "enableDm": "Also enable TikTok DM inbox",
  "connectSelected": "Connect selected",
  "callbackError": "TikTok connection failed or was cancelled. Please try again.",
  "startFailed": "Could not start the TikTok connection"
},
"action": {
  "refresh": "Refresh",
  "disconnect": "Disconnect",
  "reconnect": "Reconnect"
}
```

Note: The `"action"` key already exists with `refresh` and `disconnect` — add `reconnect` to it.

Also add to `"toast"`:
```json
"tiktokConnected": "TikTok advertiser(s) connected",
"tiktokConnectFailed": "Failed to connect TikTok account"
```

- [ ] **Step 2: Commit**

```bash
git add src/i18n/locales/en/marketing.json
git commit -m "feat(tiktok): add i18n keys for TikTok ads OAuth UI"
```

---

## Task 3: Create TiktokAdsSelectDialog component

**Files:**
- Create: `src/pages/marketing/ads/TiktokAdsSelectDialog.tsx`

This mirrors `social/AccountSelectDialog.tsx` but:
- Uses the ads pending endpoint instead of social pending
- Shows advertiser accounts with currency info
- Shows an "Also enable TikTok DM inbox" Switch toggle when `pending.messaging === true`

- [ ] **Step 1: Create the component file**

```tsx
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Link2 } from 'lucide-react';
import {
  getTiktokAdsPending,
  confirmTiktokAdsPending,
} from '../../../features/marketing/api/ads.service';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Switch } from '@/components/ui/Switch';
import { Label } from '@/components/ui/Label';
import { EmptyState } from '@/components/ui/EmptyState';

interface Props {
  pendingId: string | null;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

/**
 * After the TikTok Business OAuth callback redirects to /ads?connect=<id>,
 * this dialog lists the advertiser accounts the user can connect and optionally
 * enables TikTok DM inbox integration.
 */
export function TiktokAdsSelectDialog({ pendingId, onOpenChange, onSuccess }: Props) {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [enableMessaging, setEnableMessaging] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['marketing', 'ads', 'tiktok', 'pending', pendingId],
    queryFn: () => getTiktokAdsPending(pendingId!),
    enabled: !!pendingId,
    retry: false,
  });

  // Default to all advertisers selected once they load.
  useEffect(() => {
    if (data?.advertisers) {
      setSelected(data.advertisers.map((a) => a.externalAdId));
    }
  }, [data]);

  const confirmMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: { selected: string[]; enableMessaging?: boolean } }) =>
      confirmTiktokAdsPending(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'ads', 'accounts'] });
      toast.success(t('ads.toast.tiktokConnected', { defaultValue: 'TikTok advertiser(s) connected' }));
      onSuccess();
      onOpenChange(false);
    },
    onError: () => {
      toast.error(t('ads.toast.tiktokConnectFailed', { defaultValue: 'Failed to connect TikTok account' }));
    },
  });

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const handleConfirm = () => {
    if (!pendingId || selected.length === 0) return;
    confirmMutation.mutate({
      id: pendingId,
      payload: { selected, enableMessaging: data?.messaging ? enableMessaging : undefined },
    });
  };

  return (
    <Dialog open={!!pendingId} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t('ads.oauth.selectTitle', { defaultValue: 'Choose TikTok advertiser accounts' })}
          </DialogTitle>
          <DialogDescription>
            {t('ads.oauth.selectBody', {
              defaultValue: 'Select the advertiser accounts to connect to this workspace.',
            })}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-2 py-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded-lg bg-surface-muted" />
            ))}
          </div>
        ) : isError || !data || data.advertisers.length === 0 ? (
          <EmptyState
            icon={<Link2 className="h-8 w-8" />}
            title={t('ads.oauth.noAdvertisers', { defaultValue: 'No advertiser accounts found' })}
            description={t('ads.oauth.noAdvertisersHint', {
              defaultValue: 'Make sure you granted access to at least one TikTok advertiser account.',
            })}
            className="border-0 py-4"
          />
        ) : (
          <div className="max-h-72 space-y-1.5 overflow-y-auto py-1">
            {data.advertisers.map((a) => (
              <label
                key={a.externalAdId}
                htmlFor={`advertiser-${a.externalAdId}`}
                className="flex cursor-pointer items-center gap-3 rounded-lg border border-border p-3 hover:bg-surface-muted"
              >
                <Checkbox
                  id={`advertiser-${a.externalAdId}`}
                  checked={selected.includes(a.externalAdId)}
                  onCheckedChange={() => toggle(a.externalAdId)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {a.displayName}
                  </span>
                  <span className="block text-micro text-muted-foreground">{a.currency}</span>
                </span>
              </label>
            ))}
          </div>
        )}

        {data?.messaging && (
          <div className="flex items-center gap-3 rounded-lg border border-border p-3">
            <Switch
              id="enable-dm"
              checked={enableMessaging}
              onCheckedChange={setEnableMessaging}
            />
            <Label htmlFor="enable-dm" className="cursor-pointer text-sm">
              {t('ads.oauth.enableDm', { defaultValue: 'Also enable TikTok DM inbox' })}
            </Label>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            type="button"
            onClick={handleConfirm}
            loading={confirmMutation.isPending}
            disabled={!data || selected.length === 0}
          >
            {t('ads.oauth.connectSelected', { defaultValue: 'Connect selected' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Check if `Switch` and `Label` components exist at the expected paths**

```bash
ls D:\HDD\projects\kds-marketing\frontend\src\components\ui\Switch.tsx
ls D:\HDD\projects\kds-marketing\frontend\src\components\ui\Label.tsx
```

If missing, look for them in the components directory and adjust the import path.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd D:\HDD\projects\kds-marketing\frontend && npx tsc --noEmit 2>&1 | head -30
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/pages/marketing/ads/TiktokAdsSelectDialog.tsx
git commit -m "feat(tiktok): add TiktokAdsSelectDialog component"
```

---

## Task 4: Extend AdReportingPage with TikTok OAuth connect

**Files:**
- Modify: `src/pages/marketing/ads/AdReportingPage.tsx`

Changes needed:
1. Import `useSearchParams` from react-router-dom
2. Import `startTiktokAdsOAuth` from ads.service
3. Import `TiktokAdsSelectDialog`
4. Add state: `pendingConnectId`, URL param effect (reads `?connect=`, `?connect_error=1`)
5. Add "Connect TikTok for Business" button to the PageHeader actions (enabled when `status?.TIKTOK`)
6. Wire `TiktokAdsSelectDialog`
7. Add Reconnect button to account cards with `status === 'TOKEN_EXPIRED'`

- [ ] **Step 1: Add imports at top of AdReportingPage.tsx**

Add to existing imports:
```typescript
import { useSearchParams } from 'react-router-dom';
import { startTiktokAdsOAuth } from '../../../features/marketing/api/ads.service';
import { TiktokAdsSelectDialog } from './TiktokAdsSelectDialog';
```

- [ ] **Step 2: Add state and URL-param effect**

Inside `AdReportingPage` function, after existing state declarations, add:

```typescript
const [searchParams, setSearchParams] = useSearchParams();
const [pendingConnectId, setPendingConnectId] = useState<string | null>(null);

// ── OAuth return handling ────────────────────────────────────────────────────
useEffect(() => {
  const connectId = searchParams.get('connect');
  const connectErr = searchParams.get('connect_error');
  if (connectId) {
    setPendingConnectId(connectId);
    setView('accounts');
    searchParams.delete('connect');
    setSearchParams(searchParams, { replace: true });
  } else if (connectErr) {
    toast.error(
      t('ads.oauth.callbackError', {
        defaultValue: 'TikTok connection failed or was cancelled. Please try again.',
      }),
    );
    searchParams.delete('connect_error');
    setSearchParams(searchParams, { replace: true });
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```

- [ ] **Step 3: Add startTikTokConnect handler**

Inside the component function (after state/effects), add:

```typescript
const startTikTokConnect = async () => {
  try {
    const { authorizeUrl } = await startTiktokAdsOAuth();
    window.location.href = authorizeUrl;
  } catch {
    toast.error(
      t('ads.oauth.startFailed', { defaultValue: 'Could not start the TikTok connection' }),
    );
  }
};
```

- [ ] **Step 4: Update PageHeader actions to include TikTok OAuth button**

Replace the existing `actions` prop in `<PageHeader>` (currently just a single "Connect account" button) with:

```tsx
actions={
  isManager ? (
    <div className="flex flex-wrap gap-2">
      <Button
        onClick={startTikTokConnect}
        disabled={!status?.TIKTOK}
        title={
          status?.TIKTOK
            ? undefined
            : t('ads.oauth.tiktokNotConfigured', {
                defaultValue: 'An admin must add TikTok Business app credentials first',
              })
        }
        variant="outline"
      >
        {t('ads.oauth.tiktokConnect', { defaultValue: 'Connect TikTok for Business' })}
      </Button>
      <Button onClick={() => setConnectOpen(true)} disabled={!canConnect} variant="outline">
        <Link2 className="h-4 w-4" aria-hidden="true" />
        {t('ads.connectAccount', { defaultValue: 'Connect account' })}
      </Button>
    </div>
  ) : undefined
}
```

- [ ] **Step 5: Wire TiktokAdsSelectDialog**

Add before the closing `</div>` at the end of the return, alongside `ConnectAdAccountDialog` and `ConfirmDialog`:

```tsx
<TiktokAdsSelectDialog
  pendingId={pendingConnectId}
  onOpenChange={(open) => { if (!open) setPendingConnectId(null); }}
  onSuccess={invalidateAccounts}
/>
```

- [ ] **Step 6: Pass `onReconnect` through AccountsView for TOKEN_EXPIRED accounts**

Update `AccountsViewProps` interface to add:
```typescript
onReconnect: () => void;
```

Update the `AccountsView` function signature to accept `onReconnect`.

In the account card render, after the existing status badge row, add a reconnect button when status is TOKEN_EXPIRED:
```tsx
{acc.status === 'TOKEN_EXPIRED' && isManager && (
  <Button
    variant="outline"
    size="sm"
    onClick={onReconnect}
  >
    <Link2 className="h-4 w-4" aria-hidden="true" />
    {t('ads.action.reconnect', { defaultValue: 'Reconnect' })}
  </Button>
)}
```

And pass `onReconnect={startTikTokConnect}` (or a smarter lookup by provider when needed) from parent to `AccountsView`:
```tsx
<AccountsView
  ...existing props...
  onReconnect={startTikTokConnect}
/>
```

Note: Since there can be both META and TIKTOK accounts, make onReconnect accept the account so it can be provider-aware:
```typescript
onReconnect: (account: AdAccount) => void;
```
And in the parent:
```typescript
const handleReconnect = (account: AdAccount) => {
  if (account.provider === 'TIKTOK') {
    void startTikTokConnect();
  }
  // META reconnect not yet implemented — button hidden for META accounts
};
```
And only show the reconnect button for TIKTOK accounts:
```tsx
{acc.status === 'TOKEN_EXPIRED' && isManager && acc.provider === 'TIKTOK' && (
  <Button variant="outline" size="sm" onClick={() => onReconnect(acc)}>
    <Link2 className="h-4 w-4" aria-hidden="true" />
    {t('ads.action.reconnect', { defaultValue: 'Reconnect' })}
  </Button>
)}
```

- [ ] **Step 7: Verify TypeScript compiles**

```bash
cd D:\HDD\projects\kds-marketing\frontend && npx tsc --noEmit 2>&1 | head -40
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/pages/marketing/ads/AdReportingPage.tsx
git commit -m "feat(tiktok): wire TikTok OAuth connect + reconnect in AdReportingPage"
```

---

## Task 5: Extend AdReportingPage tests

**Files:**
- Modify: `src/pages/marketing/ads/AdReportingPage.test.tsx`

- [ ] **Step 1: Add mock for new API functions**

Update the mock for `ads.service` to include the new functions:

```typescript
vi.mock('../../../features/marketing/api/ads.service', () => ({
  getAdStatus: vi.fn(() => Promise.resolve(STATUS)),
  listAdAccounts: vi.fn(() => Promise.resolve(ACCOUNTS)),
  getAdMetrics: vi.fn(() => Promise.resolve(METRICS)),
  connectAdAccount: vi.fn(() => Promise.resolve(ACCOUNTS[0])),
  removeAdAccount: vi.fn(() => Promise.resolve({ message: 'ok' })),
  pullAdAccount: vi.fn(() => Promise.resolve({ written: 3 })),
  startTiktokAdsOAuth: vi.fn(() => Promise.resolve({ authorizeUrl: 'https://tiktok.example/auth' })),
  getTiktokAdsPending: vi.fn(() =>
    Promise.resolve({
      advertisers: [{ externalAdId: 'adv_1', displayName: 'Acme TikTok', currency: 'USD' }],
      messaging: true,
    }),
  ),
  confirmTiktokAdsPending: vi.fn(() =>
    Promise.resolve({ connectedAdAccounts: [], dmChannel: null }),
  ),
}));
```

- [ ] **Step 2: Add test: "Connect TikTok" button enabled when status.TIKTOK is true**

```typescript
it('renders "Connect TikTok for Business" button enabled when status.TIKTOK is true', async () => {
  render(<AdReportingPage />, { wrapper });
  const btn = await screen.findByRole('button', { name: /connect tiktok for business/i });
  expect(btn).toBeInTheDocument();
  expect(btn).not.toBeDisabled();
});
```

- [ ] **Step 3: Add test: TikTok button disabled when status.TIKTOK is false**

```typescript
it('renders "Connect TikTok for Business" button disabled when status.TIKTOK is false', async () => {
  const { getAdStatus } = await import('../../../features/marketing/api/ads.service');
  (getAdStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ META: true, TIKTOK: false, secretBoxConfigured: true });
  render(<AdReportingPage />, { wrapper });
  const btn = await screen.findByRole('button', { name: /connect tiktok for business/i });
  expect(btn).toBeDisabled();
});
```

- [ ] **Step 4: Add test: pending dialog opens and confirm calls confirmTiktokAdsPending**

Import `userEvent` and add:

```typescript
import userEvent from '@testing-library/user-event';
```

```typescript
it('shows pending advertiser dialog when ?connect=<id> in URL and confirm calls confirm endpoint', async () => {
  const { confirmTiktokAdsPending } = await import('../../../features/marketing/api/ads.service');
  const user = userEvent.setup();

  function wrapperWithConnect({ children }: { children: React.ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/ads?connect=pending123']}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }

  render(<AdReportingPage />, { wrapper: wrapperWithConnect });

  // Dialog title should appear once the pending data loads
  expect(await screen.findByText(/choose tiktok advertiser accounts/i)).toBeInTheDocument();

  // Advertiser checkbox should be pre-selected
  expect(await screen.findByText('Acme TikTok')).toBeInTheDocument();

  // Click confirm
  const confirmBtn = screen.getByRole('button', { name: /connect selected/i });
  await user.click(confirmBtn);

  await waitFor(() => {
    expect(confirmTiktokAdsPending).toHaveBeenCalledWith('pending123', expect.objectContaining({ selected: ['adv_1'] }));
  });
});
```

Add `waitFor` to imports: `import { render, screen, waitFor } from '@testing-library/react';`

- [ ] **Step 5: Run the test file**

```bash
cd D:\HDD\projects\kds-marketing\frontend && npx vitest run src/pages/marketing/ads/AdReportingPage.test.tsx
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/pages/marketing/ads/AdReportingPage.test.tsx
git commit -m "test(tiktok): extend AdReportingPage tests for TikTok OAuth connect flow"
```

---

## Task 6: Final TypeScript check and cleanup commit

- [ ] **Step 1: Run full TypeScript check**

```bash
cd D:\HDD\projects\kds-marketing\frontend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 2: Run full test suite for ads page**

```bash
cd D:\HDD\projects\kds-marketing\frontend && npx vitest run src/pages/marketing/ads/AdReportingPage.test.tsx
```

Expected: all tests pass.

- [ ] **Step 3: Create final commit combining all changes if needed**

If all tasks were committed individually as above, this step is just verification. If anything was left uncommitted:

```bash
git add -A
git commit -m "feat(tiktok): ad-reporting TikTok-for-Business OAuth connect + reconnect UI (Phase 2/3 frontend)"
```
