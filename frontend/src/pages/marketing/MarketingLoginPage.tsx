import { useNavigate, Navigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMarketingAuthStore } from '../../store/marketingAuthStore';
import marketingApi from '../../features/marketing/api/marketingApi';
import { fetchMemberships } from '../../features/marketing/api/membershipApi';
import { loginErrorMessage } from '../../features/marketing/api/authError';
import { Card, CardContent, CardHeader } from '../../components/ui/Card';
import { Field } from '../../components/ui/Field';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Callout';

const loginSchema = z.object({
  email: z.string().trim().min(1, 'required').email('emailInvalid'),
  password: z.string().min(1, 'required'),
});
type LoginValues = z.infer<typeof loginSchema>;

export default function MarketingLoginPage() {
  const navigate = useNavigate();
  const { t } = useTranslation('marketing');
  const { login, setMemberships, isAuthenticated } = useMarketingAuthStore();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
  });

  // Guard AFTER all hooks (Rules of Hooks): every render calls the same hooks in
  // the same order; an already-authenticated visitor is then redirected before
  // any form renders.
  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
  }

  const onSubmit = async (values: LoginValues) => {
    try {
      const { data } = await marketingApi.post('/auth/login', values);
      login(data.user, data.accessToken, data.refreshToken);
      // Best-effort: the login response itself carries no `memberships`
      // (only GET /auth/profile does), so fetch it as a follow-up. A hiccup
      // here must never block navigation into the app — the workspace
      // switcher just stays empty until the next successful profile fetch.
      try {
        setMemberships(await fetchMemberships());
      } catch {
        // ignored — see comment above
      }
      navigate('/dashboard');
    } catch (err: any) {
      setError('root', { message: loginErrorMessage(err, t) });
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
                <h1 className="font-display text-h2 text-foreground">{t('login.title')}</h1>
                <p className="text-sm text-muted-foreground mt-1">{t('login.subtitle')}</p>
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
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    {...register('email')}
                  />
                )}
              </Field>

              <Field
                label={t('login.passwordLabel')}
                required
                error={errors.password?.message}
              >
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    type="password"
                    autoComplete="current-password"
                    placeholder="••••••••"
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
                {t('login.submit')}
              </Button>
            </form>

            <p className="text-center text-sm text-muted-foreground mt-6">
              {t('register.noAccount', "Don't have a workspace yet?")}{' '}
              <Link to="/register" className="text-primary font-medium hover:underline">
                {t('register.cta', 'Create one')}
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
