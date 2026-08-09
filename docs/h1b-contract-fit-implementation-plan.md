# H-1B Transfer / Contract-Fit Job Search Implementation Plan

**Status: SUPERSEDED.** This document still describes LinkedIn automation and a
browser extension. Matching lives in the completed AI matching guide; automated
apply lives in `docs/searchlight-automated-apply-implementation-plan.md`. Keep
this file only as historical context.

Status: implementation plan for the next job-search automation upgrade  
Project: `/home/shuvo/project/job_portal`  
Primary goal: stop treating discovered Indeed/Dice/LinkedIn links as apply-ready. Every job must first be enriched, matched against the candidate profile, and classified for H-1B transfer / contract likelihood before it can enter the apply queue.

## 1. Problem statement

The current browser discovery can find and save job links into the dashboard. That is useful but not sufficient because:

1. Many discovered jobs have generic placeholder labels such as `.NET Application Support discovered job — Remote`.
2. The dashboard needs the actual job title, company, location, description, employment type, and apply/source URL.
3. The user's real decision is not “is this a .NET job?” but:
   - Is this a strong match for .NET / C# / SQL / Oracle / application support experience?
   - Is it contract, contract-to-hire, W2 contract, C2C-friendly, recruiter/vendor sourced, or otherwise likely to support H-1B transfer?
   - Does it explicitly reject sponsorship, require citizenship, require clearance, or otherwise make application wasteful?
4. Applying to random links wastes time and can increase platform risk. The system should only place jobs into the apply queue when the evidence supports applying.

## 2. Product outcome

After implementation, the dashboard should show discovered jobs with these capabilities:

- Real source URL / apply URL visible and clickable.
- Real title/company/location when available from the job page or URL metadata.
- Fit score based on the user's target profile.
- Work-authorization and employment-type classification.
- Clear status/recommendation:
  - `ready_to_apply`: strong profile match and contract/H-1B-friendly signal is explicit or likely.
  - `needs_review`: strong enough role match, but sponsorship/contract evidence is uncertain.
  - `archived`: clear disqualifier or low profile fit.
- Human-readable explanation: why apply, why review, or why skip.

## 3. Operating principles

1. Discovery is not application.
   - Browser discovery only finds and checkpoints links.
   - No submit action happens during discovery or filtering.
2. One tab by default.
   - VPS/browser workflow must not open many tabs.
   - Use one page and reuse it slowly.
3. Conservative source behavior.
   - Human-like delay between job-detail pages.
   - Small batches first.
   - Save after each job or page.
4. Evidence-based classification.
   - Explicit negative language always wins.
   - Missing visa language is not automatically good.
   - Missing visa language can be “likely” only when combined with contract/vendor/recruiter signals.
5. Dashboard should explain decisions.
   - Do not silently change status without storing reason.
6. Local LLM / Codex boundary.
   - Deterministic rule scoring first.
   - Local LLM can later help extract ambiguous fields.
   - Codex should not be used for daily bulk discovery; reserve for top-job review/writing/debugging.

## 4. Current relevant code paths

### Worker discovery

- `worker/src/handlers/discoverJobsBrowser.ts`
  - Handles `discover_jobs_browser` command.
  - Opens local/CDP browser session.
  - Navigates search pages slowly.
  - Extracts job URLs from HTML.
  - Saves placeholder job records through `upsertJobs`.

- `worker/src/search/browserDiscovery.ts`
  - Builds Indeed/Dice/LinkedIn search URLs.
  - Extracts source-specific job URLs.
  - Normalizes URLs.
  - Builds placeholder `NormalizedJobInput` records.

### Worker rule filter

- `worker/src/handlers/runRuleFilter.ts`
  - Runs deterministic rule filter over jobs.
  - Writes fit score/status/reviews.

- `worker/src/rules/ruleEngine.ts`
  - Scores .NET/C#/SQL/support fit.
  - Detects remote/employment/salary.
  - Detects basic visa signals.
  - Needs stronger contract/H-1B decision model.

### Database boundary

- `worker/src/db.ts`
  - `upsertJobs` writes normalized jobs.
  - Unique conflict target is `jobs.sourceUrl`.

### Dashboard

- `src/app/(dashboard)/jobs/page.tsx`
  - Displays job title, company/location, source chip, fit, status/priority, source link icon.
  - Currently not showing detailed H-1B/contract explanation directly in the list.

- `src/app/(dashboard)/jobs/[id]/page.tsx`
  - Job detail page should expose richer extracted fields/reviews.

## 5. Data model strategy

Use existing columns first to avoid risky schema migrations:

- `jobs.title`: actual extracted title when available.
- `jobs.company`: actual extracted company when available.
- `jobs.location`: extracted location or search location fallback.
- `jobs.description`: extracted job description / summary text.
- `jobs.sourceUrl`: original job/apply URL.
- `jobs.employmentType`: detected value such as `contract`, `contract-to-hire`, `full-time`, `part-time`, `unknown`.
- `jobs.remoteType`: detected value such as `remote`, `hybrid`, `onsite`, `unknown`.
- `jobs.visaSignal`: detected value such as:
  - `h1b_transfer_explicit`
  - `sponsorship_available`
  - `contract_vendor_likely`
  - `unknown`
  - `no_sponsorship`
  - `citizen_only`
  - `clearance_required`
- `jobs.notes`: compact explanation / trace summary.
- `job_reviews`: store detailed rule-engine result JSON and explanation.

If later needed, add a normalized `job_fit_assessments` table, but not required for the first implementation.

## 6. Detail extraction design

Add a worker-side extraction module that can enrich each discovered job from its job-detail page.

Suggested file:

- `worker/src/search/jobDetailExtraction.ts`

Responsibilities:

1. Accept:
   - source (`indeed`, `dice`, `linkedin`)
   - job URL
   - current HTML/text
   - optional search query/location context
2. Return partial `NormalizedJobInput` fields:
   - title
   - company
   - location
   - description
   - employmentType
   - remoteType
   - salaryText
   - visaSignal initial hint
   - techStack hints
   - sourceUrl normalized
3. Use deterministic extraction first:
   - source-specific selectors/text patterns where available;
   - generic `<title>`, JSON-LD, meta description, visible text fallback;
   - URL query metadata fallback, especially Indeed `ti` and `cmp` parameters.
4. Keep extraction bounded:
   - do not spend long on each page;
   - no external LLM by default;
   - if extraction fails, preserve the URL and mark `needs_review` later.

### Indeed extraction approach

For Indeed, try in order:

1. URL metadata:
   - `ti` → title
   - `cmp` → company
   - `jk` → job key
2. Page HTML / text:
   - job title from common Indeed title selectors or visible heading.
   - company from company name area or page title fallback.
   - description from job description container.
3. Fallback:
   - current generic title from query/location.

### Dice extraction approach

For Dice, try:

1. JSON-LD `JobPosting` if present.
2. Page heading/title/company blocks.
3. Meta description fallback.

### LinkedIn extraction approach

LinkedIn is high-risk and currently restricted. Keep implementation prepared but do not run unless account is stable/manual-approved.

## 7. H-1B / contract fit model

Extend rule-engine logic from “generic fit score” to “apply eligibility decision.”

### Positive profile-fit signals

Add/weight these strongly:

- `.NET`, `ASP.NET`, `.NET Core`
- `C#`
- `SQL`, `SQL Server`, `T-SQL`
- `Oracle`, `PL/SQL`
- `application support`, `production support`, `support developer`, `systems analyst`
- `full-stack .NET`, Angular/React when paired with .NET
- `Azure`, IIS, REST API, Entity Framework
- support/troubleshooting/maintenance wording

### Positive H-1B/contract signals

Explicit/strong:

- `H-1B transfer`
- `visa sponsorship available`
- `will sponsor`
- `sponsorship considered`
- `W2 contract`
- `contract-to-hire`
- `contract`
- `C2C`
- `Corp-to-Corp`
- recruiter/vendor/staffing company indicators
- implementation partner / consulting company language

Likely-but-not-explicit:

- staffing vendor company/domain/name;
- job posted by recruiter or staffing agency;
- contract role with no negative sponsorship text;
- `W2` and `contract` terms together;
- role is in IT consulting/vendor ecosystem.

### Negative disqualifiers

Immediate or near-immediate skip:

- `US citizen only`
- `U.S. citizenship required`
- `green card only`
- `GC/USC only`
- `no sponsorship`
- `unable to sponsor`
- `cannot sponsor`
- `must be authorized to work without sponsorship`
- `clearance required`
- `active secret/top secret`
- public trust/citizenship combinations
- unrelated stack: Java-only, Python-only, DevOps-only, QA-only, Salesforce-only, embedded-only
- onsite-only too far from target geography

### Decision matrix

1. `ready_to_apply`
   - profile score high;
   - no disqualifying visa/citizenship/clearance language;
   - and at least one of:
     - explicit H-1B/sponsorship support;
     - contract / C2H / W2 contract / C2C signal;
     - staffing/vendor/recruiter source and no negative visa text.
2. `needs_review`
   - good profile score;
   - no negative visa language;
   - work type unclear or full-time with unknown sponsorship.
3. `archived`
   - low profile fit;
   - explicit no sponsorship/citizen-only/clearance;
   - unrelated tech stack.

## 8. Implementation phases

### Phase A — extraction helpers and tests

Files:

- `worker/src/search/jobDetailExtraction.ts`
- `worker/tests/jobDetailExtraction.test.ts`

Build pure functions:

- `stripHtmlToText(html: string): string`
- `extractJsonLdJobPosting(html: string): Partial<NormalizedJobInput>`
- `extractIndeedMetadata(url: string, html?: string): Partial<NormalizedJobInput>`
- `extractJobDetail(source, url, html, fallback): Partial<NormalizedJobInput>`

Tests:

- Indeed URL with `ti` and `cmp` extracts title/company.
- HTML encoded URL is decoded before parsing.
- JSON-LD `JobPosting` extracts title/company/location/description/employment type.
- Missing metadata falls back safely without throwing.

### Phase B — enrich during browser discovery

File:

- `worker/src/handlers/discoverJobsBrowser.ts`

Change behavior:

1. Search page still finds URLs.
2. For each found URL, reuse the same page and visit the job detail page slowly.
3. Extract title/company/description/location.
4. Upsert enriched jobs one-by-one or in small checkpoint batches.
5. Save command event per checkpoint.

Safety:

- one page/tab only;
- never submit forms;
- obey `maxRuntimeMinutes` and cancellation checks;
- if detail extraction fails for a URL, still save the URL with `needs_review`-friendly placeholder.

### Phase C — strengthen rule engine

File:

- `worker/src/rules/ruleEngine.ts`
- `worker/tests/ruleEngine.test.ts`

Add fields/concepts:

- `workAuthorizationFit`: `explicit_ok`, `likely_ok`, `unknown`, `negative`
- `employmentFit`: `contract`, `contract_to_hire`, `vendor_likely`, `full_time_unknown`, `bad`
- `applicationDecisionReason`: concise text summary.

If existing DB types do not support new fields directly, store these inside review result JSON and compact `notes`.

Tests:

- Contract .NET support job with no visa negative → `apply` or high `needs_review` depending score; prefer ready when vendor/contract signal exists.
- Full-time .NET role with unknown sponsorship → `needs_review`, not automatic apply.
- No sponsorship / USC only / clearance → `skip` even if stack matches.
- Java-only contract → low score / skip.
- Vendor/staffing + .NET + contract → `ready_to_apply`.

### Phase D — dashboard visibility

Files likely:

- `src/app/(dashboard)/jobs/page.tsx`
- `src/app/(dashboard)/jobs/[id]/page.tsx`

Improve display:

- Jobs list should show not only title/company but also:
  - source link button label like `Open Indeed job`;
  - employment type;
  - visa/work-auth signal;
  - last review recommendation/reason if available.
- Detail page should show:
  - source URL text/copy/open button;
  - extracted description;
  - rule review strengths/gaps;
  - visa notes and contract notes.

### Phase E — operations / runbook

Update:

- `worker/README.md`
- optional dashboard help copy.

Document the safe run:

```json
{
  "sources": ["indeed"],
  "queries": [".NET Application Support", ".NET Developer"],
  "locations": ["Remote", "New York", "Albany NY"],
  "maxResults": 5,
  "sourceLimits": { "indeed": 5 },
  "maxPagesPerSearch": 1,
  "maxRuntimeMinutes": 10,
  "minDelayMs": 15000,
  "maxDelayMs": 45000,
  "dryRun": false
}
```

Then run:

1. `discover_jobs_browser`
2. `run_rule_filter`
3. Review `ready_to_apply` and `needs_review` jobs in dashboard.
4. Use the guarded local worker apply flow only after approval; the legacy browser extension path is retired.

## 9. Verification plan

Run locally:

```bash
npm run worker:typecheck
npm run worker:test
npm run lint
npm run typecheck
```

Operational smoke test:

1. Keep worker running with `WORKER_POLL_INTERVAL_SECONDS=30`.
2. Queue a small Indeed-only `discover_jobs_browser` command.
3. Confirm:
   - command is claimed within about 30 seconds;
   - command completes or gracefully fails;
   - saved jobs have unique source URLs;
   - at least some jobs have real title/company/description;
   - no apply/submit action occurred.
4. Queue `run_rule_filter`.
5. Confirm:
   - explicit negative jobs are skipped;
   - unknown full-time jobs are not blindly apply-ready;
   - contract/vendor likely jobs can become ready-to-apply;
   - dashboard displays reason.

## 10. Rollback strategy

- If enrichment causes navigation issues, disable/enclose detail extraction behind payload/config flag such as `enrichDetails: false`.
- Preserve the old discovery behavior: still save source URLs even if extraction fails.
- Do not change schema in the first iteration unless absolutely necessary.
- Keep all changes covered by tests before restarting the worker.

## 11. Acceptance criteria

The feature is acceptable when:

1. The dashboard shows the actual source URL for every discovered job.
2. Discovered jobs do not all look identical when title/company metadata is available.
3. The rule filter does not mark full-time unknown-sponsorship jobs as automatically apply-ready just because they mention .NET.
4. Contract/vendor/staffing + .NET/support jobs are elevated.
5. No-sponsorship/citizenship/clearance jobs are skipped.
6. The worker uses one page/tab and remains safe for a 4GB VPS.
7. Tests and typechecks pass.
8. The worker is restarted and health check passes after implementation.

## 12. Immediate implementation scope

For the first implementation pass, focus on:

1. Source URL correctness.
2. Indeed title/company extraction from URL metadata and simple page/JSON-LD extraction.
3. Stronger H-1B/contract decision logic in rule engine.
4. Tests proving the new decision matrix.
5. Dashboard still usable with existing DB shape.

Defer advanced local LLM extraction and Codex review of top jobs until deterministic extraction/scoring is working.
