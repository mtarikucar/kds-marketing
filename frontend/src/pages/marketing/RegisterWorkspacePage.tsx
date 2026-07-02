import { useNavigate, Navigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Building2 } from 'lucide-react';
import { useMarketingAuthStore } from '../../store/marketingAuthStore';
import marketingApi from '../../features/marketing/api/marketingApi';
import { passwordSchema } from '../../features/marketing/schemas';
import { Card, CardContent, CardHeader } from '../../components/ui/Card';
import { Field } from '../../components/ui/Field';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Callout';

/**
 * Self-serve workspace signup: one form creates the organization, its OWNER
 * account and the research scaffolding, then drops the user straight into
 * the dashboard with a live session (the endpoint returns a token pair).
 *
 * Referral capture is handled at the App root via `useReferralCapture` which
 * writes the ?ref= code to a 30-day cookie; the checkout page reads it back
 * via `readReferralCookie`. No referral logic needed here.
 */

const registerSchema = z.object({
  workspaceName: z.string().trim().min(1, 'required').max(120),
  productName: z.string().trim().min(1, 'required').max(120),
  productUrl: z
    .string()
    .trim()
    .max(255)
    .optional()
    .transform((v) => v || undefined),
  firstName: z.string().trim().min(1, 'required').max(100),
  lastName: z.string().trim().min(1, 'required').max(100),
  email: z
    .string()
    .trim()
    .min(1, 'required')
    .refine((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), { message: 'emailInvalid' }),
  password: passwordSchema,
});
type RegisterValues = z.infer<typeof registerSchema>;

export default function RegisterWorkspacePage() {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation('marketing');
  const { login, isAuthenticated } = useMarketingAuthStore();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<RegisterValues>({
    resolver: zodResolver(registerSchema),
  });

  // Guard AFTER all hooks (Rules of Hooks): an already-authenticated visitor is
  // redirected before the form renders, but the hook order stays stable.
  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
  }

  const onSubmit = async (values: RegisterValues) => {
    try {
      const { data } = await marketingApi.post('/auth/register-workspace', {
        ...values,
        productUrl: values.productUrl || undefined,
        language: i18n.language?.split('-')[0],
      });
      login(data.user, data.accessToken, data.refreshToken);
      navigate('/dashboard?welcome=1');
    } catch (err: any) {
      setError('root', {
        message:
          err.response?.data?.message || err.message || t('register.failed', 'Registration failed'),
      });
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg">
        <Card>
          <CardHeader>
            <div className="flex flex-col items-center gap-3 pb-2">
              <div className="w-12 h-12 bg-primary rounded-xl flex items-center justify-center">
                <Building2 className="h-6 w-6 text-primary-foreground" aria-hidden="true" />
              </div>
              <div className="text-center">
                <h1 className="font-display text-h2 text-foreground">
                  {t('register.title', 'Create your workspace')}
                </h1>
                <p className="text-sm text-muted-foreground mt-1">
                  {t('register.subtitle', 'Your team, your leads, your research — in one place.')}
                </p>
              </div>
            </div>
          </CardHeader>

          <CardContent>
            {errors.root && (
              <Callout tone="danger" className="mb-4">
                {errors.root.message}
              </Callout>
            )}

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
              <Field
                label={t('register.workspaceName', 'Company / workspace name')}
                required
                error={errors.workspaceName?.message}
              >
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    placeholder="Acme Inc."
                    maxLength={120}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    {...register('workspaceName')}
                  />
                )}
              </Field>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field
                  label={t('register.productName', 'What do you sell?')}
                  required
                  error={errors.productName?.message}
                >
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      placeholder="Acme POS"
                      maxLength={120}
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      {...register('productName')}
                    />
                  )}
                </Field>

                <Field
                  label={t('register.productUrl', 'Product URL (optional)')}
                  error={errors.productUrl?.message}
                >
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      type="url"
                      placeholder="https://acme.com"
                      maxLength={255}
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      {...register('productUrl')}
                    />
                  )}
                </Field>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field
                  label={t('register.firstName', 'First name')}
                  required
                  error={errors.firstName?.message}
                >
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      autoComplete="given-name"
                      maxLength={100}
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      {...register('firstName')}
                    />
                  )}
                </Field>

                <Field
                  label={t('register.lastName', 'Last name')}
                  required
                  error={errors.lastName?.message}
                >
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      autoComplete="family-name"
                      maxLength={100}
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      {...register('lastName')}
                    />
                  )}
                </Field>
              </div>

              <Field
                label={t('login.emailLabel')}
                required
                error={errors.email?.message}
              >
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    type="email"
                    autoComplete="email"
                    placeholder="you@company.com"
                    maxLength={254}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    {...register('email')}
                  />
                )}
              </Field>

              <Field
                label={t('login.passwordLabel')}
                required
                hint={t('register.passwordHint', 'Min 8 characters, at least one letter and one digit.')}
                error={errors.password?.message}
              >
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    type="password"
                    autoComplete="new-password"
                    placeholder="••••••••"
                    maxLength={128}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    {...register('password')}
                  />
                )}
              </Field>

              <Button
                type="submit"
                size="lg"
                loading={isSubmitting}
                className="w-full"
              >
                {t('register.submit', 'Create workspace')}
              </Button>
            </form>

            <p className="text-center text-sm text-muted-foreground mt-6">
              {t('register.haveAccount', 'Already have an account?')}{' '}
              <Link to="/login" className="text-primary font-medium hover:underline">
                {t('login.submit')}
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
