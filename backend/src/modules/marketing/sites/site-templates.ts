/**
 * Starter landing-page templates (audit A5). Static catalog — each is a
 * title + blocks[] in the exact shape the JS-free SiteRenderer consumes, so
 * "Start from template" is a pure clone into a new SitePage (no new render path).
 */
export interface SiteTemplate {
  id: string;
  name: string;
  description: string;
  title: string;
  blocks: Array<Record<string, unknown>>;
}

export const SITE_TEMPLATES: SiteTemplate[] = [
  {
    id: 'lead-magnet',
    name: 'Lead magnet',
    description: 'Offer a free guide/checklist in exchange for an email.',
    title: 'Get the free guide',
    blocks: [
      { type: 'hero', heading: 'The free guide to {your topic}', sub: 'Everything you need to get started — in one practical PDF.', ctaText: 'Get it free', ctaUrl: '#signup' },
      { type: 'features', heading: 'What you get', items: [
        { title: 'Actionable steps', text: 'No fluff — a step-by-step path you can follow today.' },
        { title: 'Proven templates', text: 'Copy-paste templates that save you hours.' },
        { title: 'Quick wins', text: 'Results you can see in the first week.' },
      ] },
      { type: 'cta', heading: 'Grab your free copy', ctaText: 'Download now', ctaUrl: '#signup' },
    ],
  },
  {
    id: 'webinar',
    name: 'Webinar registration',
    description: 'Drive sign-ups for a live or recorded webinar.',
    title: 'Register for the webinar',
    blocks: [
      { type: 'hero', heading: 'Live webinar: {your title}', sub: 'Join us on {date} and learn {the outcome}.', ctaText: 'Save my seat', ctaUrl: '#register' },
      { type: 'features', heading: "What you'll learn", items: [
        { title: 'The framework', text: 'A repeatable system you can apply immediately.' },
        { title: 'Real examples', text: 'Walkthroughs from businesses like yours.' },
        { title: 'Live Q&A', text: 'Bring your questions — we answer them live.' },
      ] },
      { type: 'faq', heading: 'FAQ', items: [
        { q: 'Is it free?', a: 'Yes — registration is completely free.' },
        { q: 'Will there be a replay?', a: 'Registrants get the recording afterwards.' },
      ] },
      { type: 'cta', heading: 'Seats are limited', ctaText: 'Register free', ctaUrl: '#register' },
    ],
  },
  {
    id: 'product-launch',
    name: 'Product launch',
    description: 'Announce a new product and capture interest.',
    title: 'Introducing {product}',
    blocks: [
      { type: 'hero', heading: 'Meet {product}', sub: 'The fastest way to {the benefit}.', ctaText: 'Get early access', ctaUrl: '#waitlist' },
      { type: 'features', heading: 'Why teams love it', items: [
        { title: 'Fast', text: 'Set up in minutes, not weeks.' },
        { title: 'Simple', text: 'No training required — it just works.' },
        { title: 'Affordable', text: 'Pricing that scales with you.' },
      ] },
      { type: 'text', text: 'Be the first to try {product}. Join the waitlist and get launch-day perks.' },
      { type: 'cta', heading: 'Join the waitlist', ctaText: 'Count me in', ctaUrl: '#waitlist' },
    ],
  },
];

export function listSiteTemplates() {
  return SITE_TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description }));
}

export function findSiteTemplate(id: string): SiteTemplate | undefined {
  return SITE_TEMPLATES.find((t) => t.id === id);
}
