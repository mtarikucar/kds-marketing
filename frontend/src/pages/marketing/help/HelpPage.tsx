import { useTranslation } from 'react-i18next';
import { useParams, NavLink } from 'react-router-dom';
import { BookOpen } from 'lucide-react';
import { HELP_SECTIONS, findPage, FIRST_SLUG, type Lang } from './helpContent';

/**
 * In-app help center (Nextra/help.hummytummy style): a left sidebar of doc
 * sections/pages + the rendered article. Bilingual — follows the app's current
 * i18n language. Routed at /help and /help/:slug.
 */
export default function HelpPage() {
  const { i18n } = useTranslation('marketing');
  const L: Lang = (i18n.language || 'tr').toLowerCase().startsWith('tr') ? 'tr' : 'en';
  const { slug } = useParams<{ slug?: string }>();
  const page = findPage(slug) ?? findPage(FIRST_SLUG)!;

  return (
    <div className="mx-auto flex max-w-6xl gap-8">
      {/* Sidebar */}
      <aside className="hidden w-60 shrink-0 lg:block">
        <div className="sticky top-4 space-y-5">
          <div className="flex items-center gap-2 px-2 text-sm font-semibold text-foreground">
            <BookOpen className="h-4 w-4" aria-hidden="true" />
            {L === 'tr' ? 'Yardım Merkezi' : 'Help Center'}
          </div>
          {HELP_SECTIONS.map((section) => (
            <div key={section.id}>
              <p className="px-2 pb-1 text-micro font-semibold uppercase tracking-wide text-muted-foreground">
                {section.title[L]}
              </p>
              <ul className="space-y-0.5">
                {section.pages.map((p) => (
                  <li key={p.slug}>
                    <NavLink
                      to={`/help/${p.slug}`}
                      className={({ isActive }) =>
                        `block rounded-md px-2 py-1.5 text-sm transition-colors ${
                          isActive || p.slug === page.slug
                            ? 'bg-surface-muted font-medium text-foreground'
                            : 'text-muted-foreground hover:bg-surface-muted hover:text-foreground'
                        }`
                      }
                    >
                      {p.title[L]}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </aside>

      {/* Article */}
      <article className="min-w-0 flex-1 pb-16">
        {/* Mobile section picker */}
        <div className="mb-4 lg:hidden">
          <select
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground"
            value={page.slug}
            onChange={(e) => {
              window.location.assign(`/help/${e.target.value}`);
            }}
          >
            {HELP_SECTIONS.map((section) => (
              <optgroup key={section.id} label={section.title[L]}>
                {section.pages.map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.title[L]}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <h1 className="mb-2 text-2xl font-bold text-foreground">{page.title[L]}</h1>
        <div className="max-w-3xl">{page.body(L)}</div>
      </article>
    </div>
  );
}
