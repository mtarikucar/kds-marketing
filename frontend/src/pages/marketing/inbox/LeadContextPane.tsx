import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ArrowRight, X } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { IconButton } from '@/components/ui/IconButton';
import { FeatureGate, RoleGate } from '@/components/ui/access-gates';
import { fmtDate } from '../../../features/marketing/utils/format';
import { MarketingRole, type Lead } from '../../../features/marketing/types';
import { PersonAppointments } from './PersonAppointments';
import { PersonDeals } from './PersonDeals';
import { PersonEstimates } from './PersonEstimates';
import { PersonOffers } from './PersonOffers';
import { PersonTasks } from './PersonTasks';
import { RecordDisclosure } from './RecordDisclosure';

/**
 * The fields this card reads. A structural subset of `Lead` rather than `Lead`
 * itself, because the card is also handed the (narrower) lead that rides on a
 * conversation payload, and widening the prop to the full model would make
 * those call sites lie about what they have.
 */
export type RecordCardLead = Pick<Lead, 'id'> &
  Partial<
    Pick<
      Lead,
      | 'businessName'
      | 'contactPerson'
      | 'phone'
      | 'email'
      | 'city'
      | 'status'
      | 'source'
      | 'businessType'
      | 'createdAt'
      | 'assignedTo'
    >
  >;

export interface LeadContextPaneProps {
  /** Null before anyone is selected — the card says so rather than rendering
   *  an empty shell that looks like a person with no details. */
  lead: RecordCardLead | null | undefined;
  /** Below `lg` three columns cannot coexist, so the card arrives as a sheet. */
  asSheet?: boolean;
  onClose?: () => void;
  className?: string;
}

/**
 * The right column: the selected person's record card.
 *
 * It is the ONLY navigation on the whole surface, and that is deliberate rather
 * than incidental. Every other click here selects; the one link goes to
 * `/leads/:id`, where the four-tab detail does the deep work (Akış, Satış,
 * Teklifler, Görevler). A test counts the links inside the card, because a
 * second one appearing later is exactly how "selecting is not navigating"
 * quietly stops being true.
 *
 * The card grew out of the Inbox's lead-context pane, which showed four fields
 * because the object beside it was a conversation. The object is now the
 * person, so it carries what someone triaging needs before they commit to
 * opening the record: who, where they stand, WHO OWNS THEM — unowned said out
 * loud, since that is the whole point of the Atanmamış queue one column over —
 * and how to reach them.
 */
export function LeadContextPane({ lead, asSheet, onClose, className }: LeadContextPaneProps) {
  const { t } = useTranslation('marketing');

  const body: ReactNode = lead ? (
    <div data-testid="record-card" className="space-y-3 text-sm">
      <div>
        {lead.contactPerson && (
          <p className="font-medium text-foreground">{lead.contactPerson}</p>
        )}
        {lead.businessName && <p className="text-muted-foreground">{lead.businessName}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {lead.status && <Badge tone="neutral">{lead.status}</Badge>}
        {lead.source && (
          <Badge tone="neutral" size="sm">
            {lead.source}
          </Badge>
        )}
      </div>

      <dl className="space-y-1 text-xs">
        <Row label={t('surface.card.owner', 'Sahibi')}>
          <span data-testid="record-owner">
            {lead.assignedTo
              ? `${lead.assignedTo.firstName} ${lead.assignedTo.lastName}`.trim()
              : t('leads.assignmentStatus.unassigned', 'Atanmamış')}
          </span>
        </Row>
        {lead.phone && <Row label={t('surface.card.phone', 'Telefon')}>{lead.phone}</Row>}
        {lead.email && <Row label={t('surface.card.email', 'E-posta')}>{lead.email}</Row>}
        {lead.city && <Row label={t('surface.card.city', 'Şehir')}>{lead.city}</Row>}
        {lead.createdAt && (
          <Row label={t('surface.card.created', 'Kayıt')}>{fmtDate(lead.createdAt)}</Row>
        )}
      </dl>

      {/* SATIŞ — the deal is a FIELD of this person, and its stage moves from
          right here. `key` is the ONE reset for the section's per-deal state:
          the card is handed a new person rather than remounted by the router
          (selecting is not navigating), so an optimistic stage set for A would
          otherwise still be on screen under B. Same mechanism, and the same
          reason, as the middle column's `key` in InboxPage. */}
      <PersonDeals key={lead.id} leadId={lead.id} />

      {/* GÖREVLER and TEKLİFLER — the person's other two fields that the
          person's OWN record already carries. One `GET /leads/:id` serves both
          sections (React Query dedupes the shared key), so they cost one
          request between them and warm the cache for the link below. Both
          render the lead detail's own tabs in `embedded` chrome; see
          useLeadRecord.ts for the eager-vs-lazy rule and for the cost of the
          shared key, which is a shared FATE when it fails. */}
      <PersonTasks key={`tasks-${lead.id}`} leadId={lead.id} />
      <PersonOffers key={`offers-${lead.id}`} leadId={lead.id} />

      {/* TAHMİNİ FİYAT and RANDEVULAR each need their own endpoint, for objects
          most contacts do not have — so they wait until someone opens them
          rather than costing two requests per row a rep clicks. The `key` is
          the ONE reset for "is this section open", which is per-person state on
          a card that is handed a new person rather than remounted: the same
          mechanism, and the same reason, as PersonDeals above. */}
      <RecordDisclosure
        key={`estimates-${lead.id}`}
        data-testid="record-estimates"
        title={t('surface.estimates.title', 'Tahmini fiyat')}
      >
        <PersonEstimates leadId={lead.id} />
      </RecordDisclosure>
      {/* RANDEVULAR is the one section whose read is not open to everyone.
          `MarketingBookingController` is `@MarketingRoles('MANAGER')` +
          `@RequiresFeature('funnels')`, so the section carries the SAME two
          gates — a control appears with its gate, or it does not appear.
          Ungated, a REP opening this on `/leads` got two 403s, a global error
          toast and a permanent "Randevular yüklenemedi." whose Retry could
          never succeed: a permission answer rendered as a failure.

          The two gates get different answers on purpose, because the reader
          can act on one and not the other. Role → HIDDEN: a REP cannot buy
          their way out of their own role, and navigation.ts already hides
          /appointments from them (`managerOnly`), so naming it here would make
          this card the only place a rep is told about a surface they can never
          reach. Plan → NAMED: that is PersonPane's `conversationAi` line one
          column over, and the rule LeadStream states outright — COULD NOT READ
          IT and YOUR PLAN DOES NOT INCLUDE IT stay two sentences, because a
          plan limit told as a failure sends a billing question to support.

          Both gates fail CLOSED while `/billing/summary` is in flight, exactly
          as the menu and `FeatureGate` do; the summary is already in cache from
          the shell by the time a card renders, so this costs no request. */}
      <RoleGate role={MarketingRole.MANAGER}>
        <FeatureGate
          feature="funnels"
          fallback={
            <section
              data-testid="record-appointments-gated"
              className="space-y-2 border-t border-border pt-3"
            >
              {/* Deliberately NOT a disclosure: there is nothing behind the
                  toggle, and an affordance that opens onto a plan notice is
                  the same empty promise as one that opens onto a 403. */}
              <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t('surface.appointments.title', 'Randevular')}
              </h4>
              <p className="text-[11px] text-info">
                {t('surface.appointments.gated', 'Randevular paketinde yok')} —{' '}
                {t(
                  'surface.appointments.gatedHint',
                  'takvim aboneliğinde yok; eklendiğinde bu kişinin randevuları burada görünür',
                )}
              </p>
            </section>
          }
        >
          <RecordDisclosure
            key={`appointments-${lead.id}`}
            data-testid="record-appointments"
            title={t('surface.appointments.title', 'Randevular')}
          >
            <PersonAppointments leadId={lead.id} />
          </RecordDisclosure>
        </FeatureGate>
      </RoleGate>

      {/* The one door off this surface. */}
      <Link
        to={`/leads/${lead.id}`}
        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
      >
        {t('surface.card.open', 'Kaydı aç')}
        <ArrowRight className="h-3 w-3" aria-hidden="true" />
      </Link>
    </div>
  ) : (
    <p data-testid="record-card-idle" className="text-xs text-muted-foreground">
      {t('surface.card.idle', 'Soldan bir kişi seç.')}
    </p>
  );

  if (asSheet) {
    return (
      <div className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center lg:hidden">
        <div className="absolute inset-0 bg-black/40" onClick={onClose} />
        <div className="relative max-h-[80vh] w-full overflow-y-auto rounded-t-2xl border border-border bg-surface p-4 shadow-xl sm:max-w-md sm:rounded-2xl">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('surface.card.title', 'Kayıt')}
            </h3>
            <IconButton
              variant="ghost"
              size="sm"
              aria-label={t('common.close', 'Kapat')}
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </IconButton>
          </div>
          {body}
        </div>
      </div>
    );
  }

  return (
    <Card className={`flex-col overflow-y-auto ${className ?? ''}`}>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('surface.card.title', 'Kayıt')}
        </CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-end text-foreground">{children}</dd>
    </div>
  );
}
