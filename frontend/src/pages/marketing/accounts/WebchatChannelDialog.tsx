import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, MessageCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { CopyField } from './CopyField';

const NONE = '__none__';

/**
 * Web chat setup for the Account Center. A WEBCHAT channel is an embeddable chat
 * bubble for the customer's own website — visitors chat and the workspace's AI
 * agent answers. No credentials; the two things that actually matter are (1) an
 * answering agent (else nobody auto-replies) and (2) the embed snippet. Both are
 * surfaced here so it's finally self-explanatory.
 */
export function WebchatChannelDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation('marketing');
  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState(NONE);
  const [greeting, setGreeting] = useState('');
  const [created, setCreated] = useState<{ id: string; widgetKey: string | null } | null>(null);

  const { data: agents, isLoading: agentsLoading, isError: agentsError } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['marketing', 'ai', 'agents'],
    queryFn: () => marketingApi.get('/ai/agents').then((r) => r.data),
    enabled: open,
  });

  useEffect(() => {
    if (!open) {
      setName('');
      setAgentId(NONE);
      setGreeting('');
      setCreated(null);
    }
  }, [open]);

  const create = useMutation({
    mutationFn: () =>
      marketingApi
        .post('/channels', {
          type: 'WEBCHAT',
          name: name.trim(),
          agentProfileId: agentId !== NONE ? agentId : undefined,
          configPublic: greeting.trim() ? { greeting: greeting.trim() } : undefined,
        })
        .then((r) => r.data as { id: string; widgetKey: string | null }),
    onSuccess: (ch) => {
      setCreated(ch);
      onCreated();
      toast.success(t('accounts.webchat.created', 'Web chat created'));
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || t('accounts.channelFailed', 'Could not connect the channel')),
  });

  const embed = created?.widgetKey
    ? `<script src="${window.location.origin}/widget.js" data-widget-key="${created.widgetKey}" async></script>`
    : '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('accounts.webchat.title', 'Web chat')}</DialogTitle>
          <DialogDescription>
            {t('accounts.webchat.desc', 'Add a live chat bubble to your website. Visitors chat from your site and your AI agent answers automatically — no credentials needed.')}
          </DialogDescription>
        </DialogHeader>

        {!created ? (
          <div className="space-y-3">
            <Input
              placeholder={t('accounts.webchat.name', 'Widget name (shown in the header)')}
              aria-label={t('accounts.webchat.name', 'Widget name (shown in the header)')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <div className="space-y-1.5">
              <label htmlFor="webchat-agent" className="text-sm font-medium text-foreground">{t('accounts.webchat.agent', 'Answering AI agent')}</label>
              <Select value={agentId} onValueChange={setAgentId}>
                <SelectTrigger id="webchat-agent">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('accounts.webchat.noAgent', '— none (manual inbox only) —')}</SelectItem>
                  {agentsLoading && (
                    <div className="px-2 py-1.5">
                      <Skeleton className="h-4 w-32" />
                    </div>
                  )}
                  {agents?.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {agentsError && (
                <p className="text-caption text-danger">
                  {t('accounts.webchat.agentsError', "Couldn't load agents — the list may be incomplete.")}
                </p>
              )}
              {agentId === NONE && !agentsLoading && (
                <p className="flex items-center gap-1.5 text-caption text-warning">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('accounts.webchat.noAgentWarn', 'Without an agent, messages land in your inbox but nobody auto-replies.')}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <label htmlFor="webchat-greeting" className="text-sm font-medium text-foreground">{t('accounts.webchat.greeting', 'Greeting (optional)')}</label>
              <Textarea id="webchat-greeting" rows={2} value={greeting} onChange={(e) => setGreeting(e.target.value)} placeholder={t('accounts.webchat.greetingPh', 'Hi! How can we help?')} />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 p-2 text-sm text-foreground">
              <MessageCircle className="h-4 w-4 text-success" /> {t('accounts.webchat.ready', 'Your web chat is ready. Add it to your site:')}
            </div>
            <CopyField
              label={t('accounts.webchat.embedLabel', 'Paste this just before </body> on every page')}
              value={embed}
              multiline
            />
            <a
              href={`${window.location.origin}/widget?key=${created.widgetKey}`}
              target="_blank"
              rel="noreferrer"
              className="text-caption text-primary hover:underline"
            >
              {t('accounts.webchat.preview', 'Preview the widget →')}
            </a>
          </div>
        )}

        <DialogFooter>
          {!created ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel', 'Cancel')}</Button>
              <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim()}>
                {t('accounts.connect', 'Connect')}
              </Button>
            </>
          ) : (
            <Button onClick={() => onOpenChange(false)}>{t('common.done', 'Done')}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
