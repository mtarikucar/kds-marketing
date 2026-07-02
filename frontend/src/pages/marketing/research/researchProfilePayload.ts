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
export function buildResearchPayload(values: ResearchProfileFormValues) {
  const country = values.country?.trim() ?? '';
  const cities = values.cities
    ? values.cities.split(',').map((c) => c.trim()).filter(Boolean)
    : [];
  const geo =
    country || cities.length
      ? {
          ...(country ? { country } : {}),
          ...(cities.length ? { cities } : {}),
        }
      : null;
  return {
    name: values.name,
    icpDescription: values.icpDescription,
    productPitch: values.productPitch?.trim() || null,
    language: values.language,
    geo,
    exclusions: values.exclusions?.trim() || null,
  };
}
