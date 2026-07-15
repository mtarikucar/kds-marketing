import { useTranslation } from 'react-i18next';
import { ArrowUp, ArrowDown, Trash2, X } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { IconButton } from '@/components/ui/IconButton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/Select';
import { stepMeta, type AnyStep } from './workflowGraph';
import { smsSegments, NETGSM_HEADER_OVERHEAD_CHARS } from '@/lib/smsSegments';
import { BranchConditionBuilder } from './stepEditors/BranchConditionBuilder';
import { UpdateLeadEditor } from './stepEditors/UpdateLeadEditor';
import { AiClassifyEditor } from './stepEditors/AiClassifyEditor';
import { WebhookEditor } from './stepEditors/WebhookEditor';
import { AdvancedJsonField } from './stepEditors/AdvancedJsonField';

export interface StepPropertyPanelProps {
  index: number | null;
  step: AnyStep | null;
  count: number;
  onPatch: (patch: Record<string, unknown>) => void;
  onReplace: (step: AnyStep) => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
  onClose?: () => void;
}

/** The right-hand panel of the builder: a full visual editor for the selected
 *  step. Common steps use inline fields; branch/update_lead/ai_classify/webhook
 *  use dedicated visual editors; every step also exposes a collapsed
 *  Advanced-JSON escape hatch. */
export function StepPropertyPanel({
  index, step, count, onPatch, onReplace, onDelete, onMove, onClose,
}: StepPropertyPanelProps) {
  const { t } = useTranslation('marketing');

  if (index == null || !step) {
    return (
      <p className="text-caption text-muted-foreground">
        {t('automations.canvasHint', 'Click a step to edit it, or use the palette to add one.')}
      </p>
    );
  }

  const meta = stepMeta(step.type);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold">{index + 1}. {meta.label}</span>
        {onClose && (
          <IconButton variant="ghost" size="sm" aria-label={t('common.close', 'Close')} onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        )}
      </div>

      {/* Key by index for the SAME reason as AdvancedJsonField below: StepFields
          holds local-state editors (e.g. WebhookEditor's `draft`) that would
          otherwise show/overwrite the previous step's value when switching to
          another step of the same type. */}
      <StepFields key={index} step={step} onPatch={onPatch} count={count} />

      {/* Key by index so switching steps REMOUNTS the JSON editor: its `draft`
          is local state seeded once, so without this it would keep showing (and,
          if edited, write back) the PREVIOUS step's JSON onto the new step. */}
      <AdvancedJsonField key={index} step={step} onReplace={onReplace} />

      <div className="flex items-center gap-1 pt-2 border-t border-border">
        <IconButton variant="ghost" size="sm" aria-label={t('automations.moveUp', 'Move up')} disabled={index === 0} onClick={() => onMove(-1)}>
          <ArrowUp className="h-4 w-4" />
        </IconButton>
        <IconButton variant="ghost" size="sm" aria-label={t('automations.moveDown', 'Move down')} disabled={index === count - 1} onClick={() => onMove(1)}>
          <ArrowDown className="h-4 w-4" />
        </IconButton>
        <div className="flex-1" />
        <IconButton variant="ghost" size="sm" aria-label={t('automations.deleteStep', 'Delete step')} className="text-danger hover:bg-danger-subtle" onClick={onDelete}>
          <Trash2 className="h-4 w-4" />
        </IconButton>
      </div>
    </div>
  );
}

function StepFields({ step, onPatch, count }: { step: AnyStep; onPatch: (p: Record<string, unknown>) => void; count: number }) {
  const { t } = useTranslation('marketing');

  switch (step.type) {
    case 'branch':
      return <BranchConditionBuilder step={step} onPatch={onPatch} count={count} />;
    case 'update_lead':
      return <UpdateLeadEditor step={step} onPatch={onPatch} />;
    case 'ai_classify':
      return <AiClassifyEditor step={step} onPatch={onPatch} count={count} />;
    case 'http_webhook_out':
      return <WebhookEditor step={step} onPatch={onPatch} />;
    default:
      break;
  }

  return (
    <div className="space-y-3">
      {step.type === 'send_email' && (
        <Labeled label={t('automations.subject', 'Subject')}>
          <Input aria-label={t('automations.subject', 'Subject')} value={step.subject ?? ''} onChange={(e) => onPatch({ subject: e.target.value })} />
        </Labeled>
      )}
      {(step.type === 'send_email' || step.type === 'send_sms' || step.type === 'send_whatsapp' || step.type === 'send_webchat') && (
        <Labeled label={t('automations.body', 'Message')}>
          <Textarea className="min-h-24" value={step.body ?? ''} onChange={(e) => onPatch({ body: e.target.value })} />
          {step.type === 'send_sms' && (
            <p className="text-[11px] text-muted-foreground mt-1">
              {(() => {
                const body = step.body ?? '';
                const segments = smsSegments(body, { reservedSuffixChars: NETGSM_HEADER_OVERHEAD_CHARS });
                return t('automations.smsCounter', {
                  defaultValue: '{{chars}} characters · {{segments}} segment{{plural}}',
                  chars: body.length,
                  segments,
                  plural: segments === 1 ? '' : 's',
                });
              })()}
            </p>
          )}
        </Labeled>
      )}
      {step.type === 'ai_generate' && (
        <Labeled label={t('automations.prompt', 'Prompt')}>
          <Textarea className="min-h-24" value={step.prompt ?? ''} onChange={(e) => onPatch({ prompt: e.target.value })} />
        </Labeled>
      )}
      {step.type === 'wait' && (
        <>
          <Labeled label={t('automations.waitMode', 'Mode')}>
            <Select
              value={step.mode ?? 'duration'}
              onValueChange={(v) => onPatch(v === 'duration' ? { mode: v, seconds: step.seconds ?? 86400 } : { mode: v })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="duration">{t('automations.duration', 'For a duration')}</SelectItem>
                <SelectItem value="until_reply">{t('automations.untilReply', 'Until reply')}</SelectItem>
              </SelectContent>
            </Select>
          </Labeled>
          {step.mode !== 'until_reply' && (
            <Labeled label={t('automations.waitSeconds', 'Seconds (60–2592000)')}>
              <Input
                type="number"
                value={step.seconds ?? 86400}
                onChange={(e) => onPatch({ seconds: clampInt(e.target.value, 60, 2_592_000) })}
              />
            </Labeled>
          )}
        </>
      )}
      {step.type === 'create_task' && (
        <Labeled label={t('automations.taskTitle', 'Task title')}>
          <Input value={step.title ?? ''} onChange={(e) => onPatch({ title: e.target.value })} />
        </Labeled>
      )}
      {step.type === 'notify_user' && (
        <Labeled label={t('automations.message', 'Message')}>
          <Textarea className="min-h-20" value={step.message ?? ''} onChange={(e) => onPatch({ message: e.target.value })} />
        </Labeled>
      )}
      {(step.type === 'add_tag' || step.type === 'remove_tag') && (
        <Labeled label={t('automations.tag', 'Tag')}>
          <Input value={step.tag ?? ''} onChange={(e) => onPatch({ tag: e.target.value })} />
        </Labeled>
      )}
      {step.type === 'assign_lead' && (
        <Labeled label={t('automations.strategy', 'Strategy')}>
          <Select value={step.strategy ?? 'auto'} onValueChange={(v) => onPatch({ strategy: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">auto</SelectItem>
              <SelectItem value="user">user</SelectItem>
            </SelectContent>
          </Select>
        </Labeled>
      )}
      {(step.type === 'stop_workflow' || step.type === 'send_review_request') && (
        <p className="text-[11px] text-muted-foreground bg-surface-muted rounded p-2">
          {t('automations.noConfig', 'This step has no settings.')}
        </p>
      )}
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-caption text-muted-foreground mb-1">{label}</div>
      {children}
    </div>
  );
}

function clampInt(v: string, min: number, max: number): number {
  const n = Math.round(Number(v) || 0);
  return Math.min(max, Math.max(min, n));
}
