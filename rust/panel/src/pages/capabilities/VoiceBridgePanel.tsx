import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { Capability } from '@/api/types';
import { formatRelative } from '@/lib/format';

/** What a voice bridge reported of itself when it last registered (`connector_public.bridge`). */
export interface BridgeFacts {
  extension: string;
  codecs: string[];
  max_calls: number | null;
  stt: { engine: string; model: string } | null;
  tts: { engine: string; voice: string } | null;
  version: string;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The facts a `voice_bridge` capability carries, or `null` before its first registration. */
export function bridgeFactsOf(capability: Capability): BridgeFacts | null {
  const raw = (capability.connector_public as Record<string, unknown>).bridge;
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const engine = (value: unknown, second: 'model' | 'voice') => {
    if (!value || typeof value !== 'object') return null;
    const e = value as Record<string, unknown>;
    return { engine: text(e.engine), [second]: text(e[second]) };
  };
  return {
    extension: text(b.extension),
    codecs: Array.isArray(b.codecs) ? b.codecs.filter((c): c is string => typeof c === 'string') : [],
    max_calls: typeof b.max_calls === 'number' ? b.max_calls : null,
    stt: engine(b.stt, 'model') as BridgeFacts['stt'],
    tts: engine(b.tts, 'voice') as BridgeFacts['tts'],
    version: text(b.version),
  };
}

/**
 * The voice bridge on its capability card: its extension, its speech engines, its version and
 * line count as it last reported them, and how long ago that was. Only its own registration
 * verifies it; the setup is in `docs/operations/voice-bridge.md`.
 */
export function VoiceBridgePanel({ capability }: { capability: Capability }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const facts = bridgeFactsOf(capability);
  const rows: [string, string][] = facts
    ? [
        [t('capabilities.bridge.extension'), facts.extension],
        [t('capabilities.bridge.stt'), facts.stt ? `${facts.stt.engine} · ${facts.stt.model}` : ''],
        [t('capabilities.bridge.tts'), facts.tts ? `${facts.tts.engine} · ${facts.tts.voice}` : ''],
        [t('capabilities.bridge.version'), facts.version],
        [t('capabilities.bridge.lines'), facts.max_calls === null ? '' : String(facts.max_calls)],
        [t('capabilities.bridge.codecs'), facts.codecs.join(', ')],
        [t('capabilities.bridge.heartbeat'), formatRelative(capability.last_verified_at, i18n.language)],
      ]
    : [];
  return (
    <div role="group" aria-labelledby={`${id}-title`} className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <p id={`${id}-title`} className="text-caption text-muted-foreground">
        {t('capabilities.bridge.title')}
      </p>
      {facts ? (
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          {rows.map(([label, value]) => (
            <div key={label} className="flex flex-col gap-0.5">
              <dt className="text-caption text-muted-foreground">{label}</dt>
              <dd className="break-words text-foreground">{value || '—'}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-foreground">{t('capabilities.bridge.never')}</p>
      )}
      <p className="text-caption text-muted-foreground">
        {t('capabilities.bridge.hint')} <code className="font-mono text-micro">docs/operations/voice-bridge.md</code>
      </p>
    </div>
  );
}
