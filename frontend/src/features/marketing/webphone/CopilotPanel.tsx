import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Mic, MicOff } from 'lucide-react';
import {
  getCopilotSuggestions,
  type CopilotSuggestResult,
} from '../api/voice-ai.service';
import { Button, Spinner, Textarea } from '../../../components/ui';

/**
 * CopilotPanel — a self-contained live-call assistant. While a call is active it
 * listens to the rep's microphone via the browser SpeechRecognition API,
 * accumulates the (interim + final) transcript, and ~4s after new speech settles
 * asks the backend for up to 3 lines the rep can read plus a one-line summary.
 *
 * Graceful degradation: when SpeechRecognition is unavailable (Firefox, Safari,
 * locked-down browsers) it falls back to a textarea + "Öneri al" button so the
 * rep can paste/type the transcript and still get suggestions.
 *
 * No webphone/SIP coupling — the host just renders it while `incall`.
 */

// ── Minimal Web Speech API typings (not in lib.dom for all TS targets). ───────
interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  0: SpeechRecognitionAlternativeLike;
  isFinal: boolean;
  length: number;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface CopilotPanelProps {
  /** Agent persona to ground the suggestions, if known. */
  agentProfileId?: string | null;
  /** BCP-47 recognition language; defaults to Turkish. */
  language?: string;
}

const DEBOUNCE_MS = 4000;

export default function CopilotPanel({
  agentProfileId = null,
  language = 'tr-TR',
}: CopilotPanelProps) {
  const { t } = useTranslation('marketing');
  const supported = useRef<boolean>(getSpeechRecognitionCtor() != null);

  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [manualTranscript, setManualTranscript] = useState('');
  const [result, setResult] = useState<CopilotSuggestResult | null>(null);
  const [loading, setLoading] = useState(false);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest transcript used by the debounced fetch (avoids stale closure).
  const transcriptRef = useRef('');

  const fetchSuggestions = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setLoading(true);
      try {
        const res = await getCopilotSuggestions({ agentProfileId, transcript: trimmed });
        setResult(res);
      } catch {
        // Inert backend (copilot off) or transient error — keep the panel quiet
        // rather than spamming toasts during a live call.
      } finally {
        setLoading(false);
      }
    },
    [agentProfileId],
  );

  // Schedule a debounced suggestion fetch whenever new speech settles.
  const scheduleFetch = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void fetchSuggestions(transcriptRef.current);
    }, DEBOUNCE_MS);
  }, [fetchSuggestions]);

  const startListening = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = language;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e: SpeechRecognitionEventLike) => {
      let finalChunk = '';
      let interimChunk = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const txt = r[0]?.transcript ?? '';
        if (r.isFinal) finalChunk += txt + ' ';
        else interimChunk += txt;
      }
      if (finalChunk) {
        transcriptRef.current = (transcriptRef.current + ' ' + finalChunk).trim();
      }
      setTranscript((transcriptRef.current + ' ' + interimChunk).trim());
      scheduleFetch();
    };
    rec.onerror = () => {
      /* swallow — onend will fire and we flip listening off */
    };
    rec.onend = () => {
      setListening(false);
    };
    recognitionRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  }, [language, scheduleFetch]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setListening(false);
  }, []);

  // Clean up on unmount (call ended → panel unmounts).
  useEffect(() => {
    return () => {
      recognitionRef.current?.abort?.();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const suggestions = result?.suggestions?.slice(0, 3) ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 text-caption font-medium text-foreground">
          <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
          {t('copilot.title', 'Canlı Asistan')}
        </span>
        {supported.current && (
          <Button
            variant={listening ? 'outline' : 'primary'}
            size="sm"
            onClick={listening ? stopListening : startListening}
          >
            {listening ? (
              <>
                <MicOff className="h-4 w-4" aria-hidden="true" />
                {t('copilot.stop', 'Durdur')}
              </>
            ) : (
              <>
                <Mic className="h-4 w-4" aria-hidden="true" />
                {t('copilot.listen', 'Dinle')}
              </>
            )}
          </Button>
        )}
      </div>

      {/* Fallback input when SpeechRecognition is unavailable. */}
      {!supported.current && (
        <div className="space-y-2">
          <Textarea
            value={manualTranscript}
            onChange={(e) => setManualTranscript(e.target.value)}
            placeholder={t('copilot.pastePlaceholder', 'Görüşme metnini buraya yapıştırın…')}
            rows={3}
          />
          <Button
            variant="primary"
            size="sm"
            loading={loading}
            onClick={() => void fetchSuggestions(manualTranscript)}
          >
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            {t('copilot.getSuggestions', 'Öneri al')}
          </Button>
        </div>
      )}

      {/* Live transcript preview (kept short). */}
      {supported.current && transcript && (
        <p className="line-clamp-2 text-micro text-muted-foreground">{transcript}</p>
      )}

      {loading && (
        <div className="inline-flex items-center gap-2 text-caption text-muted-foreground">
          <Spinner className="h-4 w-4" /> {t('copilot.thinking', 'Düşünüyor…')}
        </div>
      )}

      {/* Summary */}
      {result?.summary && (
        <p className="text-caption text-muted-foreground">
          <span className="font-medium text-foreground">{t('copilot.summary', 'Özet')}: </span>
          {result.summary}
        </p>
      )}

      {/* Suggestion chips the rep can read aloud. */}
      {suggestions.length > 0 && (
        <ul className="space-y-1.5">
          {suggestions.map((s, i) => (
            <li
              key={i}
              className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-caption text-foreground"
            >
              {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
