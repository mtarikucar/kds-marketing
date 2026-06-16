import { useNavigate, Navigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ShieldCheck } from 'lucide-react';
import { usePlatformAuthStore } from '../../store/platformAuthStore';
import platformApi from '../../features/platform/api/platformApi';
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

export default function PlatformLoginPage() {
  const navigate = useNavigate();
  const { login, isAuthenticated } = usePlatformAuthStore();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
  });

  // Guard AFTER all hooks (Rules of Hooks): an already-authenticated operator is
  // redirected before the form renders, but the hook order stays stable.
  if (isAuthenticated) {
    return <Navigate to="/platform/workspaces" replace />;
  }

  const onSubmit = async (values: LoginValues) => {
    try {
      const { data } = await platformApi.post('/auth/login', values);
      login(data.operator, data.accessToken);
      navigate('/platform/workspaces');
    } catch (err: any) {
      setError('root', {
        message: err.response?.data?.message || err.message || 'Login failed',
      });
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <Card>
          <CardHeader>
            <div className="flex flex-col items-center gap-3 pb-2">
              <div className="w-12 h-12 bg-foreground rounded-xl flex items-center justify-center">
                <ShieldCheck className="h-6 w-6 text-background" aria-hidden="true" />
              </div>
              <div className="text-center">
                <h1 className="font-display text-h2 text-foreground">Platform Console</h1>
                <p className="text-sm text-muted-foreground mt-1">Operator access only</p>
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
              <Field label="Email" required error={errors.email?.message}>
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    type="email"
                    autoComplete="email"
                    placeholder="ops@platform"
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    {...register('email')}
                  />
                )}
              </Field>

              <Field label="Password" required error={errors.password?.message}>
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    type="password"
                    autoComplete="current-password"
                    placeholder="••••••••••••"
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
                {isSubmitting ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
