import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Sparkles } from 'lucide-react';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { provisionSocialFromCampaign } from '../../../features/marketing/api/social-link.service';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Spinner } from '@/components/ui/Spinner';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table';

/** NetGSM per-jobid stats() rollup merged by campaign-sms-stats.service.ts —
 *  a JSON count-by-status map plus a `jobs` sub-object it's derived from
 *  (per-jobid latest snapshot; not itself a display value). */
interface CampaignSmsStats {
  jobs?: Record<string, Record<string, number>>;
  [status: string]: number | Record<string, Record<string, number>> | undefined;
}

interface CampaignFull {
  id: string;
  name: string;
  channel: string;
  status: string;
  stats?: (Record<string, number> & { sms?: CampaignSmsStats }) | null;
}

/** Known NetGSM delivery buckets get their own labeled cell; everything else
 *  (repeated/refunded/waiting/…) rolls up into a single "other" count so no
 *  status is ever silently dropped from the total. */
const KNOWN_SMS_STATUSES = ['delivered', 'undelivered', 'blacklist', 'iysNotValid'] as const;

function summarizeSmsStats(sms: CampaignSmsStats): { delivered: number; undelivered: number; blacklist: number; iysNotValid: number; other: number } {
  let other = 0;
  for (const [key, value] of Object.entries(sms)) {
    if (key === 'jobs' || typeof value !== 'number') continue;
    if (!(KNOWN_SMS_STATUSES as readonly string[]).includes(key)) other += value;
  }
  return {
    delivered: typeof sms.delivered === 'number' ? sms.delivered : 0,
    undelivered: typeof sms.undelivered === 'number' ? sms.undelivered : 0,
    blacklist: typeof sms.blacklist === 'number' ? sms.blacklist : 0,
    iysNotValid: typeof sms.iysNotValid === 'number' ? sms.iysNotValid : 0,
    other,
  };
}

interface RecipientRow {
  id: string;
  leadId: string;
  status: string;
  sentAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  error: string | null;
}

export interface CampaignDetailDialogProps {
  campaignId: string | null;
  onClose: () => void;
}

export function CampaignDetailDialog({ campaignId, onClose }: CampaignDetailDialogProps) {
  const { t } = useTranslation('marketing');
  const navigate = useNavigate();
  const open = !!campaignId;

  const campaignQuery = useQuery<CampaignFull>({
    queryKey: ['marketing', 'campaigns', campaignId],
    queryFn: () => marketingApi.get(`/campaigns/${campaignId}`).then((r) => r.data),
    enabled: open,
  });
  const recipientsQuery = useQuery<RecipientRow[]>({
    queryKey: ['marketing', 'campaigns', campaignId, 'recipients'],
    queryFn: () => marketingApi.get(`/campaigns/${campaignId}/recipients`).then((r) => r.data),
    enabled: open,
  });

  // Provision a Social Campaign from this blast via the dedicated prefill
  // endpoint (POST /campaigns/:id/social) — same path as the per-row
  // CampaignSocialLinkButton — so the new campaign inherits the blast's
  // audience/leads/brief and a duplicate is refused for an already-linked blast.
  const provision = useMutation({
    mutationFn: () => provisionSocialFromCampaign(campaignId!),
    onSuccess: (r) => {
      toast.success(t('campaigns.socialCreated', 'Social content campaign created'));
      navigate(`/social-campaigns/${r.socialCampaignId}`);
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message ?? t('campaigns.socialCreateFailed', 'Could not create social content')),
  });

  const c = campaignQuery.data;
  const recipients = recipientsQuery.data ?? [];

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle>{c?.name ?? t('campaigns.detail', 'Campaign')}</DialogTitle>
          <DialogDescription>
            {t('campaigns.detailSubtitle', 'Recipients and delivery stats')}
          </DialogDescription>
        </DialogHeader>

        {!c ? (
          <Spinner />
        ) : (
          <div className="space-y-4 overflow-y-auto">
            <div className="flex flex-wrap gap-2 text-sm">
              {Object.entries(c.stats ?? {}).map(([k, v]) =>
                // `sms` is a nested rollup object rendered separately below —
                // never a plain badge value (would crash: objects aren't valid JSX children).
                k === 'sms' || typeof v !== 'number' ? null : (
                  <Badge key={k} tone="neutral">{k}: {v}</Badge>
                ),
              )}
            </div>
            {c.stats?.sms && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{t('campaigns.smsDelivery', 'Delivery (NetGSM)')}:</span>
                {(() => {
                  const s = summarizeSmsStats(c.stats.sms);
                  return (
                    <>
                      <Badge tone="success">{t('campaigns.smsDelivered', 'delivered')}: {s.delivered}</Badge>
                      <Badge tone="danger">{t('campaigns.smsUndelivered', 'undelivered')}: {s.undelivered}</Badge>
                      <Badge tone="warning">{t('campaigns.smsBlacklist', 'blacklist')}: {s.blacklist}</Badge>
                      <Badge tone="warning">{t('campaigns.smsIysNotValid', 'no İYS consent')}: {s.iysNotValid}</Badge>
                      <Badge tone="neutral">{t('campaigns.smsOther', 'other')}: {s.other}</Badge>
                    </>
                  );
                })()}
              </div>
            )}
            <Table>
              <THead>
                <TR>
                  <TH>{t('campaigns.recLead', 'Lead')}</TH>
                  <TH>{t('campaigns.recStatus', 'Status')}</TH>
                  <TH>{t('campaigns.recError', 'Error')}</TH>
                </TR>
              </THead>
              <TBody>
                {recipients.map((r) => (
                  <TR key={r.id}>
                    <TD>{r.leadId}</TD>
                    <TD>{r.status}</TD>
                    <TD>{r.error ?? ''}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="secondary"
            loading={provision.isPending}
            disabled={!c}
            onClick={() => provision.mutate()}
          >
            <Sparkles className="h-4 w-4" /> {t('socialCampaign.crossLink', 'Create social content')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
