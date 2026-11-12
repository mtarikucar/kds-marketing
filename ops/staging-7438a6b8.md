# Staging release 7438a6b8

Published to https://staging.jeetagrowth.com on 2026-11-12 at 06:58:23 UTC. This is a staging-only release.

- Source: `7438a6b8f6de6ce952836adcf95dfa0572511dcc` on `design/jeeta-refinement`.
- Complete application CI: https://github.com/mtarikucar/kds-marketing/actions/runs/43120011011 — all nine jobs passed.
- Publication: https://github.com/mtarikucar/kds-marketing/actions/runs/43171729653 — candidate checks and staging publication succeeded.
- Artifact ID: `13899794407`; archive SHA-256: `14dc654b5febe9e1fe2253e1f2d1403bfa9ea70850f25b5e2b65f5d859d90789`.
- Publication workflow revision: `a7b0a02c`; operator script SHA-256: `3011d15ab2290ee5d4458e988bc33cded608f1053d241d8b6d94030f86319de7`.
- Previous staging revision: `d66152a4f7834c73e524cf492fac2cfb7fa8ac56`; database schema advanced from 40 to 42.
- Protected recovery set: `/var/backups/jeeta-staging/release-operations/pre-7438a6b8-staging-20261112T065759Z-67JNu1`.

An ad campaign can now run on Google, LinkedIn, TikTok or X beside Meta. A campaign runs in one ad account, and the kind of that account decides the platform and what a plan carries: a search ad on Google (headlines, descriptions, keywords), a single-image sponsored post on LinkedIn under the ad account's own company page, a one-image carousel on TikTok under the TikTok account linked to the ad account, a promoted-only post with a website card on X under the ads account's own X user. Opening, planning, building, watching, stopping and the money are the same on every platform; everything is created switched off and then activated, with the campaign's whole budget as the platform's own total. The connections page offers the four new kinds of ad account, and the ads pages name the platform of each account and campaign.

Two things the panel says where they apply. LinkedIn asks a tool that sets an audience on its platform to show that its targeting may not be used to discriminate by personal characteristics: shown where a LinkedIn ad account is chosen and on a LinkedIn campaign's page. X does not say that a campaign's total budget is never exceeded: a running X campaign is read every fifteen minutes instead of every hour, Jeeta's own pause is what stops it at its budget, and the panel says so where an X ads account is chosen and on an X campaign's page.

Migrations 41 and 42 replace two CHECK constraints of `oauth_pending`, the table of sign-ins that have started and not finished: a pending sign-in may now name Google as its provider and its app (41), and TikTok's ads app, which is another app than the one TikTok accounts post through (42). They add, change or remove no table, column or row. Each has its `down`, which narrows the constraint again only when no pending row names the new value.

Before the service was stopped the operator script checked the candidate against its manifest, that staging ran the expected predecessor at schema 40 with the two constraints listing what schema 40 left them with, and that the environment file sets none of the six names this candidate starts to read (a half-configured platform app would stop the candidate at its first start, which is after the swap). It then backed up the database, the file store and the environment, restored the recovery copy on its own, and started the candidate against that copy with jobs off and outside networking blocked. On the restored copy it compared every table's row count and every column's name, type and nullability before and after the candidate's start, the migration checksums, and the names the two constraints list after migrations 41 and 42. After the swap it verified the installed artifact tree, readiness, schema 42 and the same two constraints on the published database. The serving binary is `/opt/jeeta/releases/7438a6b8f6de6ce952836adcf95dfa0572511dcc/jeeta`.

Validation after publication, from outside:

- All 35 published panel assets match the verified artifact; eight routes load the published page; readiness succeeds.
- Without a session the API answers 401, on the ad campaign and capability routes too, and the MCP endpoint answers 401.
- The production release pointer remains `095221a121801bbd807967c576fdb53046b3b23e`; the public index hashes of yeni.jeetagrowth.com and jeetagrowth.com match their values from before release 7891020b.

Report: [public integrity](staging-7438a6b8-public.json).

What this release does not show. Nothing was checked signed in on staging for this release. None of the four platforms' calls has been run against the platform: each adapter was written from the platform's own documentation and tested against an in-process mock, and its crate documentation lists what only a first real run can tell. Staging has no platform app for Google, for TikTok's ads or with the ad scopes of LinkedIn and X (the operator script refused an environment that sets any of them), so a sign-in for one of the four new kinds of ad account does not start here yet; registering those apps with each platform is the owner's step. The first real campaign on each platform is the owner's, on their own ad account, with a small budget and their explicit approval at that moment. TikTok's documentation says campaigns of this kind can no longer be created through its API after 31 December 2026 and that the kind replacing them takes no traffic objective: the owner must ask TikTok before that platform is relied on. No external message, post, ad or device action was performed during verification.
