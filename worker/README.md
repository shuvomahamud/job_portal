# Phase 2 Worker

This is the lightweight VPS/cloud worker for Searchlight Phase 2.

It executes the collection/orchestration layer for the existing dashboard command queue.

## What Phase 2 includes

- 30-second always-running poll loop recommended; 10-second override for testing
- Claims commands from the dashboard worker API
- Completes/fails commands through the dashboard worker API
- Writes job records directly to Neon for efficient imports
- Writes command events directly to Neon for audit visibility
- Recovers stale claimed commands after a timeout
- Supports allow-listed Phase 2/3 commands:
  - `run_job_search`
  - `discover_jobs_browser`
  - `import_jobs`
  - `run_rule_filter`
- Uses conservative job-search link generation plus optional local browser-assisted discovery
- Deduplicates jobs by `source_url`

## What Phase 2 intentionally does not do

- No Codex review
- No local LLM
- No always-on browser unless `discover_jobs_browser` is explicitly enabled on the local logged-in machine
- No LinkedIn/Indeed/Dice password handling
- No cookie/session storage
- No CAPTCHA/security bypass
- No raw shell-command execution from payloads

## Lightweight defaults

```env
WORKER_POLL_INTERVAL_SECONDS=30
WORKER_CLAIM_LIMIT=1
WORKER_MAX_CONCURRENCY=1
JOB_SEARCH_MAX_RESULTS_PER_COMMAND=50
JOB_SOURCE_DELAY_MS=3000
```

A 30-second poll means only about 2 checks/minute. When the queue is empty, the process sleeps and does no CPU-heavy work. For active testing only, override `WORKER_POLL_INTERVAL_SECONDS=10` in the command environment.

## Required env vars

Create `/opt/job-worker/.env` on the VPS and set permissions to `600`.

```env
DATABASE_URL="postgresql://..."
DASHBOARD_BASE_URL="https://your-dashboard.vercel.app"
WORKER_API_SECRET="..."
WORKER_ID="job-worker-01"
WORKER_POLL_INTERVAL_SECONDS=30
WORKER_CLAIM_LIMIT=1
WORKER_MAX_CONCURRENCY=1
WORKER_COMMAND_TYPES="run_job_search,discover_jobs_browser,import_jobs,run_rule_filter"
JOB_SEARCH_MAX_RESULTS_PER_COMMAND=50
JOB_SOURCE_DELAY_MS=3000
JOB_IMPORT_FETCH_DESCRIPTIONS=false
CODEX_ENABLED=false
```

Do not paste `DATABASE_URL` into Telegram. Put it directly in the VPS env file.

## Commands

### `run_job_search`

Payload example:

```json
{
  "sources": ["linkedin", "indeed", "dice"],
  "queries": [".NET developer C# SQL", "application support Oracle"],
  "locations": ["Remote", "New York"],
  "limit": 30
}
```

The worker creates lightweight searchable records with source URLs, such as LinkedIn/Indeed/Dice search-result pages. This gives you useful links in the dashboard without running a heavy scraper or touching job-board credentials.

### `discover_jobs_browser`

This is Phase 2B. It uses a **local logged-in browser profile** at human-like speed to search LinkedIn, Indeed, and Dice, collect individual job URLs, then enrich each found link by opening the job detail page one at a time.

The enrichment step keeps the exact source/apply URL, extracts title/company/location/description where possible, detects obvious employment/remote/salary/visa hints, and still saves the URL with fallback metadata if extraction fails.

It is disabled by default. Enable only on the machine where you are logged in through the browser:

```env
JOB_BROWSER_DISCOVERY_ENABLED=true
JOB_BROWSER_USER_DATA_DIR="/home/shuvo/.job-worker-browser-profile"
JOB_BROWSER_HEADLESS=false
JOB_BROWSER_MIN_DELAY_MS=15000
JOB_BROWSER_MAX_DELAY_MS=45000
JOB_BROWSER_SLOW_MO_MS=500
JOB_BROWSER_MAX_RESULTS_PER_COMMAND=25
JOB_BROWSER_MAX_PAGES_PER_SEARCH=1
```

Install browser support on that local worker machine:

```bash
npm install -D playwright
npx playwright install chromium
```

Payload example:

```json
{
  "sources": ["linkedin", "indeed", "dice"],
  "queries": [".NET C# SQL", "application support Oracle"],
  "locations": ["Remote", "New York"],
  "maxResults": 25,
  "maxPagesPerSearch": 1
}
```

Safety boundaries:

- browser must already be logged in by the human;
- worker never stores platform passwords;
- worker does not click Apply or Submit;
- worker does not bypass CAPTCHA/security checks;
- worker uses one browser page/tab and reuses it for detail enrichment;
- worker waits 15–45 seconds between page actions by default;
- worker keeps page/result limits small.

### `import_jobs`

Payload example:

```json
{
  "source": "linkedin",
  "urls": [
    "https://www.linkedin.com/jobs/view/example"
  ]
}
```

By default, the worker imports the URL as a job record without fetching the job page. Set `JOB_IMPORT_FETCH_DESCRIPTIONS=true` only if you want it to attempt lightweight metadata fetching. Many boards block server-side fetches, so this is optional.

### `run_rule_filter`

Payload example:

```json
{
  "ruleset": "default",
  "limit": 100
}
```

Or run it for specific jobs:

```json
{
  "ruleset": "default",
  "jobIds": ["00000000-0000-4000-8000-000000000000"]
}
```

The rule filter updates each job with:

- `fit_score`
- `status` (`ready_to_apply`, `needs_review`, or `archived`)
- `priority`
- `visa_signal`
- detected tech stack
- salary/employment/remote hints where obvious
- a `rule_engine` row in `job_reviews`

Apply gate:

- `ready_to_apply` requires strong target-stack fit **and** an explicit or likely H-1B/contract path such as H-1B transfer, sponsorship available, W2 contract, C2H, C2C/corp-to-corp, or staffing/vendor contract signals.
- Full-time jobs with unknown sponsorship are kept as `needs_review` rather than auto-ready, even when the .NET fit is strong.
- `no sponsorship`, GC/USC-only, citizen-only, and clearance-required postings are archived/skipped even when the stack matches.

It is deterministic and lightweight: no browser, no Codex, no LLM.

## Local verification

From the repo root:

```bash
npm run worker:typecheck
npm run worker:test
```

With real env vars:

```bash
WORKER_ENV_FILE=/opt/job-worker/.env npm run worker:health
WORKER_ENV_FILE=/opt/job-worker/.env npm run worker:start
```

## systemd deployment

From a checked-out repo on the VPS:

```bash
sudo bash worker/scripts/install-systemd.sh
sudo install -m 600 worker/.env.example /opt/job-worker/.env
sudo nano /opt/job-worker/.env
sudo systemctl start job-worker
sudo systemctl status job-worker
journalctl -u job-worker -f
```

The service runs as the `jobworker` system user and restarts automatically.

## Future phases

Phase 4 should add Codex review and n8n summary handlers.
