import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Trophy, LogOut, Users, Wallet } from 'lucide-react';
import { Button, Input, Card, CardContent, Badge, Skeleton } from '@/components/ui';

const TOKEN_KEY = 'affiliatePortalToken';

interface PortalSummary {
  affiliate: { name: string; email: string; code: string; commissionType: string; commissionValue: string; status: string; referralSlug?: string | null };
  referralPath?: string;
  referrals: Record<string, number>;
  commissions: Record<string, string>;
}
interface Referral { id: string; status: string; referredLeadId: string | null; createdAt: string; convertedAt: string | null }
interface Commission { id: string; amount: string; status: string; createdAt: string }

/** Thrown only on a real auth rejection (401/403) — distinct from transient errors. */
class PortalAuthError extends Error {}

/** Fetch a public portal resource with the affiliate bearer token. */
async function portalGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${window.location.origin}/api/public/affiliate/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401 || res.status === 403) throw new PortalAuthError('unauthorized');
  if (!res.ok) throw new Error(`HTTP ${res.status}`); // transient — don't treat as a bad token
  return res.json();
}

/**
 * Standalone, token-authenticated affiliate self-serve portal (Epic 11a). Not
 * behind the marketing-user login — the affiliate pastes the portal token their
 * manager generated; it's kept in localStorage. Read-only: their own stats,
 * referral link and payout history.
 */
export default function AffiliatePortalPage() {
  const { t } = useTranslation('marketing');
  const [token, setToken] = useState<string>(() => localStorage.getItem(TOKEN_KEY) ?? '');
  const [input, setInput] = useState('');

  const enabled = !!token;
  // retry:false on all three so a rejected (401) token doesn't trigger a retry
  // storm; a transient failure is recoverable via the explicit Retry button.
  const summary = useQuery<PortalSummary>({ queryKey: ['affPortal', 'me', token], queryFn: () => portalGet('me', token), enabled, retry: false });
  const referrals = useQuery<Referral[]>({ queryKey: ['affPortal', 'referrals', token], queryFn: () => portalGet('referrals', token), enabled, retry: false });
  const commissions = useQuery<Commission[]>({ queryKey: ['affPortal', 'commissions', token], queryFn: () => portalGet('commissions', token), enabled, retry: false });

  // Only a real auth rejection sends the affiliate back to sign-in; a transient
  // error (throttle/5xx/network) shows a recoverable "try again" state instead.
  const authFailed = summary.error instanceof PortalAuthError;

  const signIn = () => {
    const tk = input.trim();
    if (!tk) return;
    localStorage.setItem(TOKEN_KEY, tk);
    setToken(tk);
  };
  const signOut = () => {
    localStorage.removeItem(TOKEN_KEY);
    setToken('');
    setInput('');
  };

  // Sign-in screen (no token, or the token was genuinely rejected).
  if (!enabled || authFailed) {
    return (
      <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
        <div className="mb-6 text-center">
          <Trophy className="mx-auto mb-2 h-10 w-10 text-amber-500" aria-hidden="true" />
          <h1 className="text-xl font-semibold text-foreground">{t('portal.title', { defaultValue: 'Affiliate Portal' })}</h1>
          <p className="text-sm text-muted-foreground">{t('portal.signInHint', { defaultValue: 'Paste the access token your partner manager gave you.' })}</p>
        </div>
        {authFailed && <p className="mb-3 text-center text-sm text-danger">{t('portal.invalidToken', { defaultValue: 'That token was not accepted.' })}</p>}
        <div className="space-y-3">
          <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="aff_…" onKeyDown={(e) => e.key === 'Enter' && signIn()} />
          <Button className="w-full" onClick={signIn} disabled={!input.trim()}>{t('portal.signIn', { defaultValue: 'Sign in' })}</Button>
        </div>
      </div>
    );
  }

  // Transient failure (throttle / 5xx / network) — keep the session, offer a retry.
  if (summary.isError) {
    return (
      <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 text-center">
        <p className="mb-3 text-sm text-muted-foreground">{t('portal.temporarilyUnavailable', { defaultValue: 'The portal is temporarily unavailable. Please try again.' })}</p>
        <div className="flex justify-center gap-2">
          <Button onClick={() => { summary.refetch(); referrals.refetch(); commissions.refetch(); }}>{t('common.retry', { defaultValue: 'Retry' })}</Button>
          <Button variant="outline" onClick={signOut}>{t('portal.signOut', { defaultValue: 'Sign out' })}</Button>
        </div>
      </div>
    );
  }

  const a = summary.data?.affiliate;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Trophy className="h-6 w-6 text-amber-500" aria-hidden="true" />
          <div>
            <h1 className="text-lg font-semibold text-foreground">{a?.name ?? t('portal.title', { defaultValue: 'Affiliate Portal' })}</h1>
            <p className="text-xs text-muted-foreground">{a?.email}</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={signOut}><LogOut className="h-4 w-4" />{t('portal.signOut', { defaultValue: 'Sign out' })}</Button>
      </div>

      {summary.isLoading ? <Skeleton className="h-24 w-full" /> : (
        <Card>
          <CardContent className="p-5 space-y-3">
            <div>
              <p className="mb-1 text-xs text-muted-foreground">{t('portal.yourCode', { defaultValue: 'Your referral code' })}</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 rounded border border-border bg-surface-muted px-2 py-1.5 font-mono text-sm font-semibold">{a?.code}</code>
                <Button size="sm" variant="outline" onClick={() => a?.code && navigator.clipboard.writeText(a.code)}>{t('common.copy', { defaultValue: 'Copy' })}</Button>
              </div>
            </div>
            {summary.data?.referralPath && (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">{t('portal.yourLink', { defaultValue: 'Your shareable referral link' })}</p>
                {(() => {
                  const link = `${window.location.origin}${summary.data!.referralPath}`;
                  return (
                    <div className="flex items-center gap-2">
                      <code className="min-w-0 flex-1 truncate rounded border border-border bg-surface-muted px-2 py-1.5 font-mono text-sm">{link}</code>
                      <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(link)}>{t('common.copy', { defaultValue: 'Copy' })}</Button>
                    </div>
                  );
                })()}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 pt-1 sm:grid-cols-4">
              <Stat icon={<Users className="h-4 w-4" />} label={t('portal.referrals', { defaultValue: 'Referrals' })} value={Object.values(summary.data?.referrals ?? {}).reduce((s, n) => s + n, 0)} />
              <Stat icon={<Users className="h-4 w-4" />} label={t('portal.converted', { defaultValue: 'Converted' })} value={summary.data?.referrals?.CONVERTED ?? 0} />
              <Stat icon={<Wallet className="h-4 w-4" />} label={t('portal.owed', { defaultValue: 'Owed' })} value={summary.data?.commissions?.OWED ?? '0'} />
              <Stat icon={<Wallet className="h-4 w-4" />} label={t('portal.paid', { defaultValue: 'Paid' })} value={summary.data?.commissions?.PAID ?? '0'} />
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <h2 className="border-b border-border px-5 py-3 font-medium text-foreground">{t('portal.payouts', { defaultValue: 'Commissions' })}</h2>
          {(commissions.data ?? []).length === 0 ? (
            <p className="px-5 py-6 text-center text-sm text-muted-foreground">{t('portal.noPayouts', { defaultValue: 'No commissions yet.' })}</p>
          ) : (
            <ul className="divide-y divide-border">
              {(commissions.data ?? []).map((c) => (
                <li key={c.id} className="flex items-center justify-between px-5 py-2.5 text-sm">
                  <span className="text-muted-foreground">{new Date(c.createdAt).toLocaleDateString()}</span>
                  <span className="font-medium text-foreground">{c.amount}</span>
                  <Badge tone={c.status === 'PAID' ? 'success' : c.status === 'APPROVED' ? 'info' : 'neutral'} size="sm">{c.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="text-center text-xs text-muted-foreground">
        {t('portal.referralsCount', { defaultValue: '{{n}} referrals total', n: (referrals.data ?? []).length })}
      </p>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-border p-3 text-center">
      <div className="mx-auto mb-1 flex h-7 w-7 items-center justify-center rounded-full bg-surface-muted text-muted-foreground">{icon}</div>
      <p className="text-lg font-semibold tabular-nums text-foreground">{value}</p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}
