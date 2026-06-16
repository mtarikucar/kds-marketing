import { useState } from 'react';
import { useForm, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  ShieldCheck,
  ShieldAlert,
  Smartphone,
  KeyRound,
  Copy,
  Check,
} from 'lucide-react';
import { z } from 'zod';
import marketingApi from '@/features/marketing/api/marketingApi';
import {
  PageHeader,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Button,
  Badge,
  Field,
  Input,
  Skeleton,
  Callout,
  Separator,
} from '@/components/ui';

// ── Types (mirror two-factor.service responses) ─────────────────────────────

interface TwoFactorStatus {
  enabled: boolean;
}
interface EnrollResponse {
  secret: string;
  otpauthUri: string;
}
interface EnableResponse {
  enabled: boolean;
  backupCodes: string[];
}

const codeSchema = z.object({
  code: z
    .string()
    .trim()
    .min(6, 'codeRequired')
    .max(20, 'codeTooLong'),
});
type CodeValues = z.infer<typeof codeSchema>;

function apiError(e: unknown, fallback: string): string {
  const msg = (e as { response?: { data?: { message?: string | string[] } } })?.response?.data
    ?.message;
  if (Array.isArray(msg)) return msg[0];
  return msg ?? fallback;
}

// ── Copyable code row ───────────────────────────────────────────────────────

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — no-op
    }
  };
  return (
    <Button type="button" size="sm" variant="outline" onClick={copy} aria-label={label}>
      {copied ? (
        <Check className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Copy className="h-4 w-4" aria-hidden="true" />
      )}
    </Button>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function TwoFactorPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();

  // Local enrollment state — the secret/uri are only known transiently after enroll.
  const [enrollment, setEnrollment] = useState<EnrollResponse | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [disarmOpen, setDisarmOpen] = useState(false);

  const { data: status, isLoading } = useQuery<TwoFactorStatus>({
    queryKey: ['marketing', '2fa', 'status'],
    queryFn: () => marketingApi.get('/auth/2fa/status').then((r) => r.data),
  });

  const enrolled = status?.enabled ?? false;

  const enableForm = useForm<CodeValues>({
    resolver: zodResolver(codeSchema),
    mode: 'onBlur',
    defaultValues: { code: '' },
  });

  const disableForm = useForm<CodeValues>({
    resolver: zodResolver(codeSchema),
    mode: 'onBlur',
    defaultValues: { code: '' },
  });

  const enrollMutation = useMutation({
    mutationFn: () => marketingApi.post('/auth/2fa/enroll').then((r) => r.data as EnrollResponse),
    onSuccess: (data) => {
      setEnrollment(data);
      setBackupCodes(null);
      enableForm.reset({ code: '' });
    },
    onError: (e) =>
      toast.error(apiError(e, t('twofa.enrollError', { defaultValue: 'Failed to start enrollment' }))),
  });

  const enableMutation = useMutation({
    mutationFn: (code: string) =>
      marketingApi.post('/auth/2fa/enable', { code }).then((r) => r.data as EnableResponse),
    onSuccess: (data) => {
      setBackupCodes(data.backupCodes);
      setEnrollment(null);
      enableForm.reset({ code: '' });
      queryClient.invalidateQueries({ queryKey: ['marketing', '2fa', 'status'] });
      toast.success(t('twofa.enabled', { defaultValue: 'Two-factor authentication enabled' }));
    },
    onError: (e) =>
      toast.error(apiError(e, t('twofa.enableError', { defaultValue: 'Invalid verification code' }))),
  });

  const disableMutation = useMutation({
    mutationFn: (code: string) =>
      marketingApi.post('/auth/2fa/disable', { code }).then((r) => r.data),
    onSuccess: () => {
      setDisarmOpen(false);
      setBackupCodes(null);
      setEnrollment(null);
      disableForm.reset({ code: '' });
      queryClient.invalidateQueries({ queryKey: ['marketing', '2fa', 'status'] });
      toast.success(t('twofa.disabled', { defaultValue: 'Two-factor authentication disabled' }));
    },
    onError: (e) =>
      toast.error(apiError(e, t('twofa.disableError', { defaultValue: 'Invalid verification code' }))),
  });

  const codeErr = (msg?: string) =>
    msg ? t(`twofa.validation.${msg}`, { defaultValue: t('twofa.codeRequired', { defaultValue: 'Enter the 6-digit code from your app' }) }) : undefined;

  const onEnable: SubmitHandler<CodeValues> = (v) => enableMutation.mutate(v.code);
  const onDisable: SubmitHandler<CodeValues> = (v) => disableMutation.mutate(v.code);

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('twofa.title', { defaultValue: 'Two-factor authentication' })}
        description={t('twofa.subtitle', {
          defaultValue: 'Add a second step to your sign-in with an authenticator app.',
        })}
        actions={
          isLoading ? (
            <Skeleton className="h-6 w-24" />
          ) : enrolled ? (
            <Badge tone="success">
              <ShieldCheck className="me-1 h-3.5 w-3.5" aria-hidden="true" />
              {t('twofa.statusOn', { defaultValue: 'Enabled' })}
            </Badge>
          ) : (
            <Badge tone="neutral">
              <ShieldAlert className="me-1 h-3.5 w-3.5" aria-hidden="true" />
              {t('twofa.statusOff', { defaultValue: 'Not enabled' })}
            </Badge>
          )
        }
      />

      {/* Backup codes — shown once, after enabling */}
      {backupCodes && (
        <Card>
          <CardHeader>
            <CardTitle>{t('twofa.backupTitle', { defaultValue: 'Save your backup codes' })}</CardTitle>
            <CardDescription>
              {t('twofa.backupDesc', {
                defaultValue:
                  'Each code can be used once if you lose access to your authenticator. They will not be shown again.',
              })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Callout tone="warning" className="mb-4">
              {t('twofa.backupWarn', {
                defaultValue: 'Store these somewhere safe now — this is the only time you will see them.',
              })}
            </Callout>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="backup-codes">
              {backupCodes.map((bc) => (
                <code
                  key={bc}
                  className="rounded-md border border-border bg-surface-muted px-3 py-2 text-center font-mono text-sm text-foreground"
                >
                  {bc}
                </code>
              ))}
            </div>
          </CardContent>
          <CardFooter className="justify-end gap-2">
            <CopyButton
              value={backupCodes.join('\n')}
              label={t('twofa.copyBackup', { defaultValue: 'Copy backup codes' })}
            />
            <Button variant="outline" onClick={() => setBackupCodes(null)}>
              {t('twofa.backupDone', { defaultValue: "I've saved them" })}
            </Button>
          </CardFooter>
        </Card>
      )}

      {/* Disabled → enrollment flow */}
      {!enrolled && (
        <Card>
          <CardHeader>
            <CardTitle>{t('twofa.setupTitle', { defaultValue: 'Set up authenticator app' })}</CardTitle>
            <CardDescription>
              {t('twofa.setupDesc', {
                defaultValue:
                  'Scan the QR code (or enter the secret) in an app like Google Authenticator or 1Password, then verify a code to finish.',
              })}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {!enrollment ? (
              <div className="flex flex-col items-start gap-3">
                <p className="text-sm text-muted-foreground">
                  {t('twofa.enrollPrompt', {
                    defaultValue: 'Start enrollment to generate your secret and QR code.',
                  })}
                </p>
                <Button
                  onClick={() => enrollMutation.mutate()}
                  loading={enrollMutation.isPending}
                >
                  <Smartphone className="h-4 w-4" aria-hidden="true" />
                  {t('twofa.startEnroll', { defaultValue: 'Begin setup' })}
                </Button>
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                  {/* QR code via public chart endpoint of the otpauth URI */}
                  <div className="shrink-0 rounded-lg border border-border bg-white p-3">
                    <img
                      src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(
                        enrollment.otpauthUri,
                      )}`}
                      alt={t('twofa.qrAlt', { defaultValue: 'Two-factor QR code' })}
                      width={180}
                      height={180}
                    />
                  </div>
                  <div className="min-w-0 flex-1 space-y-2">
                    <p className="text-sm font-medium text-foreground">
                      {t('twofa.secretLabel', { defaultValue: 'Or enter this secret manually' })}
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-surface-muted px-3 py-2 font-mono text-sm text-foreground">
                        {enrollment.secret}
                      </code>
                      <CopyButton
                        value={enrollment.secret}
                        label={t('twofa.copySecret', { defaultValue: 'Copy secret' })}
                      />
                    </div>
                    <p className="text-caption text-muted-foreground">
                      {t('twofa.secretHint', {
                        defaultValue: 'Keep this private — anyone with it can generate your codes.',
                      })}
                    </p>
                  </div>
                </div>

                <Separator />

                <form onSubmit={enableForm.handleSubmit(onEnable)} className="space-y-4">
                  <Field
                    label={t('twofa.codeLabel', { defaultValue: 'Verification code' })}
                    error={codeErr(enableForm.formState.errors.code?.message)}
                    hint={t('twofa.codeHint', { defaultValue: 'The 6-digit code currently shown in your app.' })}
                    required
                  >
                    {({ id, describedBy, invalid }) => (
                      <Input
                        id={id}
                        aria-describedby={describedBy}
                        aria-invalid={invalid}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        placeholder="123456"
                        className="max-w-[12rem]"
                        {...enableForm.register('code')}
                      />
                    )}
                  </Field>
                  <Button type="submit" loading={enableMutation.isPending}>
                    <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                    {t('twofa.verifyEnable', { defaultValue: 'Verify & enable' })}
                  </Button>
                </form>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Enabled → disable flow */}
      {enrolled && (
        <Card>
          <CardHeader>
            <CardTitle>{t('twofa.manageTitle', { defaultValue: 'Manage two-factor' })}</CardTitle>
            <CardDescription>
              {t('twofa.manageDesc', {
                defaultValue: 'Two-factor is protecting your account. Disabling it lowers your security.',
              })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!disarmOpen ? (
              <Button variant="outline" onClick={() => setDisarmOpen(true)} className="text-danger">
                <ShieldAlert className="h-4 w-4" aria-hidden="true" />
                {t('twofa.disable', { defaultValue: 'Disable two-factor' })}
              </Button>
            ) : (
              <form onSubmit={disableForm.handleSubmit(onDisable)} className="space-y-4">
                <Callout tone="danger">
                  {t('twofa.disableWarn', {
                    defaultValue: 'Enter a current code or a backup code to confirm.',
                  })}
                </Callout>
                <Field
                  label={t('twofa.codeOrBackup', { defaultValue: 'Verification or backup code' })}
                  error={codeErr(disableForm.formState.errors.code?.message)}
                  required
                >
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="123456"
                      className="max-w-[12rem]"
                      {...disableForm.register('code')}
                    />
                  )}
                </Field>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setDisarmOpen(false);
                      disableForm.reset({ code: '' });
                    }}
                    disabled={disableMutation.isPending}
                  >
                    {t('common.cancel', { defaultValue: 'Cancel' })}
                  </Button>
                  <Button type="submit" loading={disableMutation.isPending} className="text-danger">
                    <KeyRound className="h-4 w-4" aria-hidden="true" />
                    {t('twofa.confirmDisable', { defaultValue: 'Confirm disable' })}
                  </Button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
