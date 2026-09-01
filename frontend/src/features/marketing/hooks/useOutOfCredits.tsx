import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useMarketingAuthStore } from '@/store/marketingAuthStore';

/**
 * Running out of AI credits, said once and said the same way everywhere.
 *
 * The backend answers an exhausted workspace with 403 + `AI_CREDITS_EXHAUSTED`
 * (ai-credits.service.ts). Every call site used to handle that differently:
 * some echoed the backend's English sentence straight into a Turkish UI, some
 * swallowed it into "Generation failed", one wrote the raw error code into a
 * `title=` tooltip — and none of them said what the user could do next. Worse,
 * "what you can do next" is not the same for everyone: only an OWNER can buy
 * credits (`@MarketingRoles('OWNER')` on /billing/checkout), so telling a REP
 * to go buy a pack is an instruction they cannot follow.
 *
 * Two exports on purpose. `isCreditsExhausted` is pure so code outside the
 * router tree can still classify the error; the hook needs `useNavigate` for
 * the toast action and therefore may only be called inside it.
 */
export function isCreditsExhausted(e: unknown): boolean {
  const res = (e as { response?: { status?: number; data?: { code?: string } } } | null | undefined)
    ?.response;
  // BOTH halves are load-bearing. A 403 also carries FEATURE_NOT_IN_PACKAGE,
  // which is a genuine upgrade prompt and must not be re-labelled as a credit
  // wall; and a 500 that happens to mention the code is a server fault, not a
  // billing state.
  return res?.status === 403 && res?.data?.code === 'AI_CREDITS_EXHAUSTED';
}

export function useOutOfCredits() {
  const { t } = useTranslation('marketing');
  const navigate = useNavigate();
  const role = useMarketingAuthStore((s) => s.user?.role);
  const isOwner = role === 'OWNER';

  const body = isOwner
    ? t(
        'credits.exhausted.owner.body',
        "You're out of AI credits. This action spends credits — buy a pack in Billing and pick up where you left off.",
      )
    : t(
        'credits.exhausted.member.body',
        'This workspace is out of AI credits. Only the workspace owner can buy a pack — ask them to add credits in Billing.',
      );

  // The link is offered to exactly the roles whose nav already contains
  // /billing (navigation.ts:501 is `managerOnly`), so a CTA never points at a
  // page the user has no other way to reach. A REP gets the copy — which names
  // who can act — and no dead end.
  const cta = isOwner
    ? { label: t('credits.exhausted.owner.cta', 'Add credits'), to: '/billing' }
    : role === 'MANAGER'
      ? { label: t('credits.exhausted.manager.cta', 'Open Billing'), to: '/billing' }
      : null;

  const ctaLabel = cta?.label;
  const ctaTo = cta?.to;

  /**
   * Raise the surface unconditionally. Separate from `notify` because not every
   * exhaustion arrives as a rejected request: a fan-out publish RESOLVES and
   * carries the failure per target, as a string.
   */
  const notifyExhausted = useCallback(() => {
    toast.error(body, {
      // One id for the whole class: publishing to N accounts fails N times and
      // must not stack N identical billing toasts on top of each other.
      id: 'ai-credits-exhausted',
      duration: 10_000,
      action: ctaLabel && ctaTo ? { label: ctaLabel, onClick: () => navigate(ctaTo) } : undefined,
    });
  }, [body, ctaLabel, ctaTo, navigate]);

  const notify = useCallback(
    (e: unknown, fallback: string) => {
      if (!isCreditsExhausted(e)) {
        toast.error(fallback);
        return;
      }
      notifyExhausted();
    },
    [notifyExhausted],
  );

  return { isCreditsExhausted, body, cta, notify, notifyExhausted };
}
