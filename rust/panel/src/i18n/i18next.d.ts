import 'i18next';
import type tr from './tr.json';

// Keys passed to `t` are checked against the Turkish catalog at compile time; the parity test
// keeps the English one in step.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof tr };
  }
}
