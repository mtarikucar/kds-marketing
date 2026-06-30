// The automations list now lives in its own module alongside the builder.
// This re-export keeps the existing route import (`./pages/marketing/AutomationsPage`)
// stable while the builder moved out of a modal into dedicated pages.
export { default } from './automations/AutomationsListPage';
