import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import marketingApi from '../../features/marketing/api/marketingApi';
import { Card, CardContent, CardHeader } from '../../components/ui/Card';
import { Field } from '../../components/ui/Field';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Callout';

/**
 * `no-password-recovery` — the control that asks for a reset link.
 *
 * `POST /marketing/auth/forgot-password` existed with nothing in the product
 * calling it, so a locked-out owner's only route back in was another manager
 * with a live session. This is that route.
 *
 * The acknowledgement is CONSTANT: the same words whether the address is
 * registered, unknown, throttled or the mail failed to leave. The service
 * spends a dummy bcrypt compare to keep an unknown address costing what a
 * known one costs; a UI that rendered the error instead would give the
 * enumeration answer away in plain text.
 */

const forgotSchema = z.object({
  email: z.string().trim().min(1, 'required').email('emailInvalid'),
});
type ForgotValues = z.infer<typeof forgotSchema>;

export default function ForgotPasswordPage() {
  const { t } = useTranslation('marketing');
  const [asked, setAsked] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotValues>({ resolver: zodResolver(forgotSchema) });

  const onSubmit = async (values: ForgotValues) => {
    try {
      await marketingApi.post('/auth/forgot-password', { email: values.email });
    } catch {
      // Deliberately swallowed — see the docblock. Whatever happened, the
      // caller is told the same thing.
    }
    setAsked(true);
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
                  {t('passwordReset.forgotTitle', 'Reset your password')}
                </h1>
                <p className="text-sm text-muted-foreground mt-1">
                  {t(
                    'passwordReset.forgotSubtitle',
                    'We will email you a link that lets you set a new one.',
                  )}
                </p>
              </div>
            </div>
          </CardHeader>

          <CardContent>
            {asked && (
              <Callout tone="success" className="mb-4">
                {t(
                  'passwordReset.forgotAck',
                  'If that address has an account, a reset link is on its way. The link expires in 30 minutes.',
                )}
              </Callout>
            )}

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
              <Field label={t('login.emailLabel', 'Email')} error={errors.email?.message}>
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    type="email"
                    autoComplete="email"
                    placeholder="you@company.com"
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    {...register('email')}
                  />
                )}
              </Field>

              <Button type="submit" size="lg" loading={isSubmitting} className="w-full">
                {t('passwordReset.forgotSubmit', 'Send the reset link')}
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
