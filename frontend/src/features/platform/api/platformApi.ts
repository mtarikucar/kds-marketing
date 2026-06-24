import axios from 'axios';
import { usePlatformAuthStore } from '../../../store/platformAuthStore';
import { API_URL } from '../../../lib/env';

/**
 * Platform (superadmin) API client. No refresh machinery — the realm uses
 * a 12h access token; a 401 simply drops the operator back to the login
 * screen.
 */
const platformApi = axios.create({
  baseURL: `${API_URL}/platform`,
  headers: { 'Content-Type': 'application/json' },
});

platformApi.interceptors.request.use((config) => {
  const { accessToken } = usePlatformAuthStore.getState();
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

platformApi.interceptors.response.use(
  (response) => response,
  (error) => {
    // A 401 from the login endpoint itself means "bad credentials", not an
    // expired session — don't trigger a logout (and let the original error,
    // with the backend message, propagate to the login page).
    const isLogin = (error.config?.url ?? '').includes('/auth/login');
    if (error.response?.status === 401 && !isLogin) {
      usePlatformAuthStore.getState().logout();
    }
    return Promise.reject(error);
  },
);

export default platformApi;
