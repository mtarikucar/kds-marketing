import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Phone, Sparkles, User, ChevronLeft, UserCheck } from 'lucide-react';
import marketingApi from '../../features/marketing/api/marketingApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';
import { ScrollArea } from '@/components/ui/ScrollArea';

// ── Types ─────────────────────────────────────────────────────────────────────

interface VoiceCall {
  id: string;
  fromNumber: string;
  toNumber: string;
  status: string;
  turns: number;
  createdAt: string;
  // NetGSM Phase 5 Task 6 — set when the caller matched a lead (canonical
  // phone match) and the IVR personalized the greeting/handoff for them.
  leadId?: string | null;
}
interface Turn {
  role: string;
  text: string;
  createdAt: string;
}

// ── Badge helper ──────────────────────────────────────────────────────────────

function callStatusTone(status: string) {
  if (status === 'COMPLETED') return 'success' as const;
  if (status === 'IN_PROGRESS') return 'info' as const;
  return 'neutral' as const;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function VoicePage() {
  const { t } = useTranslation('marketing');
  const [selected, setSelected] = useState<string | null>(null);

  // ── Queries ──────────────────────────────────────────────────────────────────

  const { data: calls } = useQuery<VoiceCall[]>({
    queryKey: ['marketing', 'voice', 'calls'],
    queryFn: () => marketingApi.get('/voice/calls').then((r) => r.data),
    refetchInterval: 20_000,
  });

  const { data: transcript } = useQuery<Turn[]>({
    queryKey: ['marketing', 'voice', 'transcript', selected],
    queryFn: () => marketingApi.get(`/voice/calls/${selected}/transcript`).then((r) => r.data),
    enabled: !!selected,
  });

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('voice.title', 'Voice AI')}
        description={t(
          'voice.subtitle',
          'AI answers your phone (Twilio), grounded on an agent + your knowledge base. Configure the number under Channels (type VOICE).',
        )}
      />

      <div className="flex gap-4 h-[calc(100vh-12rem)]">
        {/* Call list panel */}
        <Card
          className={`${selected ? 'hidden sm:flex' : 'flex'} flex-col w-full sm:w-80 sm:shrink-0 overflow-hidden`}
        >
          <ScrollArea className="flex-1">
            {(calls ?? []).length === 0 ? (
              <div className="p-6">
                <EmptyState
                  icon={<Phone className="h-8 w-8" />}
                  title={t('voice.empty', 'No AI calls yet')}
                />
              </div>
            ) : (
              <div className="divide-y divide-border">
                {(calls ?? []).map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setSelected(c.id)}
                    className={`w-full text-left p-3 transition-colors hover:bg-surface-muted ${
                      selected === c.id ? 'bg-primary/5' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-sm font-medium text-foreground truncate">
                        <Phone className="h-4 w-4 text-primary shrink-0" />
                        {c.fromNumber || t('voice.unknown', 'Unknown')}
                      </span>
                      <Badge tone={callStatusTone(c.status)} size="sm">
                        {c.status}
                      </Badge>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>
                        {c.turns} {t('voice.turns', 'turns')} · {new Date(c.createdAt).toLocaleString()}
                      </span>
                      {c.leadId && (
                        <Link
                          to={`/leads/${c.leadId}`}
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 text-primary hover:underline shrink-0"
                        >
                          <UserCheck className="h-3 w-3" />
                          {t('voice.leadMatched', 'Lead')}
                        </Link>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </ScrollArea>
        </Card>

        {/* Transcript panel */}
        <Card
          className={`${selected ? 'flex' : 'hidden sm:flex'} flex-col flex-1 overflow-hidden`}
        >
          <ScrollArea className="flex-1 p-4">
            {!selected ? (
              <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                {t('voice.selectPrompt', 'Select a call to see the transcript.')}
              </div>
            ) : (
              <div className="space-y-3">
                {/* Mobile back button */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="sm:hidden mb-2"
                  onClick={() => setSelected(null)}
                >
                  <ChevronLeft className="h-4 w-4" />
                  {t('voice.back', 'Calls')}
                </Button>

                {(transcript ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t('voice.noTranscript', 'No transcript for this call.')}
                  </p>
                ) : (
                  (transcript ?? []).map((tt, i) => (
                    <div
                      key={i}
                      className={`flex ${
                        tt.role === 'AI'
                          ? 'justify-start'
                          : tt.role === 'CUSTOMER'
                          ? 'justify-end'
                          : 'justify-center'
                      }`}
                    >
                      <div
                        className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm ${
                          tt.role === 'AI'
                            ? 'bg-surface-muted text-foreground'
                            : tt.role === 'CUSTOMER'
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-warning-subtle text-warning text-xs'
                        }`}
                      >
                        <div className="mb-0.5 flex items-center gap-1 text-[10px] opacity-70">
                          {tt.role === 'AI' ? (
                            <Sparkles className="h-3 w-3" />
                          ) : tt.role === 'CUSTOMER' ? (
                            <User className="h-3 w-3" />
                          ) : null}
                          {tt.role}
                        </div>
                        {tt.text}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </ScrollArea>
        </Card>
      </div>
    </div>
  );
}
