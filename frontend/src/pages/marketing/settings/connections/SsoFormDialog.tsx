import { useEffect } from 'react';
import { useForm, Controller, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  Button,
  Field,
  Input,
  Textarea,
  Switch,
} from '@/components/ui';
import type { SsoConnection } from './types';

// Dialog-local schema: the structured fields mirror the backend DTO; the
// `allowedDomainsText` textarea is free-form (split + lowercased before submit).
const httpsIssuer = z
  .string()
  .trim()
  .min(1, 'required')
  .max(500)
  .refine((v) => /^https:\/\//i.test(v), { message: 'httpsRequired' })
  .refine((v) => {
    try {
      new URL(v);
      return true;
    } catch {
      return false;
    }
  }, { message: 'invalidUrl' });

function buildFormSchema(isEdit: boolean) {
  return z.object({
    issuer: httpsIssuer,
    clientId: z.string().trim().min(1, 'required').max(255),
    clientSecret: isEdit
      ? z.string().trim().max(1000).optional()
      : z.string().trim().min(1, 'required').max(1000),
    enabled: z.boolean().optional(),
    allowedDomainsText: z.string().max(4000).optional(),
  });
}

/** What the page hands to the backend (allowedDomains split from the textarea). */
export interface SsoSubmitPayload {
  issuer: string;
  clientId: string;
  /** Omitted on edit when left blank so the stored secret is preserved. */
  clientSecret?: string;
  enabled: boolean;
  allowedDomains: string[];
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass a connection to edit, or null to create. */
  connection?: SsoConnection | null;
  onSubmit: (payload: SsoSubmitPayload) => void;
  isPending: boolean;
}

interface FormShape {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  enabled?: boolean;
  /** One domain per line in the textarea; split before submit. */
  allowedDomainsText?: string;
}

const EMPTY: FormShape = {
  issuer: '',
  clientId: '',
  clientSecret: '',
  enabled: false,
  allowedDomainsText: '',
};

function splitDomains(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

export function SsoFormDialog({ open, onOpenChange, connection, onSubmit, isPending }: Props) {
  const { t } = useTranslation('marketing');
  const isEdit = !!connection;

  const form = useForm<FormShape>({
    resolver: zodResolver(buildFormSchema(isEdit)),
    mode: 'onBlur',
    defaultValues: EMPTY,
  });

  useEffect(() => {
    if (!open) return;
    if (connection) {
      form.reset({
        issuer: connection.issuer,
        clientId: connection.clientId,
        clientSecret: '',
        enabled: connection.enabled,
        allowedDomainsText: (connection.allowedDomains ?? []).join('\n'),
      });
    } else {
      form.reset(EMPTY);
    }
  }, [connection, open, form]);

  const fieldErr = (msg?: string) =>
    msg ? t([`connections.sso.validation.${msg}`, `validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const handleSubmit: SubmitHandler<FormShape> = (values) => {
    onSubmit({
      issuer: values.issuer.trim(),
      clientId: values.clientId.trim(),
      ...(values.clientSecret && values.clientSecret.trim()
        ? { clientSecret: values.clientSecret.trim() }
        : {}),
      enabled: !!values.enabled,
      allowedDomains: splitDomains(values.allowedDomainsText ?? ''),
    });
  };

  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t('connections.sso.editTitle', { defaultValue: 'Edit SSO connection' })
              : t('connections.sso.createTitle', { defaultValue: 'New SSO connection' })}
          </DialogTitle>
          <DialogDescription>
            {t('connections.sso.dialogDesc', {
              defaultValue:
                'Connect an OpenID Connect identity provider so your team can sign in with SSO.',
            })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <Field
            label={t('connections.sso.issuer', { defaultValue: 'Issuer URL' })}
            error={fieldErr(errors.issuer?.message)}
            hint={t('connections.sso.issuerHint', {
              defaultValue: 'The provider’s HTTPS issuer, e.g. https://login.example.com',
            })}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="https://login.example.com"
                {...form.register('issuer')}
              />
            )}
          </Field>

          <Field
            label={t('connections.sso.clientId', { defaultValue: 'Client ID' })}
            error={fieldErr(errors.clientId?.message)}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                autoComplete="off"
                {...form.register('clientId')}
              />
            )}
          </Field>

          <Field
            label={t('connections.sso.clientSecret', { defaultValue: 'Client secret' })}
            error={fieldErr(errors.clientSecret?.message)}
            hint={
              isEdit
                ? t('connections.sso.secretEditHint', {
                    defaultValue: 'Leave blank to keep the stored secret. It is never displayed.',
                  })
                : t('connections.sso.secretHint', {
                    defaultValue: 'Sealed at rest and never displayed again after saving.',
                  })
            }
            required={!isEdit}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="password"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                autoComplete="new-password"
                placeholder={isEdit ? '••••••••' : ''}
                {...form.register('clientSecret')}
              />
            )}
          </Field>

          <Field
            label={t('connections.sso.allowedDomains', { defaultValue: 'Allowed email domains' })}
            hint={t('connections.sso.allowedDomainsHint', {
              defaultValue:
                'Optional. One domain per line. When set, only these domains may sign in via SSO.',
            })}
          >
            {({ id, describedBy }) => (
              <Textarea
                id={id}
                aria-describedby={describedBy}
                rows={3}
                placeholder={'example.com\nacme.io'}
                {...form.register('allowedDomainsText')}
              />
            )}
          </Field>

          <Controller
            control={form.control}
            name="enabled"
            render={({ field: f }) => (
              <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {t('connections.sso.enabled', { defaultValue: 'Enabled' })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('connections.sso.enabledHint', {
                      defaultValue: 'When on, the workspace SSO sign-in flow is live.',
                    })}
                  </p>
                </div>
                <Switch checked={!!f.value} onCheckedChange={f.onChange} />
              </div>
            )}
          />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" loading={isPending}>
              {isEdit
                ? t('common.save', { defaultValue: 'Save' })
                : t('connections.sso.createTitle', { defaultValue: 'New SSO connection' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
