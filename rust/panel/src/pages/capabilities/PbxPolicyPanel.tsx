import { useId } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { setPbxPolicy } from '@/api/connectors';
import type { Capability, PbxCallMode, PbxPolicyInput } from '@/api/types';
import { Label, RadioGroup, RadioGroupItem, Switch, toast } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { invalidateCapabilities } from './queries';

/** The call policy a `netgsm_pbx` capability carries, read as its adapter reads it. */
export function pbxPolicyOf(capability: Capability): { call_mode: PbxCallMode; recording_allowed: boolean } {
  const pub = capability.connector_public as Record<string, unknown>;
  return {
    call_mode: pub.call_mode === 'linkup' ? 'linkup' : 'originate',
    recording_allowed: pub.recording_allowed === true,
  };
}

/**
 * The NetGSM PBX's call policy on its capability card: whether calls are recorded at the PBX (the
 * owner turns it on only with the KVKK recording announcement in place) and how a click-to-call is
 * placed. Each change is saved at once (`PUT /api/connectors/{id}/pbx-policy`).
 */
export function PbxPolicyPanel({ capability }: { capability: Capability }) {
  const { t } = useTranslation();
  const id = useId();
  const queryClient = useQueryClient();
  const policy = pbxPolicyOf(capability);
  const save = useMutation({
    mutationFn: (input: PbxPolicyInput) => setPbxPolicy(capability.id, input),
    onSuccess: async () => {
      toast.success(t('capabilities.pbx.saved'));
      await invalidateCapabilities(queryClient);
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });
  return (
    <div role="group" aria-labelledby={`${id}-title`} className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <p id={`${id}-title`} className="text-caption text-muted-foreground">
        {t('capabilities.pbx.title')}
      </p>
      <div className="flex items-start gap-3">
        <Switch
          id={`${id}-record`}
          checked={policy.recording_allowed}
          disabled={save.isPending}
          aria-describedby={`${id}-record-hint`}
          onCheckedChange={(on) => save.mutate({ recording_allowed: on })}
        />
        <div className="flex flex-col gap-0.5">
          <Label htmlFor={`${id}-record`} className="font-normal">
            {t('capabilities.pbx.recording')}
          </Label>
          <p id={`${id}-record-hint`} className="text-caption text-muted-foreground">
            {t('capabilities.pbx.recordingHint')}
          </p>
        </div>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm">{t('capabilities.pbx.mode')}</legend>
        <RadioGroup
          value={policy.call_mode}
          disabled={save.isPending}
          onValueChange={(mode) => save.mutate({ call_mode: mode as PbxCallMode })}
          className="flex flex-col gap-2"
        >
          {(['originate', 'linkup'] as const).map((mode) => (
            <div key={mode} className="flex items-start gap-2">
              <RadioGroupItem value={mode} id={`${id}-${mode}`} aria-describedby={`${id}-${mode}-hint`} />
              <div className="flex flex-col gap-0.5">
                <Label htmlFor={`${id}-${mode}`} className="font-normal">
                  {t(`capabilities.pbx.modes.${mode}`)}
                </Label>
                <p id={`${id}-${mode}-hint`} className="text-caption text-muted-foreground">
                  {t(`capabilities.pbx.modeHints.${mode}`)}
                </p>
              </div>
            </div>
          ))}
        </RadioGroup>
      </fieldset>
    </div>
  );
}
