import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Textarea';
import { Callout } from '@/components/ui/Callout';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { ClickToDialButton } from '../../../features/marketing/components';
import { useEntitlements } from '../../../features/marketing/hooks/useEntitlements';
import marketingApi from '../../../features/marketing/api/marketingApi';
import {
  listConversations,
  startConversation,
  type ConversationSummary,
  type StartedConversation,
} from '../../../features/marketing/api/conversations.service';

/**
 * Which channel types THIS DIALOG can open a conversation on.
 *
 * A SUBSET of OutboundConversationService's INITIABLE map, and deliberately so.
 * The map's exclusions are platform rules — Instagram/Messenger/TikTok only
 * permit a reply to someone who wrote first, webchat identities exist only once
 * the visitor opens the widget, voice is inbound — and they apply here
 * unchanged.
 *
 * WhatsApp is the one the backend allows and this dialog must not offer. It is
 * INITIABLE with `supportsTemplate: true`, which is the backend saying "bring
 * an approved template", not "free text is fine". This dialog has no template
 * field, and it only ever opens when `listConversations({ leadId })` came back
 * EMPTY — no status filter, so the lead has no WhatsApp thread of any kind and
 * no inbound WhatsApp message was ever ingested for them. Meta's 24h session
 * window is therefore shut, every time, and free text is refused.
 *
 * What makes that unacceptable rather than merely unlucky:
 * MessageSenderService.send does not THROW when an adapter rejects a send — it
 * records the Message FAILED, refunds the quota, logs, and returns. So
 * `POST /conversations/start` answers 2xx, this dialog toasts "Mesaj
 * gönderildi" and lands the rep on a thread whose only message never left the
 * building. A button that fails when clicked is worse than no button; a button
 * that reports success and sends nothing is worse than both.
 *
 * NOTE: nothing ties this list to the backend's — it is a hand-copy, and now a
 * deliberately divergent one. Offering WhatsApp here again means giving the
 * dialog a template picker first.
 */
const INITIABLE_CHANNEL_TYPES = ['SMS', 'EMAIL'];

interface ChannelRow {
  id: string;
  type: string;
  name: string;
  status: string;
}

export interface LeadHeaderActionsProps {
  /** Only the fields these two actions actually decide on. */
  lead: { id: string; phone?: string | null; smsOptOut?: boolean };
  /** Bring the person's Akış stream forward — the app has no per-thread deep
   *  link, so "open the conversation" means "show me this person's stream". */
  onOpenStream: () => void;
}

const errMsg = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message || fallback;

/**
 * "Ara" and "Mesaj" on the lead header — spec §3.
 *
 * Neither is a new path. Ara mounts the EXISTING ClickToDialButton with this
 * lead's id, which is the whole point: SalesCallService.logCall writes a CALL
 * LeadActivity off `call.leadId`, so a call placed from here mirrors onto the
 * person's Akış stream without anything new being written for it. Mesaj posts to the
 * existing `POST /conversations/start`, which until now had no caller in the
 * frontend at all.
 *
 * Ara is ABSENT, not disabled, when the workspace has no telephony, when the
 * lead has no number, or when the lead has opted out of phone contact: a button
 * that fails when clicked is worse than no button.
 */
export default function LeadHeaderActions({ lead, onOpenStream }: LeadHeaderActionsProps) {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const { has } = useEntitlements();
  // Both halves of Mesaj — `GET /conversations` and `POST /conversations/start`
  // — sit behind @RequiresFeature('conversationAi'). Without it the button
  // could only ever 403, which is the same "fails when clicked" that keeps Ara
  // off a lead with no number. (useEntitlements reuses the billing-summary
  // query the page already holds, so this costs no request, and it fails
  // CLOSED while that loads — same as the nav.)
  const canMessage = has('conversationAi');
  const [startOpen, setStartOpen] = useState(false);
  const [channelId, setChannelId] = useState('');
  const [text, setText] = useState('');

  const phone = lead.phone?.trim() || '';
  // Same shape as canMessage, one gate over: `POST /calls/start` is behind
  // @RequiresFeature('telephony') at CONTROLLER level (SalesCallController),
  // while `/leads` carries no feature at all in navigation.ts — so a workspace
  // without telephony reaches this header freely and would be offered a dial
  // button whose only possible outcome is a 403. The consent + reachability
  // terms stay: entitlement says the workspace MAY dial, the other two say this
  // lead may be dialled.
  const callable = has('telephony') && !!phone && !lead.smsOptOut;

  // Mesaj has to know whether a thread exists before it can choose between
  // opening one and starting one. The key is still the conversations prefix the
  // Inbox's SSE stream invalidates, so a reply arriving while this page is open
  // flips the button's job without a reload.
  const threads = useQuery<ConversationSummary[]>({
    queryKey: ['marketing', 'conversations', 'lead', lead.id],
    queryFn: () => listConversations({ leadId: lead.id }),
    enabled: canMessage,
  });

  const channels = useQuery<ChannelRow[]>({
    queryKey: ['marketing', 'channels'],
    queryFn: () => marketingApi.get('/channels').then((r) => r.data),
    enabled: startOpen,
  });

  const startable = (channels.data ?? []).filter(
    (c) => INITIABLE_CHANNEL_TYPES.includes(c.type) && c.status === 'ACTIVE',
  );

  const start = useMutation<StartedConversation>({
    mutationFn: () => startConversation({ leadId: lead.id, channelId, text: text.trim() }),
    onSuccess: (res) => {
      // The thread and its Message row exist on BOTH branches, so the cache
      // that says "this lead has no conversations" is stale either way — and a
      // failed send is exactly the moment we must not keep claiming there is
      // nothing here.
      queryClient.invalidateQueries({ queryKey: ['marketing', 'conversations'] });

      // A 2xx is the REQUEST succeeding, not the send. MessageSenderService
      // catches an adapter rejection, persists the Message as FAILED with the
      // provider's reason, refunds the quota and RETURNS
      // (message-sender.service.ts:78-93, :177) — so `POST
      // /conversations/start` answers 200 for a message that never left the
      // building. Channel-agnostic: SMS and email reach it as readily as
      // WhatsApp does. `message.status` is the only witness.
      if (res?.message?.status === 'FAILED') {
        const base = t('leadDetail.startConversation.failed', 'Mesaj gönderilemedi');
        const reason = res.message.error?.trim();
        toast.error(reason ? `${base}: ${reason}` : base);
        // Deliberately NOT navigating, and deliberately leaving the dialog
        // open with the text intact.
        //
        // The original reason no longer holds and is recorded here because
        // the behaviour outlived it: ConversationsTab rendered
        // `lastMessage.body` with no per-message failure indicator, so landing
        // the rep there after a failure showed their own copy reading exactly
        // like a delivered message. LeadStream closed that — a FAILED message
        // now carries the word and the provider's reason on the bubble itself.
        //
        // What still holds is the retry. The channel picker and the typed
        // message are on screen; staying makes trying another channel one
        // click instead of a re-typed message, and nothing is hidden by it —
        // the thread is real, the list is invalidated, and the next Mesaj
        // click opens Akış rather than this dialog.
        return;
      }

      toast.success(t('leadDetail.startConversation.sent', 'Mesaj gönderildi'));
      setStartOpen(false);
      setText('');
      setChannelId('');
      // The thread now exists and carries a message that actually went out —
      // land the user on it.
      onOpenStream();
    },
    onError: (e) =>
      toast.error(errMsg(e, t('leadDetail.startConversation.failed', 'Mesaj gönderilemedi'))),
  });

  const onMessage = () => {
    // A failed thread lookup is NOT "no threads": sending the user to the tab
    // lets the failure say so by name, where guessing "none" would open a
    // start flow on top of a conversation that may well already exist.
    if (threads.isError || (threads.data?.length ?? 0) > 0) {
      onOpenStream();
      return;
    }
    setStartOpen(true);
  };

  return (
    <>
      {callable && <ClickToDialButton leadId={lead.id} defaultPhone={phone} />}

      {canMessage && (
      <Button
        variant="outline"
        size="sm"
        onClick={onMessage}
        // Until the lookup settles this button cannot know which of its two
        // jobs it has; clicking early would deterministically pick "start a
        // new one" on a lead that has threads.
        disabled={threads.isLoading}
      >
        <MessageSquare className="h-4 w-4" /> {t('leadDetail.actions.message', 'Mesaj')}
      </Button>
      )}

      <Dialog open={startOpen} onOpenChange={setStartOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('leadDetail.startConversation.title', 'Konuşma başlat')}</DialogTitle>
            <DialogDescription>
              {t(
                'leadDetail.startConversation.desc',
                'Bu kişiyle henüz konuşulmadı. Bir kanal seç ve ilk mesajı yaz.',
              )}
            </DialogDescription>
          </DialogHeader>

          {channels.isError ? (
            <Callout
              tone="danger"
              title={t('leadDetail.startConversation.channelsFailed', 'Kanallar yüklenemedi.')}
            />
          ) : !channels.isLoading && startable.length === 0 ? (
            <Callout
              tone="warning"
              title={t(
                'leadDetail.startConversation.noChannels',
                'Konuşma başlatılabilecek bağlı kanal yok — SMS veya e-posta bağla.',
              )}
            />
          ) : (
            <div className="space-y-4">
              <Field label={t('leadDetail.startConversation.channel', 'Kanal')} required>
                {({ id }) => (
                  <Select value={channelId} onValueChange={setChannelId}>
                    <SelectTrigger id={id}>
                      <SelectValue
                        placeholder={t('leadDetail.startConversation.pickChannel', 'Kanal seç')}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {startable.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name} ({c.type})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>

              {/* Not optional in practice, whatever the DTO says: the backend
                  refuses a start with neither text nor a WhatsApp template, and
                  this dialog does not do templates. */}
              <Field label={t('leadDetail.startConversation.message', 'İlk mesaj')} required>
                {({ id }) => (
                  <Textarea
                    id={id}
                    rows={3}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={t(
                      'leadDetail.startConversation.messagePlaceholder',
                      'Merhaba, …',
                    )}
                  />
                )}
              </Field>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setStartOpen(false)}>
              {t('common.cancel', 'İptal')}
            </Button>
            <Button
              type="button"
              onClick={() => start.mutate()}
              disabled={!channelId || !text.trim()}
              loading={start.isPending}
            >
              {t('leadDetail.startConversation.send', 'Gönder')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
