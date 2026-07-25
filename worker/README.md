# Phase 2 Worker

This is the lightweight VPS/cloud worker for Searchlight Phase 2.

It executes the collection/orchestration layer for the existing dashboard command queue.

## What Phase 2 includes

- 10-second default poll loop
- Claims commands from the dashboard worker API
- Completes/fails commands through the dashboard worker API
- Writes job records directly to Neon for efficient imports
- Writes command events directly to Neon for audit visibility
- Recovers stale claimed commands after a timeout
- Supports only allow-listed Phase 2 commands:
  - `run_job_search`
  - `import_jobs`
- Uses conservative job-search link generation instead of heavy scraping/account automation
- Deduplicates jobs by `source_url`

## What Phase 2 intentionally does not do

- No Codex review
- No local LLM
- No always-on browser
- No LinkedIn/Indeed/Dice password handling
- No cookie/session storage
- No CAPTCHA/security bypass
- No raw shell-command execution from payloads

## Lightweight defaults

```env
WORKER_POLL_INTERVAL_SECONDS=10
WORKER_CLAIM_LIMIT=1
WORKER_MAX_CONCURRENCY=1
JOB_SEARCH_MAX_RESULTS_PER_COMMAND=50
JOB_SOURCE_DELAY_MS=3000
```

A 10-second poll means only about 6 checks/minute. When the queue is empty, the process sleeps and does no CPU-heavy work.

## Required env vars

Create `/opt/job-worker/.env` on the VPS and set permissions to `600`.

```env
DATABASE_URL="postgresql://..."
DASHBOARD_BASE_URL="https://your-dashboard.vercel.app"
WORKER_API_SECRET="..."
WORKER_ID="job-worker-01"
WORKER_POLL_INTERVAL_SECONDS=10
WORKER_CLAIM_LIMIT=1
WORKER_MAX_CONCURRENCY=1
WORKER_COMMAND_TYPES="run_job_search,import_jobs"
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

Phase 3 should add rule filtering/extraction handlers.
Phase 4 should add Codex review and n8n summary handlers.
