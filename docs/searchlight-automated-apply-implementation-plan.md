# Searchlight — Automated Apply Pipeline

**Implementation contract. Stages 1–10. Stage 0 is already complete — do not redo it.**

---

## 0. How to work on this

Read this whole document before writing code. Then implement **one stage at a time**, in order, keeping the repository green after every stage.

**Toolchain — this repo uses `npm`, not Bun, not pnpm, not yarn.** There is a `package-lock.json`. Do not run `bun install` or `pnpm install`; it will produce a second lockfile and a different dependency tree. A global instruction elsewhere may tell you to prefer Bun — it does not apply to this repository.

**This is not the Next.js you may know.** Version 16.2.11, React 19. Auth middleware lives in `src/proxy.ts`, **not** `middleware.ts`. Read the relevant guides under `node_modules/next/dist/docs/` before writing route handlers, server actions, or anything touching the App Router. Heed deprecation notices there over your priors.

**After every stage, all five must pass:**

```bash
npm run typecheck
npm run lint
npm run worker:typecheck
npm run worker:test
npm run build
```

Baseline at the start of Stage 1: all five green, 40/40 worker tests passing.

**Do not, at any point, without explicit human approval:**
- run `npm run db:migrate` against production
- commit or push
- deploy to Vercel
- restart or reconfigure the VPS worker
- set `JOB_APPLY_ENABLED=true` or raise `JOB_APPLY_MODE` above `dry_run`

Generate migrations, write code, run tests. Stop and ask before anything that touches a live system.

**Prefer additive migrations and verified backfill over destructive cleanup.** Nothing gets dropped until Stage 10.

---

## 1. What already exists

Searchlight discovers Indeed/Dice jobs, matches them against the candidate profile with local Ollama, and sets `jobs.status = 'ready_to_apply'` on the winners. That pipeline works and is the foundation. **Do not rewrite the matching evidence schema, `hardFilter`, or `matchPolicy`.**

Everything after matching is greenfield. `applications` has **no write path anywhere in the codebase** except `scripts/seed.ts`.

### Topology

```
Next.js on Vercel   — Clerk dashboard, role/resume management, Blob upload
                      token route, Telegram webhook, read APIs
Neon Postgres       — source of truth, command queue with FOR UPDATE SKIP LOCKED
VPS worker          — discovery and extraction. NEVER submits applications.
Mac worker          — resume text extraction, Ollama matching, Playwright apply
```

### Stage 0 — COMPLETE, do not repeat

Already done and verified green:

- **Created** `worker/src/browser/playwrightTypes.ts` — structural types for the dynamically imported Playwright module: `LocatorLike`, `FrameLike`, `PageLike`, `TracingLike`, `BrowserContextLike`, `BrowserLike`, `PlaywrightModule`. Use these. Do not hand-roll new Playwright types anywhere else; extend this file if you need another method.
- **Created** `worker/src/browser/session.ts` — exports `loadPlaywright()`, `openBrowserSession(playwright, cfg)`, and the `BrowserSession` type. Handles both `connectOverCDP` and `launchPersistentContext`. **Reuse this for the apply runner. Do not write a second session opener.**
- **Modified** `worker/src/handlers/discoverJobsBrowser.ts` to import both; deleted its inline types and its local copies of those two functions.

Playwright `^1.62` is already a root devDependency. `worker/tsconfig.json` already has `lib: ["ES2022", "DOM"]`, so page-side code typechecks without config changes.

---

## 2. Product goal

The user defines **target roles** — a job title, its locations, and the resume that belongs to that title. Searchlight discovers jobs per role, matches each job against *that role's resume*, applies with that resume, and messages the user on Telegram when it hits a question it cannot answer. The user answers once; the system never asks that question again. The dashboard is the command center.

The user should never have to think about Vercel, Neon, Blob, which worker is running, or Chrome. One product.

```
target_roles (title + locations + resume + active + daily cap)
    │
    └─ launchd one-shot, weekdays 09:15 / 14:15
         └─ run_apply_cycle ──► discover per role ──► one job_role_match per (job, role)
              (re-entrant,      (VPS worker)          matched vs THAT ROLE'S resume text
               phase-based)                           (Mac worker, Ollama)
                                                             │
                                          best eligible pair per job → apply queue
                                                             │
              run_apply_cycle phase="apply" ──────► apply_to_jobs (Mac worker only)
                                                             │
                             ┌───────────────────────────────┤
                             │                               │
                      all fields resolved            something unresolved
                             │                               │
                   draft→filling→submitting            → awaiting_answer
                             │                         notify Telegram, close
                    confirmed? applied                       │
                    unclear?   submission_unknown       user taps / replies
                               (never auto-retry)            │
                                              Vercel /api/telegram/webhook
                                                             │
                                       learnAnswer() → application_answers
                                       + enqueue apply_to_jobs retry
                                                             │
                                               next poll (~10s) → applied
```

### Why the run aborts instead of waiting

Holding a logged-in Indeed smartapply session open while the user answers is a bet on session longevity that loses. The run saves the question and exits cleanly. When the answer arrives, the webhook banks it and **enqueues a fresh apply for that job**, which the worker picks up within one poll interval. The user experiences "it waited and resumed"; nothing fragile is actually held open, and it works even if the Mac was asleep.

---

## 3. Non-negotiables

These are correctness and safety properties, not preferences. Do not simplify them.

1. **One application per `(user_id, job_id)`.** Enforced by a unique index, not by application code.
2. **`submitting` is written to Postgres and awaited *before* Playwright clicks the final button.** If confirmation is unclear afterward — crash, timeout, ambiguous page — the state becomes `submission_unknown`, never `failed`.
3. **Nothing auto-retries out of `submitting` or `submission_unknown`.** Resolution is a human dashboard action or an explicit verification pass. Retrying means double-submitting to a real employer.
4. **Never infer sponsorship, work authorization, salary, EEO, or legal/background answers.** These require an exact saved answer or an ask. No Ollama, no heuristic, no confidence threshold that can override this.
5. **Never bypass CAPTCHAs, bot challenges, or account locks.** Detect, stop the whole command, report `blocked`.
6. **Never submit from the VPS worker.** `apply_to_jobs` goes in the Mac env file's `WORKER_COMMAND_TYPES` only.
7. **Config is a ceiling.** `effectiveMode = min(payloadMode, JOB_APPLY_MODE)` by ordinal, so a payload can only ever be more conservative than config.
8. **Resume files are private.** No public URLs, no reusable signed URLs persisted in Neon, hash-verified on download.
9. **Uncertain matches never auto-apply.** Only the existing deterministic policy's `match` verdict is apply-eligible.
10. **The user accepts the ToS risk** of browser-based automated submission. Keep that warning visible in settings. This does not license bypassing anti-bot measures — see 5.

---

## 4. Repo landmines — read before writing any code

Every one of these has already caused or will cause a real bug. None are obvious from reading the code casually.

**Neon's HTTP driver has no interactive transactions.** `db.transaction` does not exist here. Every multi-row write must be `db.batch([...])` and each statement individually idempotent. You will instinctively reach for a transaction; it is not available.

**`drizzle-kit generate` will collide with an applied migration.** `drizzle/meta/_journal.json` has two entries, but the entry at `idx: 1` is *tagged* `0002_ai_profile_job_matching`. Generate derives the next filename prefix from `entries.length` = 2, so it emits `0002_*.sql` — colliding with a file already applied to the database. This already orphaned `drizzle/0001_add_browser_discovery_command.sql`, which the migrator will never run. Handling recipe is in Stage 1.

**`assertNoExecutionKeys`** (`src/lib/validation.ts`) recursively rejects payload keys matching `/^(cmd|command|shell|script|executable|argv)$/i`. Do not name a payload field `command` or `script`. `parentCommandId` is safe — the regex is anchored.

**`createWorkerChildCommand`** (`worker/src/db.ts`) is hard-typed to `type: "run_local_llm_extraction"` and **bypasses `validateCommandPayload` entirely**. Only `createCommand` in `src/services/commands.ts` validates. Widen the type union; understand that the handler's own Zod schema is then the only gate.

**`commands.requestedBy` is not always a user UUID.** It holds `users.id` for dashboard-created commands and the literal string `"hermes"` otherwise. This plan uses `user_id` foreign keys throughout, so validate `requestedBy` is a real UUID at handler entry or you will hit an FK violation deep inside a live browser run.

**`prepareManagedCdpBrowser`** (`worker/src/search/cdpBrowser.ts`) **closes every other page target** when `JOB_BROWSER_CDP_MANAGE_PAGES=true`. Never point CDP at a daily-driver Chrome — use a dedicated profile on a dedicated port. It is loopback-guarded, which prevents remote damage but not local.

**`findReusableMatchReview`** (`worker/src/db.ts`) caches reviews on `profileFingerprint` + `jobFingerprint`. Once resume text enters the matching context, the resume must be part of that fingerprint or you will serve a cached review computed against a different resume.

**`upsertJobs`** deliberately omits `status`, `fitScore`, `priority`, `visaSignal`, `techStack`, and `notes` from its `onConflictDoUpdate` set, so re-discovery does not clobber pipeline state. Preserve that.

**`jobs` has no `user_id`.** It is global. Never store per-user or per-role state on it.

**Worker tests are `node:test` via `tsx --test worker/tests/*.test.ts`, not vitest.** Write worker tests in that style: `import test from "node:test"; import assert from "node:assert/strict";`.

---

## 5. Port manifest — copy, do not rewrite

`/Users/shuvomahamud/Projects/BroswerExtension` is a **donor repository**, not a component. Nothing is installed in Chrome. It contains roughly 750 lines of tested TypeScript with **zero `chrome.*` and zero DOM references** that solve field classification and answer matching. Its tests pass in plain Node.

**Do not write your own field classifier, question normalizer, answer matcher, or risk policy.** Copy these four byte-identical into `worker/src/formfill/`, adding only a one-line provenance comment at the top:

| From donor repo | To this repo |
|---|---|
| `src/lib/fieldClassifier.ts` | `worker/src/formfill/fieldClassifier.ts` |
| `src/lib/questionNormalizer.ts` | `worker/src/formfill/questionNormalizer.ts` |
| `src/lib/answerMatcher.ts` | `worker/src/formfill/answerMatcher.ts` |
| `src/lib/riskPolicy.ts` | `worker/src/formfill/riskPolicy.ts` |

What they give you: `classifyField()` with 45 ordered rules over 39 field categories; `normalizeQuestion()` / `questionSimilarity()` with C#→csharp, .NET→dotnet, visa/H1B→sponsorship canonicalisation; `matchSavedAnswer()` with a tuned confidence cascade (exact 0.99 → normalized 0.96 → alias 0.95 → sole-category 0.93/0.78 → Jaccard ≥0.55 with a 0.12 margin); and `getRiskLevel()` / `categoryAlwaysRequiresReview()`.

**Copy with deletions:**
- `src/types/index.ts` → `worker/src/formfill/types.ts`. Drop `RuntimeRequest`, `RuntimeResponse`, `TabSession`, `ApplicationStep`, `AuditEntry`, `ImportPayload`, `OLLAMA_MODELS`, `FillMode`. Rename `ExtensionSettings` to `MatchSettings` — consumers take it structurally, so a narrowed object satisfies them.
- `src/lib/schemas.ts` → `worker/src/formfill/schemas.ts`. Drop `extensionSettingsSchema`, `knownModelSchema`, `importPayloadSchema`. **Add `fieldBaseSchema` and `detectedFieldSchema`** — the donor repo has no schema for `DetectedField`, and `frame.evaluate` output crosses a trust boundary that must be parsed.

**Re-implement — mine the source for logic, do not copy the file:**
- `src/content/formDetector.ts` + `labelExtractor.ts` → `worker/src/formfill/domDetector.ts`
- `serviceWorker.optionMatches` + `fieldFiller.bestOption` → `worker/src/formfill/optionMatching.ts`
- `serviceWorker.enhanceFieldsWithOllama` + `buildSuggestion` → `worker/src/formfill/suggestions.ts`, using the **worker's** `/api/chat` + `format:<jsonSchema>` pattern from `OllamaJobMatchProvider`, not the donor's `/api/generate`
- `src/lib/storage.ts` + `answerVault.ts` → `worker/src/formfill/answerBank.ts`, Postgres-backed

**Do not port:** `auditLog.ts`, `importExport.ts` (`command_events` and `application_answers` already cover audit and export), `domHighlighter.ts`, `contentScript.ts`, `mutationObserver.ts`, all of `src/ui/**`, and `serviceWorker.ts` as a file.

Convert the four pure test suites to `node:test`. The three jsdom suites (`formDetector`, `labelExtractor`, `fieldFiller`) cannot come across — jsdom is not a dependency here. They are replaced by real Playwright fixture tests in Stage 5.

---

## Stage 1 — Schema

Additive only. Nothing is dropped until Stage 10.

### The migration recipe — follow exactly

1. Edit `src/db/schema.ts`.
2. Run `npm run db:generate`.
3. It will emit `drizzle/0002_<random>.sql` and `drizzle/meta/0002_snapshot.json`, colliding in prefix with the already-applied `0002_ai_profile_job_matching.sql`.
4. **Rename only the `.sql`** to `drizzle/0003_apply_pipeline.sql`, and set the new journal entry's `tag` to `"0003_apply_pipeline"`. **Leave `idx: 2` alone. Leave `0002_snapshot.json` named as it is.** The migrator resolves files by `tag`; generate resolves snapshots by numeric idx. This keeps both happy.
5. Hand-append anything generate missed: the `ALTER TYPE` values, the dedupe `DELETE`, the unique index.
6. **Verify the journal actually gained a third entry** before migrating:
   ```bash
   python3 -c "import json;print(len(json.load(open('drizzle/meta/_journal.json'))['entries']))"
   ```
   It must print `3`. If it prints `2`, the migration is orphaned and will never run.
7. Leave `drizzle/0001_add_browser_discovery_command.sql` alone. It is already applied in substance via `0002`.

### New enum values

Each on its own line with `--> statement-breakpoint`, matching the style of `0002_ai_profile_job_matching.sql:1-2`. **No statement in this migration may reference a value added in this migration** — Postgres will not see it yet.

```sql
ALTER TYPE "public"."command_type" ADD VALUE IF NOT EXISTS 'run_apply_cycle';
ALTER TYPE "public"."command_type" ADD VALUE IF NOT EXISTS 'apply_to_jobs';
ALTER TYPE "public"."command_type" ADD VALUE IF NOT EXISTS 'sync_resume_text';
ALTER TYPE "public"."application_status" ADD VALUE IF NOT EXISTS 'filling';
ALTER TYPE "public"."application_status" ADD VALUE IF NOT EXISTS 'awaiting_answer';
ALTER TYPE "public"."application_status" ADD VALUE IF NOT EXISTS 'submitting';
ALTER TYPE "public"."application_status" ADD VALUE IF NOT EXISTS 'submission_unknown';
ALTER TYPE "public"."application_status" ADD VALUE IF NOT EXISTS 'needs_manual';
ALTER TYPE "public"."application_status" ADD VALUE IF NOT EXISTS 'blocked';
ALTER TYPE "public"."application_status" ADD VALUE IF NOT EXISTS 'failed';
```

Existing `screening` / `interview` / `offer` / `rejected` / `withdrawn` stay — they are the human lifecycle *after* `applied`. One enum, one lifecycle.

### `target_roles` — the single configuration surface

```
id uuid pk | user_id → users CASCADE
title text NOT NULL                            -- "Senior .NET Developer"
locations text[] NOT NULL DEFAULT '{}'
resume_version_id → resume_versions RESTRICT NOT NULL
active boolean NOT NULL DEFAULT true
max_applications_per_day integer               -- nullable, per-role throttle
notes text, created_at, updated_at
UNIQUE (user_id, title) | INDEX (user_id, active)
```

`RESTRICT` is deliberate. Deleting a resume that a live role depends on must fail loudly rather than null out and silently fall back to the wrong resume.

### `resume_versions` — immutable, Blob-backed

Replace the `storage_path` concept entirely.

```
id uuid pk | user_id → users CASCADE
name text NOT NULL                             -- human label
blob_pathname text NOT NULL                    -- private Blob object key
original_filename, mime_type, size_bytes, sha256 text NOT NULL
resume_text text, resume_text_chars integer
text_extracted_at timestamptz, extraction_error text
superseded_by uuid → resume_versions SET NULL
created_at
INDEX (user_id) | UNIQUE (user_id, sha256)
```

**Never UPDATE the file columns.** Re-uploading creates a new row and sets `superseded_by` on the old one; `target_roles.resume_version_id` is repointed. Old rows persist so historical `applications` remain truthful about what was actually sent. PDF and DOCX only, 5 MB cap. Never persist a reusable signed download URL.

Existing rows have a `storage_path` and no Blob object. Mark them as requiring re-upload; do not attempt to migrate their bytes.

### `job_role_matches` — per-user, per-role matching state

```
id uuid pk | user_id → users CASCADE
job_id → jobs CASCADE | target_role_id → target_roles CASCADE
resume_version_id → resume_versions RESTRICT   -- what was matched against
status text NOT NULL                            -- match | uncertain | reject
score integer, evidence_json jsonb, reasons text[]
candidate_fingerprint text, job_fingerprint text
created_at, updated_at
UNIQUE (user_id, job_id, target_role_id)
INDEX (user_id, status, score DESC)
```

This table — not `jobs` — decides which resume applies. Global URL dedupe via `jobs.source_url` is unchanged.

### `application_answers` — the learned bank

```
id uuid pk | user_id → users CASCADE
scope text NOT NULL DEFAULT 'global'      -- global | company | job
scope_key text NOT NULL DEFAULT ''        -- '' | lower(company) | job uuid
normalized_question text NOT NULL, original_question text NOT NULL
category text NOT NULL
answer_value text NOT NULL, answer_type text NOT NULL, option_value text
site_pattern text DEFAULT '', domain text DEFAULT ''
aliases text[] NOT NULL DEFAULT '{}'
risk_level text NOT NULL DEFAULT 'MEDIUM'
source text NOT NULL DEFAULT 'user_reply' -- user_reply | dashboard | profile | import
usage_count integer NOT NULL DEFAULT 0, last_used_at timestamptz
notes text DEFAULT '', created_at, updated_at
UNIQUE (user_id, scope, scope_key, normalized_question, category)
INDEX (user_id, category) | INDEX (user_id, scope, scope_key)
```

**Do not extend `common_answers` instead.** It is `UNIQUE(user_id, question_key)` with keys matching `/^[a-z0-9_]+$/`, so "How many years of C#?" and "Years of C# in production?" both collapse to `years_csharp` and silently overwrite each other. It also lacks `aliases`, `answer_type`, `option_value`, `risk_level`, `usage_count`, and `domain`. Keep `common_answers` as-is and bridge it at read time (Stage 6) — zero data migration, and hand-curated answers work from day one.

### `pending_questions` — durable question state

```
id uuid pk | short_id text NOT NULL UNIQUE   -- 8 chars: Telegram callback_data + typing
command_id → commands CASCADE | job_id → jobs CASCADE
application_id → applications SET NULL | user_id → users CASCADE
field_id text, field_selector text
question_text text NOT NULL, normalized_question text NOT NULL
category text NOT NULL, answer_type text NOT NULL
options_json jsonb NOT NULL DEFAULT '[]'
required boolean NOT NULL DEFAULT false
risk_level text NOT NULL DEFAULT 'HIGH'
status text NOT NULL DEFAULT 'open'          -- open|answered|expired|canceled|superseded
channel text NOT NULL DEFAULT 'dashboard', channel_message_id text
answer_value text, answered_by text, answered_at timestamptz
context_json jsonb NOT NULL DEFAULT '{}'     -- {applyUrl, stepIndex, screenshotPath}
expires_at timestamptz NOT NULL, created_at, updated_at
INDEX (user_id, status) | INDEX (command_id)
```

`scope`, `status`, `channel`, `category`, `risk_level`, and `answer_type` are **`text`, not `pgEnum`**, validated by Zod at the write boundary — the same choice `command_events.event_type` already makes. The 39-value `FIELD_CATEGORIES` list will grow, and `ALTER TYPE` is exactly the migration pain described above.

### Changed columns

- `applications`: `target_role_id`, `job_role_match_id`, `resume_version_id`, `apply_url`, `stop_reason`, `confirmation_evidence jsonb`, `submitted_at`
- `commands`: `heartbeat_at timestamptz`
- `candidate_profile`: `first_name`, `last_name`, `phone`, `address_line1`, `address_line2`, `city`, `state_region`, `postal_code`, `country` (default `'United States'`), `current_company`, `current_title`, `years_total_experience integer`

### Idempotency index — hand-write this, generate will not

```sql
DELETE FROM "applications" a USING "applications" b
  WHERE a."job_id" = b."job_id" AND a."user_id" = b."user_id" AND a."ctid" > b."ctid";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "applications_job_user_unique"
  ON "applications" ("job_id","user_id");
```

### Recovery predicate

In `recoverStaleClaims` (`worker/src/db.ts:87`), change the predicate to:

```sql
WHERE status = 'claimed'
  AND COALESCE(heartbeat_at, claimed_at) < NOW() - (${maxClaimAgeMinutes} || ' minutes')::interval
```

**Done when:** a scratch Neon branch migrates cleanly; the journal has three entries; a duplicate `(job_id, user_id)` insert is rejected; deleting a resume bound to an active role fails; and the existing matching workflow still runs green against the new schema.

---

## Stage 2 — Command types + claim heartbeat

The command-type allow-list is enforced in four places, and `satisfies` compile-forces three of them:

- `src/db/schema.ts` — `commandTypeEnum` (done in Stage 1)
- `src/lib/constants.ts` — `COMMAND_TYPES`, plus `APPLICATION_STATUSES`
- `src/lib/validation.ts` — `commandPayloadSchemas`, one `.strict()` object per new type
- `worker/src/types.ts` — the `CommandType` union

Nothing else references command types. The API routes and `src/services/commands.ts` are generic and need no changes.

### Why the heartbeat is mandatory

An `apply_to_jobs` command processing five jobs can exceed the 60-minute `recoverStaleClaims` window. That sweep runs every 15 minutes from **every** worker instance, including the VPS one, against the shared queue. If the claim is recovered mid-run, a second worker will re-apply to the same jobs. With real submissions, this is the worst bug in the system.

**Modify** `worker/src/db.ts`:

```ts
export async function heartbeatCommand(commandId: string, workerId: string): Promise<boolean>;
// UPDATE commands SET heartbeat_at = NOW(), updated_at = NOW()
//   WHERE id = $1 AND claimed_by = $2 AND status = 'claimed' RETURNING id
// Returns false when the claim was lost, stolen, or the command was canceled.
```

Also widen `createWorkerChildCommand`'s hard-coded `type: "run_local_llm_extraction"` to a `WorkerSpawnableCommandType` union, add an optional `scheduledFor?: Date`, and derive the second `command_events` insert's `eventType` from `input.type` rather than the hardcoded `"matching_queued"` at line 238.

**Create** `worker/src/claimHeartbeat.ts`:

```ts
export type ClaimGuard = { readonly lost: boolean; readonly reason: string | null };
export async function withClaimHeartbeat<T>(
  command: DashboardCommand,
  intervalMs: number,
  run: (guard: ClaimGuard) => Promise<T>,
): Promise<T>;
```

Use `setInterval(...).unref()` so SIGTERM is not blocked, and `clearInterval` in a `finally`. When `heartbeatCommand` returns false, flip `guard.lost`; handlers check it at their existing `shouldStop` checkpoints.

**Modify** `worker/src/runner.ts` — wrap the `dispatchCommand(command)` call at line 26. One call site covers every command type, including today's 30-minute discovery runs.

**Config:** add `WORKER_HEARTBEAT_INTERVAL_SECONDS: intFromEnv(120, 30, 600)` with a load-time assertion that `interval * 4 < 3600`. If the interval ever exceeds the recovery window you get a silently double-executed apply.

Also validate at handler entry that `commands.requestedBy` is a UUID before using it as `applications.user_id`.

**Done when:** a harness backdates `claimed_at` by 70 minutes with a fresh `heartbeat_at`, and a concurrent `recoverStaleClaims(60)` leaves the command claimed. Cancelling mid-run flips the guard within one interval.

---

## Stage 3 — Target roles, Blob upload, resume text

This stage makes the system configurable and visible before any apply code exists.

### Upload path

- **Create** `src/app/api/resumes/upload-token/route.ts` — Node runtime. Derives the user from Clerk. Restricts MIME to PDF/DOCX and size to 5 MB. Adds a random path suffix. **Never trust a `userId` from the request body.** Returns an authenticated client-upload token for private Vercel Blob.
- **Create** the upload completion callback. Persists `blob_pathname`, `original_filename`, `mime_type`, `size_bytes`, and `sha256` to a **new** `resume_versions` row owned by that Clerk user.
- **Create** `src/app/api/worker/resume-download/route.ts` — guarded by `requireScopedSecret(request, "WORKER_API_SECRET")`, the same pattern the existing worker routes use. Takes one `resume_version_id`, returns a short-lived single-object download URL. Never persist that URL.

### Mac-side materialisation

**Create** `worker/src/resume/materialize.ts`:

```ts
export async function materializeResume(versionId: string):
  Promise<{ absolutePath: string; sha256: string }>;
// cache hit at ~/.job-portal/resumes/<versionId>.<ext> → verify sha256 → return
// miss → request short-lived URL → download to temp → verify sha256 → move into cache
// hash mismatch → throw loudly, never use the file
```

Versions are immutable, so the cache never needs invalidating.

**Create** `worker/src/resume/extractText.ts`:

```ts
export async function extractResumeText(absolutePath: string):
  Promise<{ text: string; chars: number; kind: "pdf" | "docx" }>;
```

`pdf-parse` for PDF, `mammoth` for DOCX. **Worker dependencies only — these must never enter the Next.js bundle.** Normalise whitespace, strip control characters, cap at 40 000 characters.

**Create** `worker/src/handlers/syncResumeText.ts` — payload `{ resumeVersionIds?: uuid[] }`, defaulting to every version with a null `text_extracted_at`. Writes `resume_text`, `resume_text_chars`, `text_extracted_at`, and on failure `extraction_error` with the reason. **Never fail the whole command because one file is bad.**

### Extraction quality guard

Auto-extraction silently mangles multi-column and scanned PDFs, and the failure mode is bad matching with no visible cause. Surface `resume_text_chars` on the roles page and flag anything under 800 characters or carrying an `extraction_error`. **A role whose resume is unhealthy cannot be activated.**

### UI

- **Create** `src/app/(dashboard)/roles/page.tsx` and its server actions — create, edit, activate, deactivate. Fields: title, locations, resume upload, per-role daily cap, notes. Shows extraction health and a "Re-extract" button that queues `sync_resume_text`.
- **Modify** `src/app/(dashboard)/profile/page.tsx` — add a "Contact & identity" fieldset for the twelve new `candidate_profile` columns. Remove the free-text resume path input.
- **Modify** `src/app/(dashboard)/actions.ts` — extend `saveCandidateProfile`'s Zod schema and its `parse()` call; add role CRUD actions.
- **Modify** `src/components/sidebar.tsx` and `src/proxy.ts` for the new route.
- **Create** `worker/src/apply/profileGuard.ts` — `assertApplyProfileComplete(profile)`, mirroring the existing `isMatchingProfileComplete` in `worker/src/ai/profileContext.ts`. Refuses to start without first/last name, phone, city, state, postal code, and country.

Reuse the existing design language: `PageHeader`, `SectionHeading`, `MetricCard`, `StatusBadge`, `EmptyState` from `src/components/ui.tsx`, and `formatDate` / `formatDateTime` / `humanize` from `src/lib/format.ts`.

**Done when:** two roles with two different uploaded resumes both produce plausible extracted text, and a deliberately scanned PDF trips the guard and blocks activation.

---

## Stage 4 — Role-scoped discovery and matching

- **Modify** `worker/src/handlers/findMatchingJobs.ts` and `runLocalLlmExtraction.ts` — run per active role, writing one `job_role_matches` row per `(job, role)` pair instead of mutating `jobs`.
- **Modify** `worker/src/ai/profileContext.ts` — `buildCandidateMatchingContext` gains `roleTitle: string` and `resumeText: string` (truncate to ~20 000 chars). It currently excludes resumes entirely and matches on `candidate_profile.summary`.
- **Modify** `findReusableMatchReview` in `worker/src/db.ts` — fold `resume_version_id` and the resume fingerprint into the cache key. Without this you will serve a review computed against a different resume.
- **Do not touch** the evidence schema (`matchSchema.ts`), `hardFilter.ts`, `matchPolicy.ts`, or `prompt.ts`. Keep the prompt's injection hardening: candidate and job text remain untrusted data.
- A pair is apply-eligible only when the existing deterministic policy returns `match` — currently score ≥ 75 plus every safety condition. **Uncertain never auto-applies.**
- **Selection:** for a job with several eligible pairs, order by `score DESC` and take the top one. Its `resume_version_id` is the resume that applies. Never "first role wins".

`fingerprintCandidate` will change, which correctly invalidates cached `job_reviews`. Re-matching after a resume edit is desired behaviour, not a regression.

**Done when:** one job discovered under two roles produces two `job_role_matches` rows, and the higher-scoring one deterministically supplies the resume.

---

## Stage 5 — Form detection over Playwright

**Create** `worker/src/formfill/domDetector.ts`:

```ts
export type FieldBase = Omit<DetectedField, "fieldCategory" | "riskLevel" | "confidence">;

/** Serialised into the page by frame.evaluate.
 *  MUST have zero imports and zero closure captures — the function body is
 *  stringified and nothing from module scope survives the boundary. */
export function detectFieldBasesInPage(): FieldBase[];

export async function detectFields(frame: FrameLike): Promise<DetectedField[]>;
//   frame.evaluate(detectFieldBasesInPage)
// → z.array(fieldBaseSchema).parse(raw)          // trust boundary
// → map(b => ({ ...b, ...classifyField(b), riskLevel: getRiskLevel(...) }))

export async function expandComboboxOptions(frame: FrameLike, fields: DetectedField[]): Promise<DetectedField[]>;
export async function resolveFormRoot(page: PageLike, allowedHosts: string[]): Promise<{ frame: FrameLike; isIframe: boolean }>;
```

The donor's `toDetectedField` already builds a purely DOM-derived `base` object and then calls `classifyField(base)` and `getRiskLevel(...)` as separate steps. That seam **is** the evaluate boundary: inline the DOM half into the page function, run classification in Node.

Inline into `detectFieldBasesInPage`: `cssEscape`, `isVisible`, `isFillable`, `uniqueSelector`, `stableId`, `elementOptions`, `currentValue`, and all nine label sources from `labelExtractor`. Preserve the radio/checkbox re-prioritisation — legend first, then `aria-labelledby`, then parent question text — because that is what attaches "Are you authorized to work in the US?" to the Yes/No radios rather than to the word "Yes".

Three gaps the donor never closed, all cheap here:

- **Shadow DOM.** Playwright's locator engine pierces open shadow roots for the *fill* path, but `document.querySelectorAll` inside `evaluate` does not. Add a shallow recursion into `el.shadowRoot` when non-null — about ten lines.
- **Iframes.** `resolveFormRoot` scans `page.frames()` for a frame on an allowed host containing at least one fillable control, falling back to `mainFrame()`. This is what reaches `smartapply.indeed.com`.
- **Collapsed comboboxes.** The donor reads `aria-controls` and yields `options: []` when the listbox is not already in the DOM. `expandComboboxOptions` clicks, waits 300–800 ms, reads `[role=option]`, then presses Escape. Runs in Playwright, not inside `evaluate`.

**Create** `worker/src/formfill/optionMatching.ts` — `comparableOption(value)`, `optionMatches(options, answer)`, `bestOptionIndex(options, desired)` returning −1 when ambiguous.

**Create** `worker/src/apply/fillField.ts` — `fillDetectedField(frame, field, value, human)`. Dispatch: `select` → `selectOption({label})` then `{value}`; `radio`/`checkbox` → `frame.locator(field.selector).nth(bestOptionIndex(...)).check()` — **the donor's group selector matches N elements, so narrowing by index is mandatory**; text and textarea → `scrollIntoViewIfNeeded()` → `click()` → `pressSequentially(value, { delay })`; `file` is never handled here.

Do not port the donor's `setNativeValue` + synthetic-event machinery. Playwright's real events are better. The only genuinely reusable part of `fieldFiller.ts` is `bestOption`'s fuzzy matching.

**Done when:** a Playwright test against `file:///Users/shuvomahamud/Projects/BroswerExtension/examples/sample-application-form.html` asserts the correct category for every field, including four options on the gender select and `resume_upload` on the file input. The four ported pure suites are green under `node:test`.

---

## Stage 6 — Answer bank + profile PII

**Create** `worker/src/formfill/answerBank.ts`:

```ts
export type AnswerScope = "global" | "company" | "job";
export async function loadAnswerBank(i: { userId: string; jobId: string; company: string; domain: string }): Promise<SavedAnswer[]>;
export function profileToSavedAnswers(p: CandidateProfile): SavedAnswer[];
export function commonAnswerToSavedAnswer(row: CommonAnswer): SavedAnswer;
export async function learnAnswer(i: { userId: string; scope: AnswerScope; scopeKey: string; field: DetectedField; answerValue: string; domain: string; source: "user_reply" | "dashboard" }): Promise<void>;
export function chooseAnswerScope(field: DetectedField, company: string): { scope: AnswerScope; scopeKey: string };
export async function markAnswersUsed(ids: string[]): Promise<void>;
```

**Precedence is expressed purely as array order**, because `matchSavedAnswer` uses `answers.find(...)` and takes the first hit:

1. `application_answers` scope `job`
2. `application_answers` scope `company`
3. profile-derived, **identity categories only** — `first_name`, `last_name`, `full_name`, `email`, `phone`, `address`, `city`, `state`, `zip`, `country`, `linkedin`, `github`, `portfolio`
4. `application_answers` scope `global`
5. `common_answers` mapped in via `commonAnswerToSavedAnswer`

Identity sits *above* global learned answers deliberately: a stale learned phone number silently going to every future employer is worse than the reverse, and `/profile` is the obvious place to correct it.

`commonAnswerToSavedAnswer` maps `question_key` onto a `FieldCategory` when it matches one of the 39, else `custom_short_answer`; `normalized_question` comes from `normalizeQuestion(row.question_text)`; `aliases` gets `[question_key.replace(/_/g, " ")]`.

`learnAnswer` upserts on the unique key and flips the `pending_questions` row to `answered` — **one `db.batch([...])`, never `db.transaction`**.

`chooseAnswerScope`: `custom_long_answer`, `cover_letter`, or any question text containing the company name → `company`. Everything else → `global`. `job` is reserved for a future dashboard "just this once" toggle.

**Done when:** a test asserts an `application_answers` row shadows `common_answers` but does **not** shadow `candidate_profile.phone`.

---

## Stage 7 — Notifications

**Create** `worker/src/notify/channel.ts` — a `NotificationChannel` interface with `notifyQuestion`, `notifyAnswerAccepted`, `notifyRunSummary`, plus `resolveChannel(cfg)`.

**Create** `worker/src/notify/telegramChannel.ts` — plain `fetch` against `https://api.telegram.org/bot<token>/…`. No new dependency.

- 2–8 options → `reply_markup.inline_keyboard` with `callback_data = "a:<shortId>:<optionIndex>"`. **Never put option text in `callback_data`** — it is capped at 64 bytes and real option labels overflow it.
- Free text → `sendMessage` with `reply_markup: { force_reply: true }`; store the returned `message_id` in `pending_questions.channel_message_id`.
- More than 8 options → numbered text fallback.
- `notifyAnswerAccepted` → `editMessageText` stripping the keyboard, so buttons cannot be double-pressed.

**Create** `worker/src/notify/dashboardChannel.ts` — a no-op sender. `/questions` reads `pending_questions` directly, so dashboard answering works whether or not Telegram is configured. This is the required fallback.

**Create** `src/lib/answerValidation.ts` — **shared by the webhook and the dashboard server action so the two paths cannot diverge**:

```ts
export function validateAnswerForQuestion(
  q: Pick<PendingQuestion, "answerType" | "category" | "options" | "required">,
  raw: string,
): { ok: true; value: string; optionValue?: string } | { ok: false; message: string };
```

Rules: options present → must resolve via `bestOptionIndex` (exact, then normalized-contains); yes/no → `y|yes|1|true` and `n|no|0|false` mapped onto the affirmative/negative option; `years_*` → integer 0–60; free text 1–5000 chars. On failure the question stays `open` and the user is told the allowed values.

**Create** `src/app/api/telegram/webhook/route.ts` — Node runtime:

1. Verify the `X-Telegram-Bot-Api-Secret-Token` header against `TELEGRAM_WEBHOOK_SECRET`. Reject any update whose chat id is not `TELEGRAM_ALLOWED_CHAT_ID`.
2. Resolve the question: `callback_query` → parse `a:<shortId>:<idx>` and bounds-check against `options_json`; or `message.reply_to_message.message_id` matched against `channel_message_id`.
3. `validateAnswerForQuestion` → `learnAnswer` → `editMessageText`.
4. **Enqueue the retry** — `createCommand({ type: "apply_to_jobs", payloadJson: { jobIds: [q.jobId] }, source: "system" })` once no `open` question remains for that job. This is the "and it resumes" step. Route it through `createCommand`, which validates, not through a raw insert.

Register the webhook once with `setWebhook`, passing both the URL and the secret token.

**Create** `src/app/(dashboard)/questions/page.tsx` with `answerPendingQuestion` and `dismissPendingQuestion` actions, using the same validator.

**Config:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET` (all optional), `JOB_APPLY_NOTIFY_CHANNEL` defaulting to `dashboard`, `JOB_APPLY_QUESTION_TTL_HOURS` defaulting to 72.

**Done when:** answering once through Telegram *or* the dashboard causes the retry to complete without re-asking the same normalized question.

---

## Stage 8 — The apply runner

### Human pacing

**Create** `worker/src/apply/humanInput.ts` — `typingDelayMs` (45–140 ms per character, plus 180–400 ms after `.`, `,`, `?`, `!`), `interFieldDelayMs` (700–2600 ms), `readingDelayMs` (~180 wpm, capped at 12 s), `preSubmitDelayMs` (3000–9000 ms), `betweenApplicationsMs`. Keep `rng` injectable for deterministic tests, matching the existing `humanDelayMs(options, random = Math.random)` convention.

Reuse `humanDelayMs` from `worker/src/search/browserDiscovery.ts` for page-scale waits only — its 1000 ms floor makes it unusable for typing.

### Artifacts

**Create** `worker/src/apply/artifacts.ts` — `screenshot` (must never throw), `startTrace`, `finishTrace`. Layout `${JOB_APPLY_ARTIFACT_DIR}/<commandId>/<jobId>/NN-<label>.png` plus `trace.zip`, defaulting to `~/.job-portal/artifacts` beside the existing logs directory.

**Tracing starts always.** You cannot start a trace after a failure you did not predict. Call `finishTrace(ctx, keep = false)` — `stop()` with no path — to discard it on success. Record paths in `command_events.metadata_json.artifacts[]`; **never bytes in the database**. Screenshots contain PII by construction: Mac disk only, never uploaded.

Wrap every artifact call in try/catch. Artifact capture must never fail an application.

### Field policy

**Create** `worker/src/apply/applyPolicy.ts`. This is the deliberate re-mapping from the donor's "everything requires human review" defaults to a three-way automated decision. **Do not edit the copied `riskPolicy.ts`** — keep it byte-identical so its ported tests stay meaningful; consume it from here.

```ts
export type ApplyMode = "dry_run" | "fill_only" | "fill_and_submit";
export const APPLY_MODE_RANK: Record<ApplyMode, number> = { dry_run: 0, fill_only: 1, fill_and_submit: 2 };
export function effectiveMode(requested: ApplyMode | undefined, ceiling: ApplyMode): ApplyMode;

export type FieldAction =
  | { kind: "fill"; value: string; source: MatchType | "profile" }
  | { kind: "ask"; reason: string }
  | { kind: "skip"; reason: string };
```

| Condition | Action |
|---|---|
| `inputType === "file"` | `skip` — the resume path handles it |
| `categoryAlwaysRequiresReview(cat)` — sponsorship, expected salary, desired rate, all four EEO, legal background, long answer | `fill` **only** on `matchType ∈ {exact, normalized, alias}`, else `ask` |
| `matchType ∈ {exact, normalized, alias}` ∧ match ≥ 0.9 ∧ field ≥ 0.7 | `fill` |
| `matchType === "rule"` (sole category) | `fill` when `riskLevel === "LOW"`, else `ask` |
| `matchType === "ollama"` | `ask` unless `JOB_APPLY_TRUST_LLM_ANSWERS` and category is `custom_short_answer` |
| Options present ∧ `!optionMatches(...)` | try `mapDropdownWithOllama`; on failure `ask`, passing `field.options` as the Telegram keyboard |
| No match ∧ required | `ask` |
| No match ∧ optional | `skip` |

### Site adapters

**Create** `worker/src/apply/applySteps.ts`:

```ts
export type SiteAdapter = {
  source: "indeed" | "dice";
  allowedApplyHosts: string[];              // indeed.com, smartapply.indeed.com
  findApplyButton(page: PageLike): Promise<LocatorLike | null>;
  findAdvanceControl(frame: FrameLike): Promise<{ locator: LocatorLike; isTerminalSubmit: boolean } | null>;
  detectSuccess(page: PageLike): Promise<boolean>;
  detectBlocked(page: PageLike): Promise<{ blocked: boolean; reason: string }>;
};
export function adapterFor(source: string): SiteAdapter;
export function isExternalAts(url: string, allowed: string[]): { external: boolean; host: string };
```

Keep adapters small. They are where the ongoing maintenance lives.

### The state machine — do not simplify

```
draft ──► filling ──► [awaiting_answer] ──► submitting ──► applied
                                                  │
                                                  └──► submission_unknown
```

**Create** `worker/src/apply/applyRunner.ts` — `applyToJob(ctx)` returning a `stopReason` of `submitted | filled_not_submitted | dry_run | external_ats | needs_answers | blocked | stalled | canceled | time_limit | already_applied | error`.

0. **Guards before any navigation.** `JOB_APPLY_ENABLED`; `job.source ∈ {indeed, dice}` **and** the `sourceUrl` hostname ends with `indeed.com` or `dice.com` — belt and braces, because `JOB_SOURCES` still contains `linkedin` and `import_jobs` still accepts it; an eligible `job_role_matches` row exists; global and per-role daily caps not reached; **and no existing application in `submitting`, `submission_unknown`, `applied`, or any post-applied state.**
1. Resolve the resume from the winning `job_role_matches` row → `materializeResume`. Any failure → `needs_manual` with the reason.
2. **Upsert `applications` as `draft` before the first keystroke**, with `target_role_id`, `job_role_match_id`, `resume_version_id`, using `ON CONFLICT (job_id, user_id)`. A crash mid-run then leaves a recoverable trace.
3. `goto` → `humanDelayMs` → `readingDelayMs` → screenshot `00-jobpage`.
4. `findApplyButton` → click → resolve the apply origin across `page.frames()` **and** any newly-opened page in `context.pages()`. External ATS → `needs_manual`, record the host, leave `jobs.status` untouched, return. → `filling`
5. Step loop, `step < JOB_APPLY_MAX_STEPS` (default 8): `resolveFormRoot` → `detectFields` → `expandComboboxOptions` → `enhanceFieldsWithOllama` (max 5 LLM calls per step, accept only ≥ 0.55) → `buildSuggestion` → `decideFieldAction` → `setInputFiles` for `resume_upload` → fill in DOM order with `interFieldDelayMs` between → screenshot. **Stall detection:** hash `sorted(field.id).join("|") + frame.url()`; if unchanged after an advance attempt, retry once, then `stalled`.
6. Any `ask` → `awaiting_answer`. Create the `pending_questions` rows with `context_json = { applyUrl, stepIndex, screenshotPath }`, notify each, set a note naming the questions, leave `jobs.status = 'ready_to_apply'`, emit `apply_needs_answers`, and **complete — not fail — the command.** The webhook enqueues the retry.
7. **Before the terminal click:** write `status = 'submitting'` and `submitted_at` to Postgres and **await the write**. Then screenshot `98-before-submit`. Then click.
8. After the click: `detectSuccess`. Confirmed → `applied` with `confirmation_evidence` and screenshot `99-after-submit`. Unclear, timeout, or crash → **`submission_unknown`**. Never `failed`.
9. Success → `db.batch([ update applications …, update jobs SET status='applied' ])`.
10. `detectBlocked` at every step boundary → `applications.status = 'blocked'`, capture artifacts, and **stop the whole command**, not just this job. A captcha means back off, not grind. Never attempt a bypass.

### Mode semantics

- `dry_run` — detect, classify, resolve, and log a full field-by-field plan. **Zero keystrokes, zero clicks except opening the apply modal.** Never creates `pending_questions`.
- `fill_only` — fills everything and clicks Continue between steps, but **stops at the terminal Submit** and screenshots it.
- `fill_and_submit` — runs the full state machine.

These are rollout gates, not separate products.

**Create** `worker/src/handlers/applyToJobs.ts` — payload `{ jobIds: uuid[1..10], mode?, maxJobs?, maxRuntimeMinutes? }`. Open **one** browser session for the whole command via `worker/src/browser/session.ts`. Loop jobs with `betweenApplicationsMs` between them, per-job try/catch so one failure does not lose the rest, and a `finally` block mirroring `discoverJobsBrowser.ts:199-218`.

Register in `worker/src/dispatcher.ts`. Add `apply_to_jobs` to `WORKER_COMMAND_TYPES` **only in the Mac env file, never the VPS.**

**Config:** `JOB_APPLY_ENABLED: boolFromEnv(false)` — mirror the kill-switch throw at `discoverJobsBrowser.ts:66-68` — plus `JOB_APPLY_MODE` (default `dry_run`), `JOB_APPLY_MAX_PER_DAY` (15), `JOB_APPLY_MAX_JOBS_PER_COMMAND` (5), `JOB_APPLY_MAX_MINUTES_PER_APPLICATION` (20), `JOB_APPLY_MAX_STEPS` (8), `JOB_APPLY_MIN_GAP_SECONDS` / `MAX_GAP_SECONDS` (90 / 420), `JOB_APPLY_ARTIFACT_DIR`, `JOB_APPLY_TRACE`, `JOB_APPLY_TRUST_LLM_ANSWERS` (false).

**Done when:** local fixtures pass in all three modes, **including a simulated crash after Submit that lands on `submission_unknown` and is not retried by a subsequent cycle.**

---

## Stage 9 — Orchestrator + command center

**Create** `worker/src/handlers/runApplyCycle.ts` — payload `{ phase?: "discover" | "apply", maxJobs?, mode?, matchingCommandIds?, attempt? }`. **Re-entrant and phase-based** so it never holds a claim for an hour:

- **`discover`** (default): load `target_roles WHERE active`. For each, spawn `find_matching_jobs` with that role's title and locations. Then spawn a successor `run_apply_cycle` with `phase: "apply"`, `parentCommandId: self`, `scheduledFor: now + 20min`, carrying the child ids. Complete.
- **`apply`**: if matching children are still running and `attempt < 6`, reschedule self at +10 min. Otherwise select `jobs` with an eligible `job_role_matches` row and no `applications` row for this user, order by score descending, respect global and per-role caps, take `maxJobs`, spawn `apply_to_jobs`, complete.

This reuses `scheduledFor` and `parent_command_id`, both already indexed by `commands_queue_idx` and `commands_parent_idx`. No new scheduler primitive.

**Create** `worker/src/scripts/enqueueApplyCycle.ts` — creates the root command with `source: 'system'` and `requestedBy: WORKER_OWNER_USER_ID`. Refuses if an unfinished `run_apply_cycle` already exists for that user. Add `WORKER_OWNER_USER_ID: z.string().uuid().optional()` to config and `"worker:cycle"` to `package.json`.

**Create** `worker/launchd/com.jobportal.apply-cycle.plist.template` — `StartCalendarInterval`, weekdays 09:15 and 14:15, running `npm run worker:cycle`. **`KeepAlive` must be `false`.** The existing `com.jobportal.ai-worker.plist.template` has `KeepAlive true`, and copying that into a one-shot job makes launchd respawn it in a tight loop.

### The command center

- **Create** `src/app/(dashboard)/applications/page.tsx` — job, company, role, resume version, match score, status, applied time, confirmation, stop reason, artifact paths, and the audit timeline from `command_events`. Filter by status and role.
- **Modify** `src/app/(dashboard)/page.tsx` — metric cards for applied today, applied this week, questions awaiting the user, `needs_manual`, `blocked`, **unknown submissions**, and per-role totals.
- **Modify** `src/app/(dashboard)/jobs/[id]/page.tsx` — turn the existing read-only "Application & follow-up" cards into a live view with the apply timeline and an "Apply now" action.
- **Controls:** global pause, per-role enable and cap, safe retry, "Apply now", and an explicit **resolve `submission_unknown`** action offering mark-applied / mark-not-applied / re-verify.
- **Reuse** `src/components/matching-run-status.tsx` as the live-progress template — it already polls a command every 4 s until terminal, and `src/app/api/matching-runs/[id]/route.ts` shows the safe-projection pattern for exposing a command without leaking payloads.
- Keep raw command payloads in an advanced diagnostics view only.

**Done when:** one root cycle shows linked discovery, matching, and application commands on `/commands`, and the dashboard counts reconcile with the database.

---

## Stage 10 — Cleanup and staged rollout

Only after replacements pass their tests, and only with `rg` confirming no remaining consumers.

- Mark `docs/ai-profile-job-matching-implementation-guide.md` as the completed matching foundation.
- Mark `docs/h1b-contract-fit-implementation-plan.md` superseded — it still describes LinkedIn and a browser extension.
- Migrate `candidate_profile.target_titles` into `target_roles`, stop writing it from the UI, and remove the column only in a later verified migration.
- Remove `src/app/api/extension/profile/route.ts`, `src/app/api/extension/job/[id]/route.ts`, the `EXTENSION_API_SECRET` env var and its settings row, and all extension wording in the README. *Both routes are confirmed present today.*
- Remove `src/components/command-composer.tsx` — *confirmed imported nowhere.*
- Mark legacy `resume_versions` rows carrying a `storage_path` as requiring re-upload. Delete old files only with explicit confirmation.
- Stop writing user-specific match state to global `jobs` fields; read from `job_role_matches` and `applications`.
- Keep historical command enum values and rows for audit. Remove unused legacy commands from active UI and worker allow-lists only.

### Rollout — in order, never skipping a step

1. `JOB_APPLY_ENABLED=false` → the handler throws. Confirm this.
2. `dry_run`, one role, one real Indeed job. Read the logged plan and every screenshot. Assert nothing was typed.
3. `fill_only`, one job, headed (`JOB_BROWSER_HEADLESS=false`). Verify by eye, then close the tab manually.
4. `fill_and_submit`, `JOB_APPLY_MAX_JOBS_PER_COMMAND=1`, capped at one application per day, on a job the user genuinely wants.
5. Raise caps only after reviewing confirmations, answers, screenshots, and at least one `blocked` outcome.

---

## Risk register

**High.** Indeed's smartapply DOM — iframe boundary, step affordances, custom comboboxes — changes without notice, and Indeed actively fingerprints automation. `resolveFormRoot` and the site adapters will absorb roughly 80% of ongoing maintenance; keep them small and the artifacts good. `connectOverCDP` into a dedicated logged-in Chrome profile is far more survivable than `launchPersistentContext`. If `WORKER_HEARTBEAT_INTERVAL_SECONDS` ever exceeds the recovery window, you get a silently double-executed apply.

**Medium.** Auto-extraction mangles multi-column and scanned PDFs; the character-count guard makes that visible but does not fix it, and a badly extracted resume will quietly match badly. Neon HTTP has no interactive transactions. Blob upload adds an auth surface — the token route must derive identity from Clerk and never trust a client-supplied user id. Verify Playwright tracing actually attaches over `connectOverCDP` on 1.62.

**Low.** A job eligible under two roles applies once, using the higher-scoring pair's resume; the other pair stays recorded but unused.

**Stated plainly.** Automated submission violates Indeed's and Dice's terms of service, and account suspension is the realistic downside. Human pacing, daily caps, a real logged-in profile, and `detectBlocked` back-off reduce the odds but do not eliminate them. Keep this warning visible in settings.

---

## Verification checklist

| # | Covers |
|---|---|
| 1 | Four ported suites green under `node:test`; `applyPolicy` decision table with one case per branch; `validateAnswerForQuestion`; `effectiveMode` clamping; seeded-RNG delay functions; `extractResumeText` against a known PDF; SHA-256 mismatch rejection |
| 2 | Ownership: a Blob upload token cannot be obtained for another user's account; `resume-download` requires the worker secret |
| 3 | Local fixtures — the donor repo's `examples/sample-application-form.html`, plus new `worker/tests/fixtures/multi-step-apply.html`, `iframe-apply.html`, and `stalled-apply.html` |
| 4 | Role routing: one job under two roles selects the higher-scoring pair and its resume; deleting a bound resume is refused |
| 5 | Learning loop: answer via Telegram, then via the dashboard; each writes an `application_answers` row and queues a retry; re-running the same field raises zero questions |
| 6 | Heartbeat: backdated `claimed_at` with a fresh `heartbeat_at` survives `recoverStaleClaims(60)`; without the heartbeat it is recovered |
| 7 | **Crash after Submit produces `submission_unknown`, and a subsequent cycle does not retry it** |
| 8 | Duplicate commands cannot produce duplicate external submissions |
| 9 | CAPTCHA fixture → `blocked`, command stopped, no bypass attempted |
| 10 | An Indeed posting that redirects to Greenhouse → `needs_manual`, `jobs.status` unchanged, no fields touched |
| 11 | A duplicate apply → `already_applied` with zero navigation |
| 12 | Dashboard counts reconcile with database records and command events |

Plus all five build commands green after every stage.
