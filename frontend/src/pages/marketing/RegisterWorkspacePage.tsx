import { useState } from 'react';
import { useNavigate, Navigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMarketingAuthStore } from '../../store/marketingAuthStore';
import marketingApi from '../../features/marketing/api/marketingApi';

/**
 * Self-serve workspace signup: one form creates the organization, its OWNER
 * account and the research scaffolding, then drops the user straight into
 * the dashboard with a live session (the endpoint returns a token pair).
 */
export default function RegisterWorkspacePage() {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation('marketing');
  const { login, isAuthenticated } = useMarketingAuthStore();

  const [form, setForm] = useState({
    workspaceName: '',
    productName: '',
    productUrl: '',
    email: '',
    password: '',
    firstName: '',
    lastName: '',
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Guard AFTER all hooks (Rules of Hooks): an already-authenticated visitor is
  // redirected before the form renders, but the hook order stays stable.
  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
  }

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const { data } = await marketingApi.post('/auth/register-workspace', {
        ...form,
        productUrl: form.productUrl || undefined,
        language: i18n.language?.split('-')[0],
      });
      login(data.user, data.accessToken, data.refreshToken);
      navigate('/dashboard');
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || t('register.failed', 'Registration failed'));
    } finally {
      setLoading(false);
    }
  };

  const inputCls =
    'w-full px-4 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-primary outline-none';
  const labelCls = 'block text-sm font-medium text-slate-700 mb-1';

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/5 to-primary/10 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="bg-white rounded-2xl shadow-xl p-8">
          <div className="text-center mb-8">
            <div className="w-14 h-14 bg-primary rounded-xl flex items-center justify-center mx-auto mb-4">
              <span className="text-primary-foreground font-bold text-xl">M</span>
            </div>
            <h1 className="text-2xl font-bold text-slate-900">
              {t('register.title', 'Create your workspace')}
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              {t(
                'register.subtitle',
                'Your team, your leads, your research — in one place.',
              )}
            </p>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className={labelCls}>
                {t('register.workspaceName', 'Company / workspace name')}
              </label>
              <input value={form.workspaceName} onChange={set('workspaceName')} required maxLength={120} className={inputCls} placeholder="Acme Inc." />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>{t('register.productName', 'What do you sell?')}</label>
                <input value={form.productName} onChange={set('productName')} required maxLength={120} className={inputCls} placeholder="Acme POS" />
              </div>
              <div>
                <label className={labelCls}>{t('register.productUrl', 'Product URL (optional)')}</label>
                <input value={form.productUrl} onChange={set('productUrl')} type="url" maxLength={255} className={inputCls} placeholder="https://acme.com" />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>{t('register.firstName', 'First name')}</label>
                <input value={form.firstName} onChange={set('firstName')} required maxLength={100} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>{t('register.lastName', 'Last name')}</label>
                <input value={form.lastName} onChange={set('lastName')} required maxLength={100} className={inputCls} />
              </div>
            </div>

            <div>
              <label className={labelCls}>{t('login.emailLabel')}</label>
              <input value={form.email} onChange={set('email')} type="email" required maxLength={254} className={inputCls} placeholder="you@company.com" />
            </div>

            <div>
              <label className={labelCls}>{t('login.passwordLabel')}</label>
              <input
                value={form.password}
                onChange={set('password')}
                type="password"
                required
                minLength={8}
                maxLength={128}
                className={inputCls}
                placeholder="••••••••"
              />
              <p className="text-xs text-slate-400 mt-1">
                {t('register.passwordHint', 'Min 8 characters, at least one letter and one digit.')}
              </p>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading
                ? t('register.loading', 'Creating workspace…')
                : t('register.submit', 'Create workspace')}
            </button>
          </form>

          <p className="text-center text-sm text-slate-500 mt-6">
            {t('register.haveAccount', 'Already have an account?')}{' '}
            <Link to="/login" className="text-primary font-medium hover:underline">
              {t('login.submit')}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
