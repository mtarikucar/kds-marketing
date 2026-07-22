/**
 * Company / legal identity used across the Privacy Policy, Terms of Service and
 * the landing footer. Confirmed by the operator; matches the GİB vergi levhası.
 * Update here to keep every surface in sync.
 *
 * Kept in its OWN module (no imports) so it can be shared by both `legalShared`
 * (which imports the landing footer) and `LandingFooter` without a circular
 * dependency.
 */
export const LEGAL = {
  brand: 'Jeeta Growth',
  /** KVKK data controller = the registered legal owner (brand is a trade name). */
  entity: 'Beyza Uçar (Jeeta Growth)',
  /** Registered legal identity — matches the GİB vergi levhası. */
  legalName: 'Beyza Uçar',
  businessType: 'Şahıs İşletmesi',
  businessTypeEn: 'Sole proprietorship',
  taxOffice: 'Ereğli Vergi Dairesi',
  address: 'Türbe Mah. 92236. Sk. İnan Apt. No: 14/1, Ereğli/Konya',
  email: 'admin@jeetagrowth.com',
  city: 'Ereğli, Konya',
  countryTr: 'Türkiye',
  countryEn: 'Türkiye',
  /** Courts / governing law seat. */
  jurisdiction: 'Konya',
  effectiveDateTr: '24 Haziran 2026',
  effectiveDateEn: 'June 24, 2026',
} as const;
