# Searchlight — Job Command Center

Searchlight is a private job-matching dashboard with a Next.js control plane,
Neon/Postgres command queue, a VPS discovery worker, and a Mac local-AI worker.

The normal user workflow is **Find matching jobs**. It discovers individual
Indeed and Dice postings, stages them invisibly, evaluates them against the
candidate profile with local Ollama, and shows only matches or explicit review
cases. It never submits an application.

## What is included

- Clerk-protected dashboard pages
- Manual job intake, job filtering, fit/status updates, and job detail views
- Candidate profile, resume-version metadata, and reusable application answers
- Applications, reviews, and follow-up data models
- An allow-listed, auditable command queue
- Atomic worker command claiming with `FOR UPDATE SKIP LOCKED`
- Scoped APIs for Hermes, the VPS worker, n8n, and a browser extension
- Indeed/Dice-only browser discovery with individual-detail extraction
- Mac Ollama `qwen3.5:9b` structured profile matching
- Deterministic match policy and optional remote review for uncertain results
- Parent/child matching-run progress and an auditable review trail
- Drizzle schema, generated Postgres migration, idempotent sample seed data
- Zod request and command-payload validation
- Clean JSON API errors and smoke tests for the security boundary

## Architecture

```text
                          Clerk
                            │
                    authenticated session
                            │
                    ┌───────▼────────┐
   Hermes ─────────►│   Next.js on   │◄──────── Dashboard browser
   scoped secret    │     Vercel     │          Clerk session
                    │                │
   n8n ────────────►│ API + server   │◄──────── Browser extension
   scoped secret    │    actions     │          scoped read secret
                    └───────┬────────┘
                            │ Drizzle + Neon HTTP
                    ┌───────▼────────┐
                    │ Neon Postgres  │
                    │ source of truth│
                    └───────▲────────┘
                            │
                    VPS worker APIs
              claim / complete / fail with scoped secret
```

The dashboard is currently a single-tenant operational surface: job records do
not have a `user_id`, matching the Phase 1 schema. Configure the Clerk instance
as invite-only before production use so only authorized dashboard users can
sign in.

## Data model

The generated migration creates these tables:

- `users`
- `jobs`
- `candidate_profile`
- `resume_versions`
- `common_answers`
- `applications`
- `job_reviews`
- `followups`
- `commands`
- `command_events`
- `integration_events`

Postgres enums enforce job, application, follow-up, priority, reviewer, command
source, command status, and command type values. Frequently filtered columns and
queue fields are indexed. Source URLs, identity provider IDs, and per-user
common-answer keys have unique constraints.

## Required environment variables

Copy `.env.example` to `.env.local` for local development.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon pooled Postgres connection string |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk browser key |
| `CLERK_SECRET_KEY` | Clerk server key |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | Use `/sign-in` |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | Use `/sign-up` |
| `HERMES_COMMAND_SECRET` | Creates structured commands from Hermes |
| `WORKER_API_SECRET` | Claims and resolves commands from the VPS worker |
| `N8N_WEBHOOK_SECRET` | Ingests n8n integration events |
| `EXTENSION_API_SECRET` | Reads extension profile and job context |
| `APP_BASE_URL` | Absolute app origin, for example `https://app.example.com` |

The sample `.env.example` also includes optional seed identity values. Set
`SEED_USER_AUTH_PROVIDER_ID` to the Clerk user ID that should own the sample
profile.

Generate a separate high-entropy value for every integration secret. Do not
reuse a Clerk key or database password.

```bash
openssl rand -base64 48
```

## Neon setup

1. Create a Neon project and choose the region closest to the Vercel functions.
2. In Neon, open **Connect** and copy the pooled connection string.
3. Set it as `DATABASE_URL`. Keep `sslmode=require` in the URL.
4. Generate or inspect migrations:

   ```bash
   npm run db:generate
   ```

5. Apply committed migrations:

   ```bash
   npm run db:migrate
   ```

6. Optionally load the Phase 1 samples:

   ```bash
   npm run db:seed
   ```

`db:generate` is an offline schema check. `db:migrate` and `db:seed` require a
reachable Neon database. `db:verify` checks all 11 live application tables and
reports row counts without displaying credentials.

## Clerk setup

1. Create a Clerk application and copy its publishable and secret keys.
2. Add `/sign-in` and `/sign-up` as the application paths.
3. Configure the production and preview domains in Clerk.
4. For a private personal command center, disable public sign-up and invite only
   the intended account(s).
5. Add the Clerk environment variables to `.env.local` and Vercel.

The protected dashboard route group also calls `auth.protect()` server-side.
Dashboard API handlers verify the Clerk session independently.

## Run locally

Requirements: Node.js 20.9 or newer and npm.

```bash
npm install
cp .env.example .env.local
npm run db:migrate
npm run db:seed
npm run db:verify
npm run dev
```

Open `http://localhost:3000` and sign in through Clerk.

Useful checks:

```bash
npm run lint
npm run typecheck
npm run test:smoke
npm run seed:check
npm run build
```

## Deploy to Vercel

1. Push this directory to a Git repository and import it in Vercel as a Next.js
   project.
2. Select Node.js 20 or newer.
3. Add every required environment variable to the appropriate Production,
   Preview, and Development scopes.
4. Use a separate Neon branch/database for preview deployments when possible.
5. Run `npm run db:migrate` against the production Neon branch before sending
   production traffic to a schema-changing release.
6. Deploy, then set `APP_BASE_URL` to the final HTTPS origin and add that domain
   in Clerk.

Vercel automatically runs `npm run build`. Database migrations are intentionally
not run during the build so a preview deployment cannot mutate production by
accident.

## API authentication

Dashboard endpoints use the Clerk session. Integration endpoints accept either:

- `Authorization: Bearer <scoped-secret>`, or
- the matching explicit header:
  - `x-hermes-command-secret`
  - `x-worker-api-secret`
  - `x-n8n-webhook-secret`
  - `x-extension-api-secret`

Secret comparisons use constant-time comparison. Missing server configuration
returns `503`; missing or incorrect credentials return `401`.

All responses use one of these shapes:

```json
{ "data": {} }
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request did not pass validation.",
    "details": [{ "path": "workerId", "message": "Too small" }]
  }
}
```

## API routes

| Route | Authentication |
| --- | --- |
| `POST /api/jobs/import` | Clerk dashboard session |
| `GET /api/jobs` | Clerk dashboard session |
| `GET /api/jobs/:id` | Clerk dashboard session |
| `PATCH /api/jobs/:id` | Clerk dashboard session |
| `POST /api/commands` | Clerk session **or** Hermes secret |
| `GET /api/commands` | Clerk dashboard session |
| `GET /api/commands/:id` | Clerk dashboard session |
| `POST /api/worker/claim-command` | Worker secret |
| `POST /api/worker/complete-command` | Worker secret |
| `POST /api/worker/fail-command` | Worker secret |
| `POST /api/n8n/events` | n8n secret |
| `GET /api/dashboard/summary` | Clerk dashboard session |
| `GET /api/matching-runs/:id` | Clerk dashboard session, run owner only |
| `GET /api/extension/profile` | Extension secret |
| `GET /api/extension/job/:id` | Extension secret |

## Matching workflow

The overview page creates a `find_matching_jobs` root command. The VPS claims
it, discovers individual Indeed/Dice postings, applies deterministic hard
filters, and creates a `run_local_llm_extraction` child command. The Mac claims
only that child command, calls loopback Ollama, validates the evidence, and
applies the deterministic decision policy. Archived or processing jobs are not
shown in the normal dashboard.

For the detailed machine setup, data contract, uncertainty policy, tests, and
deployment checklist, see [the implementation guide](docs/ai-profile-job-matching-implementation-guide.md).

## How Hermes creates commands

Hermes sends only an allow-listed command type and its typed payload:

```bash
curl -X POST "$APP_BASE_URL/api/commands" \
  -H "Authorization: Bearer $HERMES_COMMAND_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "find_matching_jobs",
    "priority": "high",
    "payloadJson": {
      "sources": ["indeed", "dice"],
      "queries": ["senior product engineer"],
      "locations": ["New York", "Remote"],
      "maxResults": 10
    }
  }'
```

Allowed command types:

- `find_matching_jobs`
- `run_job_search`
- `import_jobs`
- `run_rule_filter`
- `run_local_llm_extraction`
- `review_top_jobs`
- `review_job`
- `draft_answer`
- `trigger_n8n_summary`
- `sync_n8n_email_events`
- `mark_application_status`
- `reprocess_job`

The database enum, request schema, and per-type payload schema all enforce the
same list. Payload objects are strict, and keys such as `shell`, `script`,
`command`, `cmd`, `executable`, and `argv` are rejected recursively. Nothing in
the app evaluates payload strings as code.

## How a worker claims commands

Claim the next due command. The database selects the highest priority item and
locks it atomically so concurrent workers cannot claim the same row.

```bash
curl -X POST "$APP_BASE_URL/api/worker/claim-command" \
  -H "Authorization: Bearer $WORKER_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "workerId": "worker-nyc-01",
    "commandTypes": ["run_rule_filter", "review_job"]
  }'
```

The response contains either a claimed command or `{"command": null}`.

Complete it:

```bash
curl -X POST "$APP_BASE_URL/api/worker/complete-command" \
  -H "Authorization: Bearer $WORKER_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "commandId": "00000000-0000-4000-8000-000000000000",
    "workerId": "worker-nyc-01",
    "resultJson": { "processed": 12 }
  }'
```

Or fail it:

```bash
curl -X POST "$APP_BASE_URL/api/worker/fail-command" \
  -H "Authorization: Bearer $WORKER_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "commandId": "00000000-0000-4000-8000-000000000000",
    "workerId": "worker-nyc-01",
    "errorMessage": "Upstream source timed out"
  }'
```

A worker can only complete or fail a command it currently owns. Creation,
claim, completion, failure, and retry actions append `command_events`.

## n8n and extension contracts

n8n records an event for later processing:

```bash
curl -X POST "$APP_BASE_URL/api/n8n/events" \
  -H "x-n8n-webhook-secret: $N8N_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "recruiter_email_received",
    "payloadJson": { "externalMessageId": "provider-safe-id" }
  }'
```

The extension can read the constrained profile bundle or one job:

```bash
curl "$APP_BASE_URL/api/extension/profile" \
  -H "x-extension-api-secret: $EXTENSION_API_SECRET"
```

```bash
curl "$APP_BASE_URL/api/extension/job/JOB_UUID" \
  -H "x-extension-api-secret: $EXTENSION_API_SECRET"
```

## Security rules

- Never store LinkedIn, Indeed, Dice, or email passwords.
- Never store browser session cookies.
- Never store Codex credentials or VPS SSH keys.
- Never accept a raw shell command, script, executable path, or argument vector.
- Treat every command payload as data for a fixed worker dispatcher.
- Give every integration its own randomly generated secret.
- Keep secrets in `.env.local` and Vercel environment configuration only.
- Do not log authorization headers or payloads that contain third-party secrets.
- Keep Clerk invite-only for this single-tenant Phase 1 schema.
- Rotate a compromised integration secret without rotating unrelated scopes.
- Return extension data only through the dedicated constrained read endpoints.

The system intentionally records resume URLs/paths, not resume file bytes.
Object storage and signed download URLs can be added when actual uploads are in
scope.

## Worker implementation

Phase 2 worker code now lives in `worker/`.

It is a lightweight VPS/cloud service that:

- polls every 10 seconds by default;
- claims commands through `/api/worker/claim-command`;
- completes/fails commands through the dashboard worker APIs;
- writes job records and command audit events directly to Neon;
- supports `run_job_search` and `import_jobs`;
- avoids job-board passwords, cookies, browser automation, CAPTCHA bypass, and Codex usage in Phase 2.

Useful checks:

```bash
npm run worker:typecheck
npm run worker:test
```

With real VPS env vars:

```bash
WORKER_ENV_FILE=/opt/job-worker/.env npm run worker:health
WORKER_ENV_FILE=/opt/job-worker/.env npm run worker:start
```

See `worker/README.md` for env vars, systemd deployment, and command payload examples.

## Future phases

### Phase 3 — extraction and review

- Add local LLM extraction behind `run_local_llm_extraction`.
- Add deterministic rule filtering and persisted rule versions.
- Expand the opt-in remote reviewer only after evaluating representative jobs.
- Store review provenance, model/version metadata, and structured outputs.

### Phase 4 — assisted application workflow

- Add the browser extension UI using the existing extension read contracts.
- Add human-approved answer drafting and application status capture.
- Add notification summaries and follow-up creation through n8n.
- Keep final application submission and sensitive answers human-controlled.

Every future component should integrate through the existing database and
structured APIs instead of creating a parallel source of truth.
