# Jeeta screen and state review

These browser fixtures render the real Rust panel with synthetic API responses. They cover
route pages, query-string tabs, dialogs, forms, empty and populated results, loading, errors,
permissions and recovery. They complement the component tests; they do not exercise live
payments, provider accounts, telephony or message delivery.

Start the panel development server on port 5180. The scripts use the repository's installed
`frontend/node_modules/playwright` and the panel's TypeScript installation. Install the matching
Chromium browser through Playwright if it is not already available.

From the repository root:

```sh
node rust/panel/design-review/foundation.cjs
node rust/panel/design-review/studio.cjs
node rust/panel/design-review/inbox.cjs
node rust/panel/design-review/leads.cjs
node rust/panel/design-review/admin-fixtures.cjs
```

Run sequentially on smaller machines. Each script stores screenshots and machine-readable
results in a temporary directory, leaving production assets and customer data untouched.
See the script header for case filters, server URL and output-directory overrides.
The optional `admin.cjs` smoke uses an explicitly selected disposable local account; its
`ADMIN_ACCOUNT` file is not part of the repository. Fixture scripts require no credentials.

The [review inventory](../../../docs/design/jeeta-panel/audits/coverage.md) links to exact
scenario counts and evidence for each module. Foundation's optional `JEETA_REVIEW_AXE=1`
adds automated WCAG checks; keyboard behavior and visual inspection remain separate checks.

When adding a route, dialog or distinct conditional view, update that module's scenarios and
inventory. Capture forms both before submission and in their relevant failure/result state.
Assertions must fail on unexpected API requests, browser exceptions or document overflow;
table scrolling within a bounded container is intentional. Use reduced motion, and scroll
to the top before full-page screenshots so fixed elements are not stitched at a stale offset.
