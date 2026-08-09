# Job Portal Worker

The preferred topology uses a discovery/matching worker on the VPS and a
separate, explicitly enabled apply worker on the logged-in Mac. Only the Mac
worker may claim application or submission-verification commands.

## VPS discovery worker

Responsibilities:

- claims `find_matching_jobs` and browser/import/rule commands;
- searches Indeed and Dice only;
- extracts individual posting details at human speed;
- stages valid jobs as `reviewing`;
- archives deterministic hard conflicts;
- claims local-AI matching commands and calls the Mac Ollama endpoint.

Example VPS env values:

```env
WORKER_ID=job-discovery-vps-01
WORKER_COMMAND_TYPES=find_matching_jobs,discover_jobs_browser,import_jobs,run_rule_filter,run_local_llm_extraction
WORKER_MAX_CONCURRENCY=1
JOB_BROWSER_DISCOVERY_ENABLED=true
JOB_BROWSER_CDP_URL=http://127.0.0.1:9222
JOB_BROWSER_CDP_MANAGE_PAGES=true
OLLAMA_BASE_URL=http://100.121.70.118:11434
OLLAMA_ALLOWED_REMOTE_HOSTS=100.121.70.118
OLLAMA_MODEL=qwen3.5:9b
```

`JOB_BROWSER_CDP_MANAGE_PAGES=true` is restricted to a loopback CDP endpoint and
must be used only with the dedicated job-search browser profile. Before each
command, the worker creates one fresh blank tab and closes stale tabs that could
otherwise block Playwright. The command's own tab is also closed after failed,
canceled, and successful runs.

The remote Ollama host must be explicitly listed in
`OLLAMA_ALLOWED_REMOTE_HOSTS`; loopback remains allowed automatically. Prefer a
Tailscale IP or MagicDNS name and do not expose Ollama publicly.

The VPS must not run Ollama or attempt application submission. It must not automate LinkedIn, bypass CAPTCHAs, or save passwords/cookies in the project.

## Mac Ollama provider

Responsibilities:

- runs Ollama `qwen3.5:9b`;
- accepts requests only through the private Tailscale path;
- serves local matching requests from the VPS worker.

## Mac apply worker

Run this worker only with the dedicated logged-in browser profile. Its command
allow-list must include apply orchestration and verification, and those command
types must never be enabled on the VPS:

```env
WORKER_COMMAND_TYPES=run_apply_cycle,apply_to_jobs,verify_submission,sync_resume_text
JOB_APPLY_ENABLED=false
JOB_APPLY_MODE=dry_run
```

Keep `JOB_APPLY_ENABLED=false` until the migration, dashboard, dry-run review,
and headed fill-only rollout checks are complete. `verify_submission` only
checks for confirmation evidence; it never clicks an apply or submit control.

Do not expose Ollama publicly. Do not place `OPENAI_API_KEY`, the Neon URL,
browser cookies, or SSH keys in Git.

## Checks

```bash
npm run worker:typecheck
npm run worker:test
RUN_OLLAMA_SMOKE=true npm run worker:ollama-smoke
WORKER_ENV_FILE=/path/to/worker.env npm run worker:health
WORKER_ENV_FILE=/path/to/worker.env npm run worker:start
```

`worker/launchd/com.jobportal.ai-worker.plist.template` is a template only. Do not install it, restart the VPS service, or deploy workers until the application migration and dashboard deployment have been explicitly approved.
