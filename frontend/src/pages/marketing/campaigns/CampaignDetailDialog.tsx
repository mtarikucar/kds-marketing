import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Sparkles } from 'lucide-react';
import marketingApi from '../../../features/marketing/api/marketingApi';
import {
  createSocialCampaign,
  type SocialCampaignPayload,
} from '../../../features/marketing/api/socialCampaigns.service';
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

interface CampaignFull {
  id: string;
  name: string;
  channel: string;
  status: string;
  stats?: Record<string, number> | null;
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

  const provision = useMutation({
    mutationFn: () => {
      const c = campaignQuery.data!;
      const payload: SocialCampaignPayload = {
        name: c.name,
        automationMode: 'APPROVAL',
        planningMode: 'AI_PROPOSE',
        cadence: {
          perWeek: 3,
          daysOfWeek: [1, 3, 5],
          timeOfDay: '09:00',
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        startDate: new Date().toISOString(),
        targetAccountIds: [],
        mediaKinds: ['IMAGE'],
        linkedCampaignId: c.id,
      };
      return createSocialCampaign(payload);
    },
    onSuccess: (sc) => {
      toast.success(t('socialCampaign.provisioned', 'Social campaign created'));
      navigate(`/social-campaigns/${sc.id}`);
    },
    onError: () => toast.error(t('socialCampaign.provisionFailed', 'Could not create social content')),
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
              {Object.entries(c.stats ?? {}).map(([k, v]) => (
                <Badge key={k} tone="neutral">{k}: {v}</Badge>
              ))}
            </div>
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
