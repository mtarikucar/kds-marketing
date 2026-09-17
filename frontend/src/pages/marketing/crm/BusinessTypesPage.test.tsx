import { render, screen, fireEvent, waitFor, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import type { ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import en from '../../../i18n/locales/en/marketing.json';
import tr from '../../../i18n/locales/tr/marketing.json';
import BusinessTypesPage from './BusinessTypesPage';
import { useBusinessTypes } from './businessTypes';

const { get, patch, auth } = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), auth: { user: { workspaceId: 'w1' } } }));
vi.mock('../../../features/marketing/api/marketingApi', () => ({ default: { get, patch } }));
vi.mock('../../../store/marketingAuthStore', () => ({ useMarketingAuthStore: (selector: (s: typeof auth) => unknown) => selector(auth) }));

beforeEach(() => {
  vi.clearAllMocks();
  auth.user.workspaceId = 'w1';
  get.mockResolvedValue({ data: { businessTypes: ['CAFE', 'OTHER'], canManage: true } });
  patch.mockResolvedValue({ data: { businessTypes: ['ECOMMERCE', 'OTHER'] } });
});

function setup(language = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const i18n = createInstance();
  void i18n.init({ lng: language, fallbackLng: 'en', resources: { en: { marketing: en }, tr: { marketing: tr } }, initImmediate: false });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}><I18nextProvider i18n={i18n}>{children}</I18nextProvider></QueryClientProvider>;
  return { client, wrapper };
}

it('loads, saves the keys and refreshes other consumers', async () => {
  const { wrapper } = setup();
  render(<BusinessTypesPage />, { wrapper });
  const input = await screen.findByRole('textbox');
  await waitFor(() => expect(input).toHaveValue('CAFE\nOTHER'));
  fireEvent.change(input, { target: { value: 'ECOMMERCE\nOTHER' } });
  get.mockResolvedValue({ data: { businessTypes: ['ECOMMERCE', 'OTHER'] } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Business types saved.');
  expect(patch).toHaveBeenCalledWith('/workspaces/business-types', { businessTypes: ['ECOMMERCE', 'OTHER'] });
  expect(get.mock.calls.length).toBeGreaterThan(1);
});

it.each(['', 'cafe', 'CAFE\nCAFE', 'A'.repeat(61), Array.from({ length: 101 }, (_, i) => `TYPE_${i}`).join('\n')])('rejects invalid input %s', async (value) => {
  const { wrapper } = setup();
  render(<BusinessTypesPage />, { wrapper });
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('CAFE\nOTHER'));
  fireEvent.change(screen.getByRole('textbox'), { target: { value } });
  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(patch).not.toHaveBeenCalled();
});

it('keeps the draft after a failed save and allows retry', async () => {
  patch.mockRejectedValueOnce(new Error('offline'));
  const { wrapper } = setup();
  render(<BusinessTypesPage />, { wrapper });
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('CAFE\nOTHER'));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ECOMMERCE\nOTHER' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not save business types. Please try again.');
  expect(screen.getByRole('textbox')).toHaveValue('ECOMMERCE\nOTHER');
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
});

it('shows Turkish validation', async () => {
  const { wrapper } = setup('tr');
  render(<BusinessTypesPage />, { wrapper });
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('CAFE\nOTHER'));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'CAFE\nCAFE' } });
  expect(screen.getByRole('alert')).toHaveTextContent('Her anahtar yalnızca bir kez kullanılabilir.');
});

it.each([null, {}, { businessTypes: [] }, { businessTypes: ['bad'] }, { businessTypes: ['CAFE', 'CAFE'] }])('falls back safely for malformed API data %j', async (data) => {
  get.mockResolvedValue({ data });
  const { wrapper } = setup();
  const { result } = renderHook(useBusinessTypes, { wrapper });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.businessTypes).toEqual(['OTHER']);
  expect(result.current.filterBusinessTypes).toEqual(['OTHER']);
});

it('falls back when API is unavailable and prevents editing unloaded settings', async () => {
  get.mockRejectedValue(new Error('missing endpoint'));
  const { wrapper } = setup();
  render(<BusinessTypesPage />, { wrapper });
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load business types.');
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
});

it('does not reuse the previous workspace data or draft', async () => {
  const { wrapper } = setup();
  const { rerender } = render(<BusinessTypesPage />, { wrapper });
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('CAFE\nOTHER'));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'UNSAVED' } });
  auth.user.workspaceId = 'w2';
  get.mockResolvedValue({ data: { businessTypes: ['HOTEL'], canManage: true } });
  rerender(<BusinessTypesPage />);
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('HOTEL'));
});

it('disables the editor during loading and a pending save', async () => {
  let resolveLoad!: (value: unknown) => void;
  let resolveSave!: (value: unknown) => void;
  get.mockImplementationOnce(() => new Promise((resolve) => { resolveLoad = resolve; }));
  patch.mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve; }));
  const { wrapper } = setup();
  render(<BusinessTypesPage />, { wrapper });
  expect(screen.getByRole('status')).toHaveTextContent('Loading business types');
  expect(screen.getByRole('textbox')).toBeDisabled();
  resolveLoad({ data: { businessTypes: ['CAFE'], canManage: true } });
  await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ECOMMERCE\nOTHER' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('button', { name: /Saving…/ })).toBeDisabled();
  expect(screen.getByRole('textbox')).toBeDisabled();
  resolveSave({ data: { businessTypes: ['ECOMMERCE', 'OTHER'] } });
  await screen.findByText('Business types saved.');
});

it('accepts the contract boundaries and ignores empty lines', async () => {
  const { wrapper } = setup();
  render(<BusinessTypesPage />, { wrapper });
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('CAFE\nOTHER'));
  const keys = ['A'.repeat(60), ...Array.from({ length: 99 }, (_, i) => `TYPE_${i}`)];
  fireEvent.change(screen.getByRole('textbox'), { target: { value: `\n ${keys.join('\n')} \n` } });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(patch).toHaveBeenCalledWith('/workspaces/business-types', { businessTypes: keys }));
});

it('keeps historical keys available only to filters and preserves response metadata', async () => {
  get.mockResolvedValue({ data: { businessTypes: ['CAFE'], historicalBusinessTypes: ['RESTAURANT', 'CAFE'], canManage: false } });
  const { wrapper, client } = setup();
  const { result } = renderHook(useBusinessTypes, { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.businessTypes).toEqual(['CAFE']);
  expect(result.current.filterBusinessTypes).toEqual(['CAFE', 'RESTAURANT']);
  expect(result.current.data?.canManage).toBe(false);
  expect(client.getQueryData(['marketing', 'workspace', 'w1', 'business-types'])).toEqual(result.current.data);
});

it.each([false, undefined])('makes settings read-only unless effective permission is granted (%s)', async (canManage) => {
  get.mockResolvedValue({ data: { businessTypes: ['CAFE'], canManage } });
  const { wrapper } = setup();
  render(<BusinessTypesPage />, { wrapper });
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('CAFE'));
  expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
  expect(screen.getByText('You can view business types. Managing them requires workspace settings permission.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  fireEvent.submit(screen.getByRole('button', { name: 'Save' }).closest('form')!);
  expect(patch).not.toHaveBeenCalled();
});

it('preserves GET metadata while PATCH is followed by mandatory refetch', async () => {
  get.mockResolvedValueOnce({ data: { businessTypes: ['CAFE'], historicalBusinessTypes: ['OLD'], canManage: true } });
  get.mockImplementationOnce(() => new Promise(() => undefined));
  const { wrapper, client } = setup();
  render(<BusinessTypesPage />, { wrapper });
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('CAFE'));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ECOMMERCE\nOTHER' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(client.getQueryData(['marketing', 'workspace', 'w1', 'business-types'])).toEqual({ businessTypes: ['ECOMMERCE', 'OTHER'], historicalBusinessTypes: ['OLD'], canManage: true }));
  expect(get).toHaveBeenCalledTimes(2);
});
