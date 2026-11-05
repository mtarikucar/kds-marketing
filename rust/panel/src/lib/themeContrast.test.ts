import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8');
const luminance = (hex: string) => {
  const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
};

describe.each([':root', ':root.dark'])('%s readable text tokens', (selector) => {
  const section = css.split(`${selector} {`)[1].split('}')[0];
  const tokens = Object.fromEntries([...section.matchAll(/--([\w-]+):\s*(#[\da-fA-F]{6})/g)].map((match) => [match[1], match[2]]));
  it.each([
    ['foreground', 'background'], ['foreground', 'surface'], ['muted-foreground', 'surface-muted'],
    ['success', 'success-subtle'], ['warning', 'warning-subtle'], ['danger', 'danger-subtle'], ['info', 'info-subtle'],
    ['primary-foreground', 'primary'], ['danger-foreground', 'danger'],
  ])('%s on %s meets WCAG AA for normal-size text', (foreground, background) => {
    const [dark, light] = [luminance(tokens[foreground]), luminance(tokens[background])].sort((a, b) => a - b);
    expect((light + 0.05) / (dark + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
});
