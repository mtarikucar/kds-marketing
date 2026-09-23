import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { RoleGate } from '@/components/ui/access-gates';
import marketingApi from '@/features/marketing/api/marketingApi';
import { MarketingRole } from '@/features/marketing/types';
import { fmtDate } from '@/features/marketing/utils/format';

/**
 * "May we mail this person, and who decided that?" — rendered wherever a lead
 * is on screen, and changed from the two places the decision is recorded.
 *
 * ## The three-state rule, which is the whole of the read side
 *
 * `emailOptOut`, `emailBouncedAt` and `emailVerifiedStatus` ride along on
 * `GET /leads` and `GET /leads/:id` because both use Prisma `include` and
 * return the row's scalars unfiltered. They do NOT ride along on the lead that
 * is stitched onto a conversation payload, which carries four fields and none
 * of these.
 *
 * So a chip is printed only for an EXPLICIT `true` / non-null. `undefined` is
 * not "all clear", it is "nobody has said" — and printing "Abonelikten çıktı"
 * because a payload happened to be narrow would put a refusal on somebody who
 * never gave one, on the card a rep reads before deciding whether to send.
 * `LeadContextPane` already states this rule for `assignedTo`; these three
 * fields obey the same one.
 *
 * ## Why the chips carry no role gate and the buttons do
 *
 * The chips are plain lead scalars, and a REP must be able to see why their
 * send will fail — that is the entire complaint behind `optout-state-invisible`.
 * The buttons write the CONSENT LEDGER through `SuppressionService`, and the
 * endpoint behind them is MANAGER + `settings.manage`, matching
 * `ComplianceController`'s consent POST. A control appears with its gate, or it
 * does not appear: a rep pressing this could only ever collect a 403.
 */

export interface EmailSuppressionLead {
  id: string;
  email?: string | null;
  emailOptOut?: boolean;
  emailBouncedAt?: string | null;
  emailVerifiedStatus?: string | null;
}

export type EmailSuppressionAction = 'OPT_OUT' | 'RESUBSCRIBE' | 'CLEAR_BOUNCE';

/** What `POST /leads/:id/email-suppression` answers with. */
export interface EmailSuppressionState {
  emailOptOut: boolean;
  emailBouncedAt: string | null;
  emailVerifiedStatus: string;
  /** Would a BULK send be refused right now? */
  suppressed: boolean;
  /** The harshest standing reason, when it would be. */
  reason?: string;
}

/** The lead payload answered these fields at all — see the three-state rule. */
export function hasEmailStanding(lead: EmailSuppressionLead | null | undefined): boolean {
  return !!lead && lead.emailOptOut !== undefined;
}

/**
 * At least one chip applies — i.e. something is EXPLICITLY standing in the way.
 *
 * Separate from `hasEmailStanding` so a caller can drop its whole label/row
 * rather than render a heading over an empty chip list.
 */
export function hasEmailSuppression(lead: EmailSuppressionLead | null | undefined): boolean {
  if (!lead) return false;
  return (
    lead.emailOptOut === true || !!lead.emailBouncedAt || lead.emailVerifiedStatus === 'INVALID'
  );
}

/**
 * Inline Turkish defaults for `leads.suppression.reason.*`, in the house
 * `t(key, default)` shape — the catalogue is authoritative and carries all five
 * locales; these are what the key falls back to, and what keeps a reason the
 * server adds later showing as its bare code instead of nothing.
 *
 * Mirrors `SuppressionReason` in `compliance/suppression.service.ts`.
 */
const REASON_FALLBACK: Record<string, string> = {
  ERASURE: 'Veri silme talebi',
  HARD_BOUNCE: 'Kalıcı geri dönüş',
  INVALID: 'Geçersiz adres',
  COMPLAINT: 'Spam şikâyeti',
  OPT_OUT: 'Abonelikten çıkma',
  MANUAL: 'Elle eklendi',
};

function apiError(e: unknown, fallback: string): string {
  const msg = (e as { response?: { data?: { message?: string | string[] } } })?.response?.data
    ?.message;
  if (Array.isArray(msg)) return msg[0];
  return msg || fallback;
}

export interface EmailSuppressionChipsProps {
  lead: EmailSuppressionLead | null | undefined;
  /**
   * When the caller already knows WHEN the opt-out was recorded. The lead row
   * dates the bounce but not the refusal (there is no `emailOptOutAt` column),
   * so only a surface that has already read the consent ledger — the compliance
   * console — can date that chip. Everywhere else it is undated rather than
   * dated with a guess.
   */
  optedOutAt?: string | null;
  className?: string;
}

/** The read side. Renders nothing at all when nothing is standing. */
export function EmailSuppressionChips({
  lead,
  optedOutAt,
  className,
}: EmailSuppressionChipsProps) {
  const { t } = useTranslation('marketing');
  if (!lead) return null;

  const chips: { id: string; label: string; at?: string | null; tone: 'warning' | 'danger' }[] = [];
  if (lead.emailOptOut === true) {
    chips.push({
      id: 'optedOut',
      label: t('leads.suppression.optedOut', 'Abonelikten çıktı'),
      at: optedOutAt,
      tone: 'warning',
    });
  }
  if (lead.emailBouncedAt) {
    chips.push({
      id: 'bounced',
      label: t('leads.suppression.bounced', 'Geri döndü (bounce)'),
      at: lead.emailBouncedAt,
      tone: 'danger',
    });
  }
  if (lead.emailVerifiedStatus === 'INVALID') {
    chips.push({
      id: 'invalid',
      label: t('leads.suppression.invalid', 'Geçersiz adres'),
      tone: 'danger',
    });
  }
  if (!chips.length) return null;

  return (
    <div
      data-testid="email-suppression-chips"
      className={`flex flex-wrap items-center gap-1.5 ${className ?? ''}`}
    >
      {chips.map((c) => (
        <Badge
          key={c.id}
          data-testid={`email-chip-${c.id}`}
          tone={c.tone}
          size="sm"
          // The date is in the badge so it is READ, and repeated in the title
          // as a sentence for anyone hearing the page rather than seeing it.
          title={
            c.at
              ? t('leads.suppression.since', {
                  date: fmtDate(c.at),
                  defaultValue: '{{date}} tarihinden beri',
                })
              : undefined
          }
        >
          {c.label}
          {c.at && <span className="opacity-70">· {fmtDate(c.at)}</span>}
        </Badge>
      ))}
    </div>
  );
}

export interface EmailSuppressionActionsProps {
  lead: EmailSuppressionLead | null | undefined;
  /** Called with the state the server answered, for a caller holding its own copy. */
  onChanged?: (state: EmailSuppressionState) => void;
  className?: string;
}

/**
 * The write side: opt out, put back, or clear a machine verdict.
 *
 * Absent — not disabled — when there is no address to act on or when the
 * payload never answered the fields. A button whose only possible outcome is a
 * 400 is worse than no button, and this file's own three-state rule says an
 * unanswered field is not a state to offer a toggle for.
 */
export function EmailSuppressionActions({
  lead,
  onChanged,
  className,
}: EmailSuppressionActionsProps) {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();

  const act = useMutation<EmailSuppressionState, unknown, EmailSuppressionAction>({
    mutationFn: (action) =>
      marketingApi
        .post(`/leads/${lead?.id}/email-suppression`, { action })
        .then((r) => r.data as EmailSuppressionState),
    onSuccess: (state, action) => {
      // Three caches hold a copy of these columns: the lead detail
      // (`['marketing','lead']`), every lead list (`['marketing','leads']`) and
      // the compliance console's own search + consent reads.
      queryClient.invalidateQueries({ queryKey: ['marketing', 'lead'] });
      queryClient.invalidateQueries({ queryKey: ['marketing', 'leads'] });
      queryClient.invalidateQueries({ queryKey: ['marketing', 'compliance'] });
      onChanged?.(state);

      // A lift can answer 200 and change nothing: `writeLift` refuses to clear
      // a column another standing reason still demands (a live COMPLAINT owns
      // `emailOptOut` too). Reporting that as success is the same lie a 2xx
      // FAILED send is, so the standing reason is named instead.
      if (action !== 'OPT_OUT' && state?.suppressed) {
        // A code we have no copy for is DROPPED, not printed: a server reason
        // reaching a Turkish customer as `SUPPRESSED_COMPLAINT` is worse than
        // the generic sentence on its own.
        const known = state.reason ? REASON_FALLBACK[state.reason] : undefined;
        const reason = known ? t(`leads.suppression.reason.${state.reason}`, known) : '';
        const base = t('leads.suppression.updateFailed', 'E-posta durumu güncellenemedi');
        toast.error(reason ? `${base}: ${reason}` : base);
        return;
      }
      toast.success(t('leads.suppression.updated', 'E-posta durumu güncellendi'));
    },
    onError: (e) =>
      toast.error(
        apiError(e, t('leads.suppression.updateFailed', 'E-posta durumu güncellenemedi')),
      ),
  });

  if (!lead?.email?.trim() || !hasEmailStanding(lead)) return null;

  const optedOut = lead.emailOptOut === true;
  const machineVerdict = !!lead.emailBouncedAt || lead.emailVerifiedStatus === 'INVALID';

  return (
    <RoleGate role={MarketingRole.MANAGER}>
      <div
        data-testid="email-suppression-actions"
        className={`flex flex-wrap items-center gap-2 ${className ?? ''}`}
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={act.isPending}
          onClick={() => act.mutate(optedOut ? 'RESUBSCRIBE' : 'OPT_OUT')}
        >
          {optedOut
            ? t('leads.suppression.resubscribe', 'Yeniden abone et')
            : t('leads.suppression.optOut', 'Pazarlama e-postasından çıkar')}
        </Button>
        {machineVerdict && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={act.isPending}
            onClick={() => act.mutate('CLEAR_BOUNCE')}
          >
            {t('leads.suppression.clearBounce', 'Bounce kaydını temizle')}
          </Button>
        )}
      </div>
    </RoleGate>
  );
}

export interface EmailSuppressionPanelProps extends EmailSuppressionChipsProps {
  onChanged?: (state: EmailSuppressionState) => void;
}

/**
 * Chips + controls under one heading — the shape the compliance console and the
 * lead header both want. "Nothing is standing in the way" is said out loud, but
 * only for a payload that actually answered: silence is what an unanswered
 * field earns.
 */
export function EmailSuppressionPanel({
  lead,
  optedOutAt,
  onChanged,
  className,
}: EmailSuppressionPanelProps) {
  const { t } = useTranslation('marketing');
  if (!lead) return null;

  const clear =
    hasEmailStanding(lead) &&
    lead.emailOptOut !== true &&
    !lead.emailBouncedAt &&
    lead.emailVerifiedStatus !== 'INVALID';

  return (
    <div className={`space-y-2 ${className ?? ''}`}>
      <p className="text-sm font-medium text-foreground">
        {t('leads.suppression.title', 'E-posta durumu')}
      </p>
      <EmailSuppressionChips lead={lead} optedOutAt={optedOutAt} />
      {clear && (
        <p className="text-caption text-muted-foreground">
          {t('leads.suppression.none', 'Bu kişiye e-posta gönderilebilir.')}
        </p>
      )}
      <EmailSuppressionActions lead={lead} onChanged={onChanged} />
    </div>
  );
}
