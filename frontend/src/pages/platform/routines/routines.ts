import { z } from 'zod';
import type { BadgeProps } from '@/components/ui/Badge';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RoutineConfig {
  key: string;
  enabled: boolean;
  cron: string | null;
  onEvent: boolean;
  triggerUrl: string | null;
  hasToken: boolean;
  eventCooldownSec: number;
  lastTriggeredAt: string | null;
  lastTriggerStatus: string | null;
  lastTriggerError: string | null;
}

export interface UpdateRoutineBody {
  enabled?: boolean;
  cron?: string | null;
  onEvent?: boolean;
  triggerUrl?: string | null;
  triggerToken?: string;
  eventCooldownSec?: number;
}

export interface TriggerResult {
  ok: boolean;
  skipped?: string;
  error?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

export const ROUTINE_LABELS: Record<string, string> = {
  'review-draft': 'Review draft',
  'content-pack': 'Content pack',
  'insight-digest': 'Insight digest',
  'lead-scoring': 'Lead scoring',
};

/** Only these routines have meaningful event triggers. */
export const EVENT_DRIVEN_KEYS = new Set(['review-draft', 'lead-scoring']);

export const STATUS_TONE: Record<string, NonNullable<BadgeProps['tone']>> = {
  ok: 'success',
  error: 'danger',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

export function routineLabel(key: string): string {
  return ROUTINE_LABELS[key] ?? key;
}

export function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function extractMessage(e: unknown): string {
  const err = e as { response?: { data?: { message?: string } } };
  return err?.response?.data?.message ?? 'An error occurred';
}

// ─── Form schema (RHF + Zod) ────────────────────────────────────────────────

export const routineFormSchema = z.object({
  enabled: z.boolean(),
  onEvent: z.boolean(),
  cron: z.string(),
  triggerUrl: z.string(),
  triggerToken: z.string(),
  eventCooldownSec: z.coerce
    .number({ invalid_type_error: 'Must be a number' })
    .int('Must be a whole number')
    .min(0, 'Must be 0 or more'),
});

export type RoutineFormValues = z.infer<typeof routineFormSchema>;

/** Build the PATCH body from validated form values, matching the original payload shape. */
export function toUpdateBody(values: RoutineFormValues): UpdateRoutineBody {
  const body: UpdateRoutineBody = {
    enabled: values.enabled,
    onEvent: values.onEvent,
    cron: values.cron.trim() || null,
    triggerUrl: values.triggerUrl.trim() || null,
    eventCooldownSec: Number(values.eventCooldownSec) || 300,
  };
  if (values.triggerToken.trim()) {
    body.triggerToken = values.triggerToken.trim();
  }
  return body;
}
