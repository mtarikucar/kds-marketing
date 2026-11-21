import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Writing one email never leads into the campaigns (owner report 2026-11-21): no screen outside
// the campaign pages links to `/outreach…`, except where what it links to is a campaign itself
// (the campaigns' menu entry, a campaign's work item or agenda line).

const SRC = resolve(__dirname, '../..');

/** The campaign pages themselves, and the API client that names their routes. */
const CAMPAIGN_FILES = new Set([
  'pages/OutreachPage.tsx',
  'pages/OutreachCampaign.tsx',
  'pages/OutreachTemplates.tsx',
  'pages/OutreachSettings.tsx',
  'pages/OutreachShared.tsx',
  'api/outreach.ts',
  'api/types.ts',
  'App.tsx',
]);
/** Links to one campaign or the campaigns' list, from where campaigns are shown. */
const CAMPAIGN_ITEM_LINKS: Record<string, RegExp> = {
  'lib/modules.ts': /outreach: '\/outreach'/,
  'lib/workItems.ts': /`\/outreach\/\$\{encodeURIComponent\(item\.campaign_id\)\}`/,
  'pages/home/agenda.ts': /`\/outreach\/\$\{encodeURIComponent\(c\.id\)\}`/,
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('no way into the campaigns from outside them', () => {
  it('no non-campaign screen links to /outreach, and none at all to its settings', () => {
    const offenders: string[] = [];
    for (const path of sources(SRC)) {
      const file = relative(SRC, path).replace(/\\/g, '/');
      const text = readFileSync(path, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (!/['"`]\/outreach/.test(line)) return;
        if (CAMPAIGN_FILES.has(file)) {
          // Only the campaign pages and the routes may name the campaigns' settings.
          if (/\/outreach\/settings/.test(line) && !['pages/OutreachPage.tsx', 'pages/OutreachSettings.tsx', 'App.tsx'].includes(file)) offenders.push(`${file}:${i + 1}`);
          return;
        }
        if (CAMPAIGN_ITEM_LINKS[file]?.test(line)) return;
        offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
