# Job Portal Workers

The matching workflow uses two instances of the same TypeScript worker package.
The database command queue connects them; neither machine needs an inbound public API.

## VPS discovery worker

Responsibilities:

- claims `find_matching_jobs` and browser/import/rule commands;
- searches Indeed and Dice only;
- extracts individual posting details at human speed;
- stages valid jobs as `reviewing`;
- archives deterministic hard conflicts;
- queues Mac local-AI matching.

Example VPS env values:

```env
WORKER_ID=job-discovery-vps-01
WORKER_COMMAND_TYPES=find_matching_jobs,discover_jobs_browser,import_jobs,run_rule_filter
WORKER_MAX_CONCURRENCY=1
JOB_BROWSER_DISCOVERY_ENABLED=true
JOB_BROWSER_CDP_URL=http://127.0.0.1:9222
JOB_BROWSER_CDP_MANAGE_PAGES=true
```

`JOB_BROWSER_CDP_MANAGE_PAGES=true` is restricted to a loopback CDP endpoint and
must be used only with the dedicated job-search browser profile. Before each
command, the worker creates one fresh blank tab and closes stale tabs that could
otherwise block Playwright. The command's own tab is also closed after failed,
canceled, and successful runs.

The VPS must not run Ollama or attempt application submission. It must not automate LinkedIn, bypass CAPTCHAs, or save passwords/cookies in the project.

## Mac AI worker

Responsibilities:

- claims `run_local_llm_extraction` only;
- calls loopback Ollama `qwen3.5:9b` for every viable staged job;
- validates structured evidence;
- applies deterministic match policy;
- optionally calls the remote reviewer only for uncertain jobs.

Example Mac env values:

```env
WORKER_ID=job-ai-mac-01
WORKER_COMMAND_TYPES=run_local_llm_extraction
WORKER_MAX_CONCURRENCY=1
AI_MATCH_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3.5:9b
REMOTE_AI_REVIEW_ENABLED=false
```

Keep Ollama bound to loopback. Do not place `OPENAI_API_KEY`, the Neon URL, browser cookies, or SSH keys in Git.

## Checks

```bash
npm run worker:typecheck
npm run worker:test
RUN_OLLAMA_SMOKE=true npm run worker:ollama-smoke
WORKER_ENV_FILE=/path/to/worker.env npm run worker:health
WORKER_ENV_FILE=/path/to/worker.env npm run worker:start
```

`worker/launchd/com.jobportal.ai-worker.plist.template` is a template only. Do not install it, restart the VPS service, or deploy workers until the application migration and dashboard deployment have been explicitly approved.
