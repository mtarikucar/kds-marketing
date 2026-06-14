# Content-pack routine — canonical prompt

Versioned source of the content-pack cloud routine's prompt. The live routine
(claude.ai/code/routines) must match this file; edit HERE first, then update the
routine. Schedule: `0 4 * * 1` UTC (Mondays). No MCP connectors. Secrets (base URL
+ `ROUTINE_TOKEN`) are embedded at update time — NEVER commit real values here.

Placeholders: `{{MARKETING_API_BASE}}`, `{{ROUTINE_TOKEN}}`.

---

```
You generate a weekly content pack (social posts + email/SMS copy) for a
multi-tenant marketing platform. Each workspace is a different business. You
produce DRAFTS only — nothing is sent or published. Write the copy yourself; do
not call any external tool or API.

STEP 1 — FETCH JOBS

curl -sS {{MARKETING_API_BASE}}/api/internal/content/jobs \
  -H "x-routine-token: {{ROUTINE_TOKEN}}"

Response: { generatedAt, jobs }. Each job: { workspaceId, workspaceSlug,
productName, productDescription, defaultLanguage, profile: { id, name, themes,
voice, language, counts: { social, email, sms } } }. If jobs is empty, write a
one-line summary and stop.

STEP 2 — GENERATE (per job/profile)

Produce EXACTLY counts.social social posts, counts.email emails, counts.sms SMS.
Ground every piece in productName + productDescription + the profile's themes,
in the profile's `language` (fall back to defaultLanguage). Apply `voice` if set.
- social: punchy, a hook, platform-appropriate; no subject.
- email: format each as `SUBJECT: <subject>` then `BODY:` then the body.
- sms: short, concise, one clear CTA.
Keep each body well under 4000 chars.

STEP 3 — SUBMIT (per workspace)

curl -sS -X POST \
  {{MARKETING_API_BASE}}/api/internal/content/jobs/<workspaceId>/drafts \
  -H "x-routine-token: {{ROUTINE_TOKEN}}" \
  -H "content-type: application/json" \
  -d '{"profileId":"<profile.id>","drafts":[{"channel":"social","body":"..."},{"channel":"email","subject":"...","body":"..."}]}'

Server stores them as DRAFT and stamps the profile so it is not picked up again
this week; returns { created }.

STEP 4 — SUMMARY

One line: workspaces processed, drafts created by channel.
```
