import { useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Send,
  PauseCircle,
  PlayCircle,
  CheckCircle,
  Sparkles,
  User,
  ChevronLeft,
  Users,
  Mic,
  FileText,
} from 'lucide-react';
import { Button, IconButton, Card, ScrollArea, Badge } from '@/components/ui';
import { smsSegments, NETGSM_HEADER_OVERHEAD_CHARS } from '@/lib/smsSegments';

interface MessageRow {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  authorType: 'CUSTOMER' | 'AI' | 'AGENT' | 'SYSTEM';
  body: string;
  status?: string;
  createdAt: string;
  /** NetGSM Phase 4 Task 6 — a voicemail lands as an inbound Message tagged
   *  `meta.raw.kind === 'VOICEMAIL'` (Message has no separate channel/type
   *  column of its own). `audioUrl` is NetGSM's own provider-tokenized link
   *  (an accepted fallback — see RecordingProxyController's docstring for the
   *  same precedent with call recordings — never our R2 bucket's public URL).
   *  NetGSM Phase 6 Task 2 — an inbound fax lands the same way, tagged
   *  `meta.raw.kind === 'FAX'`; `documentUrl` is NetGSM's own provider-
   *  tokenized link to the PDF (same precedent, never our R2 bucket's public
   *  URL — see NetgsmFaxPollService's docstring). */
  meta?: {
    raw?: {
      kind?: string;
      audioUrl?: string | null;
      durationSec?: number | null;
      documentUrl?: string | null;
    };
  } | null;
}

interface ThreadPaneProps {
  convo: {
    id: string;
    aiPaused: boolean;
    channelType?: string;
    status?: string;
  } | null | undefined;
  lead?: {
    id?: string;
    contactPerson?: string;
    businessName?: string;
  } | null;
  channel?: { type?: string } | null;
  messages: MessageRow[];
  draft: string;
  isSending: boolean;
  isTogglingAi: boolean;
  isClosing: boolean;
  onDraftChange: (v: string) => void;
  onSend: () => void;
  onToggleAi: () => void;
  onClose: () => void;
  onBack: () => void;
  onShowContext: () => void;
}

/**
 * Centre pane — the live conversation thread + composer.
 */
export function ThreadPane({
  convo,
  lead,
  channel,
  messages,
  draft,
  isSending,
  isTogglingAi,
  isClosing,
  onDraftChange,
  onSend,
  onToggleAi,
  onClose,
  onBack,
  onShowContext,
}: ThreadPaneProps) {
  const { t } = useTranslation('marketing');
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  if (!convo) {
    return (
      <Card className="flex-1 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">
          {t('inbox.selectPrompt', 'Select a conversation to view the thread.')}
        </p>
      </Card>
    );
  }

  const channelLabel = convo.channelType ?? channel?.type;

  return (
    <Card className="flex-1 flex flex-col overflow-hidden min-w-0">
      {/* Thread header */}
      <div className="px-3 py-2.5 border-b border-border flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {/* Mobile back button */}
          <IconButton
            variant="ghost"
            size="sm"
            aria-label={t('inbox.back', 'Back')}
            onClick={onBack}
            className="sm:hidden -ml-1 shrink-0"
          >
            <ChevronLeft className="w-5 h-5" />
          </IconButton>
          <div className="min-w-0">
            <span className="font-medium text-foreground text-sm truncate block">
              {lead?.contactPerson || lead?.businessName}
            </span>
            {channelLabel && (
              <Badge tone="neutral" size="sm" className="mt-0.5">
                {channelLabel}
              </Badge>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {/* Show lead context on mobile/tablet */}
          <IconButton
            variant="ghost"
            size="sm"
            aria-label={t('inbox.context', 'Lead')}
            onClick={onShowContext}
            className="lg:hidden"
          >
            <Users className="w-5 h-5" />
          </IconButton>

          {/* Toggle AI */}
          <IconButton
            variant="ghost"
            size="sm"
            aria-label={
              convo.aiPaused
                ? t('inbox.resumeAi', 'Resume AI')
                : t('inbox.pauseAi', 'Pause AI')
            }
            onClick={onToggleAi}
            disabled={isTogglingAi}
          >
            {convo.aiPaused ? (
              <PlayCircle className="w-5 h-5" />
            ) : (
              <PauseCircle className="w-5 h-5" />
            )}
          </IconButton>

          {/* Close conversation */}
          <IconButton
            variant="ghost"
            size="sm"
            aria-label={t('inbox.close', 'Close')}
            onClick={onClose}
            disabled={isClosing}
          >
            <CheckCircle className="w-5 h-5" />
          </IconButton>
        </div>
      </div>

      {/* Message thread */}
      <ScrollArea className="flex-1 p-4 bg-surface-muted/30">
        <div className="space-y-3">
          {messages.map((m) => {
            const isVoicemail = m.meta?.raw?.kind === 'VOICEMAIL';
            const isFax = m.meta?.raw?.kind === 'FAX';
            return (
              <div
                key={m.id}
                className={`flex ${m.direction === 'OUTBOUND' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[70%] rounded-2xl px-3 py-2 text-sm ${
                    m.direction === 'OUTBOUND'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-surface border border-border text-foreground'
                  }`}
                >
                  <div className="flex items-center gap-1 mb-0.5 opacity-70 text-[10px]">
                    {m.authorType === 'AI' && <Sparkles className="w-3 h-3" />}
                    {m.authorType === 'AGENT' && <User className="w-3 h-3" />}
                    <span>{m.authorType}</span>
                  </div>
                  {isVoicemail && (
                    <Badge tone="neutral" size="sm" className="mb-1 gap-1">
                      <Mic className="w-3 h-3" aria-hidden="true" />
                      {t('inbox.voicemail', 'Voicemail')}
                    </Badge>
                  )}
                  {isFax && (
                    <Badge tone="neutral" size="sm" className="mb-1 gap-1">
                      <FileText className="w-3 h-3" aria-hidden="true" />
                      {t('inbox.fax', 'Fax')}
                    </Badge>
                  )}
                  <div className="whitespace-pre-wrap break-words">{m.body}</div>
                  {isVoicemail && m.meta?.raw?.audioUrl && (
                    <audio
                      controls
                      preload="none"
                      src={m.meta.raw.audioUrl}
                      className="mt-1.5 h-8 max-w-full"
                    />
                  )}
                  {isFax && m.meta?.raw?.documentUrl && (
                    <a
                      href={m.meta.raw.documentUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1.5 inline-flex items-center gap-1 text-xs underline underline-offset-2"
                    >
                      <FileText className="w-3 h-3" aria-hidden="true" />
                      {t('inbox.faxOpenDocument', 'Open document')}
                    </a>
                  )}
                  {m.status === 'FAILED' && (
                    <div className="text-[10px] text-danger/80 mt-0.5">
                      {t('inbox.failed', 'failed')}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          <div ref={threadEndRef} />
        </div>
      </ScrollArea>

      {/* Reply composer */}
      <div className="p-3 border-t border-border shrink-0">
        <div className="flex gap-2">
          <input
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              // Mirror the Send button's disabled guard (incl. !isSending): without
              // it, pressing Enter again while a reply is still in flight fires a
              // second send of the (not-yet-cleared) draft — a duplicate message to
              // the live customer.
              if (e.key === 'Enter' && !e.shiftKey && draft.trim() && !isSending) {
                e.preventDefault();
                onSend();
              }
            }}
            placeholder={t(
              'inbox.replyPlaceholder',
              'Type a reply… (this pauses the AI)',
            )}
            className="flex-1 h-9 px-3 rounded-lg border border-border-strong bg-surface text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-primary transition-colors"
          />
          <Button
            size="md"
            onClick={onSend}
            disabled={!draft.trim() || isSending}
            loading={isSending}
            aria-label={t('inbox.send', 'Send')}
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>
        {channelLabel === 'SMS' && (
          <p className="text-[11px] text-muted-foreground mt-1 px-0.5">
            {(() => {
              const segments = smsSegments(draft, { reservedSuffixChars: NETGSM_HEADER_OVERHEAD_CHARS });
              return t('inbox.smsCounter', {
                defaultValue: '{{chars}} characters · {{segments}} segment{{plural}}',
                chars: draft.length,
                segments,
                plural: segments === 1 ? '' : 's',
              });
            })()}
          </p>
        )}
      </div>
    </Card>
  );
}
