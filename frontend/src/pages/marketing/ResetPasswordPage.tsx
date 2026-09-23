import { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import marketingApi from '../../features/marketing/api/marketingApi';
import { Card, CardContent, CardHeader } from '../../components/ui/Card';
import { Field } from '../../components/ui/Field';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Callout';

/**
 * `no-password-recovery` — where the mailed reset link lands.
 *
 * `MarketingAuthService.sendResetMail` builds
 * `${FRONTEND_URL}/reset-password?token=…`, so this route has to exist on the
 * SPA or the catch-all sends the locked-out owner to the landing page and
 * throws the token away — with a thirty-minute TTL that can only be spent
 * once, that is the whole recovery path gone.
 *
 * Public by necessity: having no session is the problem being solved. The
 * token in the query string is the only credential, exactly as on
 * `/accept-invite`.
 *
 * Two deliberate restraints:
 *  - The backend returns NO session on success, so the owner signs in
 *    afterwards through the 2FA, status and membership gates a minted session
 *    would have skipped. This page never tries to log anybody in.
 *  - Every rejection (expired, already spent, bad signature, ineligible
 *    account) comes back as one message on purpose. The UI keeps it one
 *    message; inventing a distinction here would hand back the oracle the
 *    service spends a dummy bcrypt compare to deny.
 */

/** The same policy `ResetPasswordDto` enforces — asked before the link is spent. */
const resetSchema = z
  .object({
    newPassword: z
      .string()
      .min(8, 'Password must be at least 8 characters.')
      .max(128, 'Password must be at most 128 characters.')
      .regex(/[a-z]/, 'Password must include a lowercase letter.')
      .regex(/[A-Z]/, 'Password must include an uppercase letter.')
      .regex(/\d/, 'Password must include a digit.'),
    confirm: z.string(),
  })
  .refine((v) => v.newPassword === v.confirm, {
    path: ['confirm'],
    message: 'The two passwords do not match.',
  });
type ResetValues = z.infer<typeof resetSchema>;

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t } = useTranslation('marketing');
  const token = searchParams.get('token') ?? '';
  const [spent, setSpent] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ResetValues>({ resolver: zodResolver(resetSchema) });

  const onSubmit = async (values: ResetValues) => {
    try {
      await marketingApi.post('/auth/reset-password', { token, newPassword: values.newPassword });
      // The next page is a fresh mount, so the toast (rendered by the app-root
      // <Toaster/>) is what carries the confirmation across the navigation.
      toast.success(
        t('passwordReset.done', 'Password updated — please sign in with your new password.'),
      );
      navigate('/login');
    } catch {
      // One state for every refusal. See the docblock.
      setSpent(true);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <Card>
          <CardHeader>
            <div className="flex flex-col items-center gap-3 pb-2">
              <img
                src="/logo-mark.png"
                alt="Jeeta"
                className="h-14 w-14 rounded-2xl object-cover shadow-sm ring-1 ring-black/5"
              />
              <div className="text-center">
                <h1 className="font-display text-h2 text-foreground">
                  {t('passwordReset.title', 'Choose a new password')}
                </h1>
                <p className="text-sm text-muted-foreground mt-1">
                  {t(
                    'passwordReset.subtitle',
                    'This link works once. Setting a password also signs you out everywhere else.',
                  )}
                </p>
              </div>
            </div>
          </CardHeader>

          <CardContent>
            {!token && (
              <Callout tone="danger" className="mb-4">
                {t(
                  'passwordReset.noToken',
                  'This link is missing its token. Please use the link from the email.',
                )}
              </Callout>
            )}
            {spent && (
              <Callout tone="danger" className="mb-4">
                {t(
                  'passwordReset.rejected',
                  'This link has expired or has already been used.',
                )}{' '}
                <Link to="/forgot-password" className="text-primary font-medium hover:underline">
                  {t('passwordReset.requestAnother', 'Request a new link')}
                </Link>
              </Callout>
            )}

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
              <Field
                label={t('passwordReset.newPassword', 'New password')}
                hint={t(
                  'passwordReset.policy',
                  'At least 8 characters, with an uppercase letter, a lowercase letter and a digit.',
                )}
                error={errors.newPassword?.message}
              >
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    type="password"
                    autoComplete="new-password"
                    placeholder="••••••••"
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    {...register('newPassword')}
                  />
                )}
              </Field>

              <Field
                label={t('passwordReset.confirmPassword', 'Confirm new password')}
                error={errors.confirm?.message}
              >
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    type="password"
                    autoComplete="new-password"
                    placeholder="••••••••"
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    {...register('confirm')}
                  />
                )}
              </Field>

              <Button
                type="submit"
                size="lg"
                loading={isSubmitting}
                disabled={!token}
                className="w-full"
              >
                {t('passwordReset.submit', 'Set a new password')}
              </Button>
            </form>

            <p className="text-center text-sm text-muted-foreground mt-6">
              <Link to="/login" className="text-primary font-medium hover:underline">
                {t('passwordReset.backToLogin', 'Back to sign in')}
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
