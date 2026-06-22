/**
 * companies.service.ts — Companies / B2B accounts (GoHighLevel parity). A
 * company groups contacts (Lead.companyId) and rolls up their open
 * opportunities + conversations. Thin typed wrappers over marketingApi.
 */

import marketingApi from './marketingApi';

export interface Company {
  id: string;
  name: string;
  domain: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  notes: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  contactCount?: number;
}

export interface CompanyDetail extends Company {
  contactCount: number;
  openOpportunities: number;
  openValue: number;
  conversationCount: number;
}

export interface CompanyContact {
  id: string;
  businessName: string;
  contactPerson: string;
  email: string | null;
  phone: string | null;
  status: string;
  createdAt: string;
}

export interface CompanyPayload {
  name: string;
  domain?: string;
  phone?: string;
  email?: string;
  address?: string;
  city?: string;
  notes?: string;
}

export const listCompanies = (search?: string): Promise<Company[]> =>
  marketingApi.get('/companies', { params: search ? { search } : {} }).then((r) => r.data);

export const getCompany = (id: string): Promise<CompanyDetail> =>
  marketingApi.get(`/companies/${id}`).then((r) => r.data);

export const getCompanyContacts = (id: string): Promise<CompanyContact[]> =>
  marketingApi.get(`/companies/${id}/contacts`).then((r) => r.data);

export const createCompany = (payload: CompanyPayload): Promise<Company> =>
  marketingApi.post('/companies', payload).then((r) => r.data);

export const updateCompany = (id: string, payload: Partial<CompanyPayload> & { archived?: boolean }): Promise<Company> =>
  marketingApi.patch(`/companies/${id}`, payload).then((r) => r.data);

export const deleteCompany = (id: string): Promise<{ message: string }> =>
  marketingApi.delete(`/companies/${id}`).then((r) => r.data);
