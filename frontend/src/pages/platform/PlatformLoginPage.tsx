import { useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { usePlatformAuthStore } from '../../store/platformAuthStore';
import platformApi from '../../features/platform/api/platformApi';

export default function PlatformLoginPage() {
  const navigate = useNavigate();
  const { login, isAuthenticated } = usePlatformAuthStore();

  if (isAuthenticated) {
    return <Navigate to="/platform/workspaces" replace />;
  }

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await platformApi.post('/auth/login', { email, password });
      login(data.operator, data.accessToken);
      navigate('/platform/workspaces');
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-xl p-8">
          <div className="text-center mb-8">
            <div className="w-14 h-14 bg-slate-900 rounded-xl flex items-center justify-center mx-auto mb-4">
              <span className="text-white font-bold text-xl">P</span>
            </div>
            <h1 className="text-2xl font-bold text-slate-900">Platform Console</h1>
            <p className="text-sm text-slate-500 mt-1">Operator access only</p>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full px-4 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-slate-900 focus:border-slate-900 outline-none"
                placeholder="ops@platform"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full px-4 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-slate-900 focus:border-slate-900 outline-none"
                placeholder="••••••••••••"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 bg-slate-900 text-white rounded-lg font-medium hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
