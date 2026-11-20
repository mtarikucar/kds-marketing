import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { listCapabilities } from '@/api/capabilities';
import { setPostApproval } from '@/api/knowledge';
import * as social from '@/api/social';
import type { CapabilityOut } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { QueryState } from '@/components/QueryState';
import { Button, cn, Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, Switch } from '@/components/ui';
import { can, isOwnerOrManager } from '@/lib/roles';
import { PolicyDialog } from '../capabilities/dialogs';
import { invalidateKnowledge, useKnowledge } from '../knowledge/queries';
import { AccountNumbers } from '../social/AccountHeader';
import { usePostsRead } from '../social/SettingsDialog';
import { StopList } from '../social/Stops';
import { StudioError } from '../StudioShared';
import { closedPlace, type PostsPlace } from './location';
import { useInvalidatePosts } from './queries';
import { platformName } from './words';

/** The accounts' read, shared by the page's sheets. */
export function useAccounts(enabled = true) {
  const workspace = useSession().data?.current_workspace;
  return useQuery({ queryKey: ['social', workspace, 'accounts'], queryFn: social.accountsList, enabled: enabled && !!workspace, staleTime: 30_000 });
}

/** The account's posting switch (`social.account_pause`); a stale revision is read again, never guessed. */
function PauseSwitch({ account, paused }: { account: social.SocialAccount; paused: boolean }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const refresh = useInvalidatePosts();
  const settings = usePostsRead(true);
  const revision = settings.data?.settings.revision;
  const pause = useMutation({
    mutationFn: (next: boolean) => social.accountPause(account.capability_id, next, revision!),
    onSuccess: async () => {
      await Promise.all([refresh(), client.invalidateQueries({ queryKey: ['social'] })]);
    },
    onError: () => { void settings.refetch(); },
  });
  return (
    <div className="space-y-1">
      <label className="flex min-h-9 items-center gap-2 text-sm">
        <Switch
          checked={!paused}
          aria-label={`${account.name} · ${t('postsPage.accounts.switch')}`}
          disabled={pause.isPending || settings.isFetching || !Number.isInteger(revision)}
          onCheckedChange={(on) => pause.mutate(!on)}
        />
        <span>{t('postsPage.accounts.switch')}</span>
      </label>
      <StudioError error={pause.error} />
    </div>
  );
}

/**
 * The account's post approval (§2.9.2): while Kurallar' switch is on, a read-only line; while it is
 * off, the knowledge base's per-account list (`strategy.post_approval_set`), never the
 * capability's stored flag. TikTok always waits for its own screen.
 */
function Approval({ account }: { account: social.SocialAccount }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const refresh = useInvalidatePosts();
  const session = useSession();
  const knowledge = useKnowledge();
  const rules = knowledge.data?.rules;
  const listed = !!rules?.post_approval_accounts.some((a) => a.capability_id === account.capability_id);
  const write = useMutation({
    mutationFn: (required: boolean) => setPostApproval({ capability_id: account.capability_id, required, expected_revision: rules!.revision }),
    onSuccess: async () => { await Promise.all([invalidateKnowledge(client), refresh()]); },
    onError: async () => { await invalidateKnowledge(client); },
  });
  if (account.kind === 'tiktok') return <p className="text-sm text-muted-foreground">{t('postsPage.accounts.tiktok')}</p>;
  if (!rules) return null;
  if (rules.post_approval) return <p className="text-sm text-muted-foreground">{t('postsPage.accounts.rulesAll')}</p>;
  const editable = can(session.data, 'team.manage') || can(session.data, 'social.manage');
  // Turning it off lets posts go out unseen: an owner or manager only.
  const mayTurnOff = isOwnerOrManager(session.data);
  return (
    <div className="space-y-1">
      <label className="flex min-h-9 items-center gap-2 text-sm">
        <Switch
          checked={listed}
          aria-label={`${account.name} · ${t('postsPage.accounts.approval')}`}
          disabled={!editable || write.isPending || (listed && !mayTurnOff)}
          onCheckedChange={(next) => write.mutate(next)}
        />
        <span>{t('postsPage.accounts.approval')}</span>
      </label>
      <StudioError error={write.error} />
    </div>
  );
}

/** One social account's block (§2.9.2). */
function AccountBlock({ account, capability, place, go, manage }: {
  account: social.SocialAccount;
  capability?: CapabilityOut;
  place: PostsPlace;
  go: (next: PostsPlace, options?: { replace?: boolean }) => void;
  manage: boolean;
}) {
  const { t } = useTranslation();
  const [policy, setPolicy] = useState(false);
  const open = place.account === account.capability_id;
  const locked = account.status !== 'verified';
  const status = locked ? 'broken' : account.paused ? 'paused' : 'on';
  const stops = account.stops ?? [];
  const replies = capability?.capability.policy.requires_human_approval;
  return (
    <li className="min-w-0 space-y-3 rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="break-words font-semibold">{account.name}</h3>
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className={cn('rounded px-1.5 py-0.5 text-[0.6875rem] font-bold', account.kind === 'tiktok' ? 'bg-foreground text-background' : 'bg-primary/10 text-primary')}>{platformName(account.kind)}</span>
            <span className={cn(status === 'on' ? 'text-success' : status === 'paused' ? 'text-warning' : 'text-danger')}>{t(`postsPage.accounts.status.${status}`)}</span>
          </p>
        </div>
        {manage && <PauseSwitch account={account} paused={account.paused} />}
      </div>
      {stops.some((s) => s.blocking) && <StopList kind={account.kind} capabilityId={account.capability_id} stops={stops} here />}
      <Approval account={account} />
      {replies && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {t('postsPage.accounts.replies')}
          {capability && <Button size="sm" variant="ghost" className="h-7 px-1.5 underline" onClick={() => setPolicy(true)}>{t('postsPage.accounts.change')}</Button>}
        </p>
      )}
      <div className="border-t border-border pt-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => go({ ...place, account: open ? undefined : account.capability_id, days: undefined }, { replace: true })}
          className="flex min-h-9 w-full items-center gap-1 text-sm font-medium"
        >
          <ChevronDown aria-hidden="true" className={cn('h-4 w-4 transition-transform', !open && '-rotate-90')} />
          {t('postsPage.accounts.numbers')}
        </button>
        {open && <AccountNumbers account={account} days={place.days ?? 30} onDays={(days) => go({ ...place, days: days === 30 ? undefined : days }, { replace: true })} />}
      </div>
      {policy && capability && <PolicyDialog target={capability} onClose={() => setPolicy(false)} />}
    </li>
  );
}

/**
 * Hesaplar (design 2026-11-19 §2.9.2): every connected social account, its posting switch, what
 * stops it, its post approval, and its numbers read only when opened. `Hesap bağla` goes to the
 * connect page.
 */
export function AccountsSheet({ place, go }: { place: PostsPlace; go: (next: PostsPlace, options?: { replace?: boolean }) => void }) {
  const { t } = useTranslation();
  const session = useSession();
  const accounts = useAccounts();
  const manage = can(session.data, 'social.manage');
  const connect = can(session.data, 'capabilities.manage');
  const capabilities = useQuery({ queryKey: ['capabilities', 'social-policies', session.data?.current_workspace], queryFn: () => listCapabilities({ group: 'social_account' }), retry: false });
  const close = () => go(closedPlace(place), { replace: true });
  return (
    <Sheet open onOpenChange={(next) => { if (!next) close(); }}>
      <SheetContent side="right" className="w-full max-w-none overflow-y-auto sm:max-w-xl">
        <div className="space-y-4">
          <SheetHeader className="flex flex-row flex-wrap items-center gap-3 pe-8">
            <SheetTitle>{t('postsPage.accounts.title')}</SheetTitle>
            <SheetDescription className="sr-only">{t('postsPage.accounts.help')}</SheetDescription>
            <span className="flex-1" />
            {connect && <Button size="sm" asChild><Link to="/connect">{t('postsPage.actions.connect')}</Link></Button>}
          </SheetHeader>
          <QueryState query={accounts} keepOnError>
            {accounts.data && (accounts.data.length === 0 ? (
              <p className="rounded-md border border-dashed border-border-strong px-3 py-4 text-center text-sm text-muted-foreground">{t('postsPage.accounts.empty')}</p>
            ) : (
              <ul className="space-y-3">
                {accounts.data.map((a) => (
                  <AccountBlock key={a.capability_id} account={a} capability={capabilities.data?.find((c) => c.capability.id === a.capability_id)} place={place} go={go} manage={manage} />
                ))}
              </ul>
            ))}
          </QueryState>
        </div>
      </SheetContent>
    </Sheet>
  );
}
