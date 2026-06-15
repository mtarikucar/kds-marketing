# Epic E — Funnel A/B + Survey builder — design

**Date:** 2026-06-16 · autonomous (no-ask) · independent off main

## Goal
A/B (split) testing for funnel/site pages + a survey builder. Both **additive** —
no change to the existing `SitesService`/`FormsService`/render path.

- **Experiments** — `Experiment` (variants JSON + status) + `ExperimentEvent`
  (IMPRESSION/CONVERSION). Weighted-random variant selection; results aggregate
  impressions/conversions/rate per variant. Management `/marketing/experiments`;
  public `GET /public/exp/:id/variant` (pick+impression), `POST /public/exp/:id/convert`.
- **Surveys** — `Survey` (questions JSON) + `SurveyResponse`. Management
  `/marketing/surveys`; public `POST /public/survey/:id/submit` (PUBLISHED only).

Public endpoints look up by unguessable id (same pattern as public form submits).

## Non-goals
- Auto-swapping page blocks at render time (the render path can call
  `selectVariant`; left as a thin hook). Multivariate, bandit allocation, AI-pick.

## Testing
Unit: variant ≥2 guard, weighted select + impression, conversion, results agg;
survey create + published-submit + 404. E2E: experiment create/start, public
variant+convert, survey create+submit. Full suite green (636 unit + 58 e2e).
