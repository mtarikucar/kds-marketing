# Compact usage dashboard pricing

Verified against official Anthropic documentation on 2026-09-18. The dashboard
helper is independent of `ai-model-prices.ts`, which continues to serve existing
reports unchanged.

## Sources and rates

[Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)
provides these standard Claude API rates, in USD per million tokens:

| Model versions supported   | Input | Output | 5-minute write | Cache read |
| -------------------------- | ----: | -----: | -------------: | ---------: |
| Opus 4, 4.1                |    15 |     75 |          18.75 |       1.50 |
| Opus 4.5, 4.6, 4.7, 4.8, 5 |     5 |     25 |           6.25 |       0.50 |
| Sonnet 4, 4.5, 4.6         |     3 |     15 |           3.75 |       0.30 |
| Sonnet 5                   |     2 |     10 |           2.50 |       0.20 |
| Haiku 3.5                  |  0.80 |      4 |              1 |       0.08 |
| Haiku 4.5                  |     1 |      5 |           1.25 |       0.10 |

The explicit ID allowlist is in `ai-dashboard-prices.ts`. ID and alias evidence:

- [Model IDs and versioning](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions): canonical dateless IDs from generation 4.6 onward; Sonnet 4.5 snapshot and alias.
- [Opus 4.5](https://platform.claude.com/docs/en/models/opus-4-5/overview): `claude-opus-4-5-20251101` and `claude-opus-4-5`.
- [Haiku 4.5](https://platform.claude.com/docs/en/models/haiku-4-5/overview): `claude-haiku-4-5-20251001` and `claude-haiku-4-5`.
- [Model lifecycle](https://platform.claude.com/docs/en/about-claude/model-deprecations): exact older dated IDs, including retired models relevant to stored usage.

Only listed exact IDs are supported. An unknown version, invented date, provider
prefix, or arbitrary suffix returns `null` from both exports. No family substring
matching or expensive fallback is used. For example, `claude-opus-4-9` is
unverified, and the current pricing table does not provide a rate for
`claude-3-opus-20240229`; both remain unpriced. Add IDs only after verifying both
the ID and its applicable price.

## Current configuration

`AnthropicService.modelFor` defaults to `claude-opus-4-8` (`AI_MODEL_DEFAULT`),
`claude-sonnet-4-6` (`AI_MODEL_BALANCED`), and `claude-haiku-4-5-20251001`
(`AI_MODEL_LIGHT` and `AI_MODEL_CONVERSATION`). All three IDs and their prices
were verified. There is no unverified current service default.

`backend/.env.example` uses `claude-haiku-4-5` for the latter two variables.
The official Haiku page now explicitly documents that alias, although the
service's existing comments say it is not resolvable. Pricing support is not a
runtime availability check. Neither defaults, environment examples, nor service
comments are changed by this helper. Deployment-specific overrides still need
to match the allowlist.

## Estimation boundaries

- `inputTokens`, `outputTokens`, `cacheWriteTokens`, `cacheReadTokens`, and
  `webSearches` are the existing measured log fields. Cache counts are separate
  from uncached input. Optional missing counters contribute zero.
- [Prompt-cache pricing](https://platform.claude.com/docs/en/about-claude/pricing#prompt-caching)
  sets writes at 1.25 times input for five minutes and twice input for one hour;
  reads are 0.1 times input for the supported models. The log stores only aggregate
  cache writes, so **all writes are estimated at five-minute pricing**. One-hour
  or mixed-duration writes cannot be reconstructed and would be understated.
- [Web-search pricing](https://platform.claude.com/docs/en/about-claude/pricing#web-search-tool)
  adds $10 per 1,000 recorded searches to token costs. Search-content tokens are
  already in measured usage and are not counted again.
- This is a standard list-price snapshot applied to measured usage, not a
  historical billing ledger. No batch or long-context discounts are claimed;
  context premiums, fast mode, geography, negotiated rates, and taxes are not
  inferred from token totals.
- The helper does not round each call. Aggregation should preserve `null` as
  unavailable cost, rather than silently convert it to zero. Display rounding
  belongs after aggregation; monthly projections remain estimates and must
  disclose any usage whose model could not be priced.

## Dashboard accounting window

`GET /api/marketing/ai/usage-dashboard` is read-only and scoped to the
authenticated workspace, with the same MANAGER read floor as execution settings.
It aggregates the current calendar month in the workspace IANA timezone through
request time. Invalid legacy timezone values fall back to UTC. Daily buckets
include idle days. Neither this endpoint nor its price helper changes credit
billing, provider execution, or the older usage reports.

The token total includes all four measured token buckets. Calls count API log
rows plus completed media jobs, not business-level customer interactions. Entry
fees have no independent token usage unless directly logged; the corresponding
turn action carries the loop's measured calls. Per-request USD averages divide
known costs by priced calls, so missing prices do not dilute the average.

Media comes from retained `READY` generated assets and their recorded USD cost,
assigned to the asset creation date. Pending/failed estimates are excluded, and
the spend ledger is not added again. **Deleting an asset removes it from this
estimate**; the dashboard is not an immutable vendor billing ledger. MCP/client
usage, local hosting, external research vendors and STT/X charges are not
reconstructed from aggregate credit counters. Unknown prices remain visibly
unavailable, and any known cost subtotal is explicitly partial.

The forecast uses observed local calendar days since the later of month start
or workspace creation: actual usage + (actual / observed days) × remaining
calendar days. It requires 24 elapsed real hours and measured activity; the
eligibility check remains correct across daylight-saving transitions. If all
observed usage is unpriced, the cost forecast stays unavailable. Historical
rates do not predict the effect of unsaved or newly changed provider choices.
