import type { ResearchProfileFormValues } from './ResearchProfileForm';

/**
 * Build the create/update body from the research-profile form values.
 *
 * The subtlety is the optional fields on EDIT. The backend `update()` spreads
 * `...scalar` from the DTO, so an OMITTED key is Prisma undefined-skipped and the
 * OLD value survives — i.e. sending `undefined` for an emptied field can't clear
 * it (clear-doesn't-persist). We therefore send `null` for an emptied
 * productPitch / exclusions and `null` for a fully-cleared geo, which
 * UpdateResearchProfileDto's `@IsOptional()` accepts and the service writes as
 * null / Prisma.JsonNull. On CREATE null is equivalent to the old undefined
 * (the service coerces both to null/JsonNull), so this is safe for both paths.
 */
const splitList = (s?: string) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);

export function buildResearchPayload(values: ResearchProfileFormValues) {
  const country = values.country?.trim() ?? '';
  const cities = splitList(values.cities);
  const regions = splitList(values.regions);
  const geo =
    country || cities.length || regions.length
      ? {
          ...(country ? { country } : {}),
          ...(regions.length ? { regions } : {}),
          ...(cities.length ? { cities } : {}),
        }
      : null;
  // UPPER_SNAKE the business-type taxonomy hints (matches the DTO validator).
  const businessTypes = splitList(values.businessTypes).map((b) =>
    b.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, ''),
  ).filter(Boolean);
  return {
    name: values.name,
    icpDescription: values.icpDescription,
    productPitch: values.productPitch?.trim() || null,
    language: values.language,
    geo,
    businessTypes,
    exclusions: values.exclusions?.trim() || null,
  };
}
