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
    if (error.response?.status === 401) {
      usePlatformAuthStore.getState().logout();
    }
    return Promise.reject(error);
  },
);

export default platformApi;
