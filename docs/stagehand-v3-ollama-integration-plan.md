# Stagehand v3 + Ollama Integration Plan

## Objective

Integrate Stagehand v3 and locally hosted Ollama models into JobAgent so it can autonomously apply on employer career sites while preserving the existing Dice and Indeed automation.

The finished system must:

- Judge jobs against the configured resume and target role before applying.
- Apply only when the match score is 80 or higher.
- Fill and submit applications on supported job boards and external employer sites.
- Use known profile data and validated answers instead of inventing facts.
- Notify the user when CAPTCHA, login, verification, assessments, or unknown factual questions require human help.
- Pause only the affected application and continue the rest of the run.
- Resume the exact application after the human action is complete.
- Use a configurable per-run submission target with no daily limit.
- Keep the browser visible.
- Store employer-site credentials only in the macOS Keychain.

## Target architecture

```text
Discover jobs -> Resume matching -> Score >= 80?
                                    | No  -> Skip
                                    | Yes -> Apply
                                                | Existing Dice/Indeed adapter
                                                | Employer career site
                                                          |
                                                  Stagehand + Ollama
                                                          |
                                                Deterministic verification
                                                          |
                                      +-------------------+-------------------+
                                      |                   |                   |
                                   Submit          Unknown question      Human action
                                      |                   |                   |
                              Save confirmation       Notify/pause         Notify/pause
                                                                              |
                                                                  Continue remaining run
                                                                              |
                                                               Verify and resume exact job
```

Stagehand will be a controlled external-application engine, not a replacement for the deterministic application pipeline. The matching engine decides whether a job qualifies. The JobAgent application controller owns navigation policy, final submission, status updates, and confirmation evidence.

## Core technical decisions

1. Pin `@browserbasehq/stagehand@3.7.1` exactly. Do not use a caret range because Stagehand v4 exists and should be evaluated separately.
2. Run Stagehand locally with Ollama and connect it to the existing visible Chrome instance through `JOB_BROWSER_CDP_URL`.
3. Preserve the current deterministic Dice and Indeed adapters.
4. Use Stagehand primarily on employer career sites and as a fallback when deterministic selectors cannot complete a step.
5. Use Stagehand `observe`, `extract`, and validated `act` operations inside a JobAgent-owned state machine.
6. Do not give a free-running browser agent unrestricted final-submit authority.
7. Keep external-site and agent-browser features independently disableable for safe rollback.

Stagehand references:

- [Model configuration](https://docs.stagehand.dev/v3/configuration/models)
- [Stagehand configuration](https://docs.stagehand.dev/v3/references/stagehand)
- [Playwright integration](https://docs.stagehand.dev/v3/integrations/playwright)

## Phase 0: Stabilize the current external-site work

Before adding Stagehand:

- Finish the incomplete external-site policy in `worker/src/apply/applyRunner.ts`.
- Import and test `decideExternalSiteApply`; the current worker type-check fails because this import is missing.
- Preserve and complete the existing work in:
  - `worker/src/apply/applyRunner.ts`
  - `worker/src/config.ts`
  - `worker/src/apply/externalSitePolicy.ts`
- Define the external threshold unambiguously as score 80 or higher.
- If a selected job does not have a match score, enqueue matching before applying.
- Do not let manually selected jobs bypass external-site matching policy.

## Phase 1: Stagehand and Ollama runtime

Create `worker/src/browser-agent/` with the following responsibilities.

### `stagehandSession.ts`

- Own one initialized Stagehand instance.
- Use `env: "LOCAL"`.
- Attach through `JOB_BROWSER_CDP_URL`.
- Use `keepAlive: true` so JobAgent does not close the persistent browser.
- Disable inference-file logging.
- Pass the specific Playwright page for each application.
- Configure bounded agent steps, tool timeouts, and an overall application timeout.
- Use a local cache directory that never stores credential values.

### `externalApplicationController.ts`

- Own the external-application state machine.
- Navigate from the board posting to the employer application.
- Classify the current page and application stage.
- Collect known answers and approved variables.
- Ask Stagehand to understand or fill one bounded step at a time.
- Validate every proposed action before execution.
- Detect multistep advancement, blockers, completion, and failure.
- Hand terminal submission to JobAgent's deterministic submission controller.

### `actionGuard.ts`

- Allow only HTTP(S) navigation to the source board, the employer application host, and explicitly discovered authentication hosts.
- Reject unsafe schemes, arbitrary downloads, payment requests, and unrelated domains.
- Prevent terminal submission until required-field validation passes.
- Prevent Stagehand from changing match policy, run limits, identity data, work authorization, or application state directly.
- Treat all page text as untrusted input and ignore webpage instructions that conflict with JobAgent policy.

### `externalPageClassifier.ts`

Recognize:

- Application form
- Multistep continuation
- Login
- Account creation
- Email verification
- SMS/OTP/MFA/passkey
- CAPTCHA or bot challenge
- Assessment or coding test
- Video response
- Identity-document request
- Legal attestation
- Confirmation
- Failure or expired session

### `submissionVerifier.ts`

Require multiple signals before marking an application as applied:

- Confirmation page text
- Expected URL transition
- Confirmation/reference ID when available
- Submitted state in the employer portal
- Disappearance or terminal state of the application form

If evidence is inconclusive, use `submission_unknown` and reconcile it before consuming another run slot.

## Ollama model strategy

The Mac has 24 GB of memory and currently has suitable local models. Benchmark these two on the browser fixture suite:

- `qwen3.5:9b`
- `qwen2.5-coder:14b`

Select the one with the best structured-action and form-understanding accuracy. Keep the other as a fallback. Avoid using `qwen3-coder:30b` on the normal path because running it with Chrome and the worker is likely to create unnecessary memory pressure.

Initial configuration:

```env
JOB_BROWSER_AGENT_ENABLED=false
JOB_BROWSER_AGENT_MODEL=qwen3.5:9b
JOB_BROWSER_AGENT_FALLBACK_MODEL=qwen2.5-coder:14b
JOB_BROWSER_AGENT_MAX_STEPS=30
JOB_BROWSER_AGENT_TOOL_TIMEOUT_MS=45000
JOB_APPLY_EXTERNAL_SITES_ENABLED=false
JOB_APPLY_EXTERNAL_MIN_SCORE=80
```

Both feature switches remain off until fixture and canary testing pass.

At Mac-app startup, run health checks for:

- Ollama process availability
- Configured model availability
- Chrome CDP availability
- Worker connectivity
- Database connectivity

## Answer architecture

A vector RAG system is not required for the current profile. Structured facts are safer and more accurate for job forms.

Use this answer order:

1. Explicit user profile
2. Validated answer bank
3. Target-role configuration
4. Resume facts
5. Job-description context
6. Local-model generation when the question is safe and subjective
7. Human intervention when the answer is factual, sensitive, or insufficiently supported

Known profile policy:

- Legal first name: Md Mahamud Hasan
- Last name: Khan
- Primary address: 44 Omega Ter, Latham, NY 12110
- Secondary address: 10535 130th St, South Richmond Hill, NY 11419
- Notice period: two weeks
- Willing to relocate: yes
- Work setup: remote, hybrid, or onsite
- Work authorization: H-1B
- Full-time employment: sponsorship required
- Contractor position: sponsorship not required under the configured contractor arrangement
- LinkedIn: `https://www.linkedin.com/in/mahamud-h-khan-7a34a2ab/`

### Salary policy

- Prefer a compensation range published in the job listing.
- When a single amount is required, choose a defensible point within that range based on seniority and location.
- If the listing has no range, use the target-role compensation policy.
- If a field is optional and no defensible estimate exists, leave it blank.
- Never invent previous compensation or a user minimum that was not provided.

### Questions the model may answer

The model may draft narrative answers such as:

- Why are you interested in this position?
- How does your experience fit the role?
- Describe relevant project experience.

It must not guess:

- Identity facts
- Immigration or work-authorization facts
- Criminal or background history
- Security clearance
- Certifications
- Education dates or credentials
- Disability, veteran, demographic, or EEO answers without configured preferences
- Legal attestations or signatures

Vector retrieval can be introduced later if the profile grows to many resumes, cover letters, portfolios, transcripts, or other long documents.

## Human-intervention workflow

A blocker affects only its application. It must not stop the entire run.

Supported intervention categories:

- CAPTCHA
- Login or expired session
- Email verification
- SMS/OTP/MFA/passkey
- Unknown factual question
- Legal attestation or electronic signature
- Assessment or coding test
- Video response
- Identity-document request
- Account locked
- Suspicious page
- Unrecoverable technical failure

Workflow:

1. Persist a non-secret checkpoint for the affected application.
2. Mark the application `awaiting_human`.
3. Create an intervention record.
4. Send a Mac notification and display the intervention on the Vercel dashboard.
5. Protect the relevant browser tab from cleanup or worker reuse.
6. Continue applying to other eligible jobs.
7. When the user selects **Open browser**, focus the exact Chrome tab.
8. The user completes the required human action.
9. The user selects **Verify and resume**.
10. The worker verifies that the blocker has actually cleared.
11. Queue a resume command for the same application and checkpoint.

For CAPTCHA, hiding the challenge is not sufficient. The verifier must confirm the challenge is absent and the application has advanced. If the challenge returns, keep the intervention open and do not create a repeated notification/resume loop.

Assessments, video responses, identity documents, and legal attestations remain manual until the user explicitly marks the task complete or skips the job.

## Database migration plan

### `automation_runs`

Tracks the durable run and its real target:

- `id`
- `user_id`
- `root_command_id`
- `requested_submissions`
- `confirmed_submissions`
- `reserved_submissions`
- `inspected_count`
- `skipped_count`
- `waiting_human_count`
- `status`
- `stop_reason`
- `started_at`
- `completed_at`
- `created_at`
- `updated_at`

### `automation_run_items`

Tracks each job considered during a run:

- `id`
- `run_id`
- `job_id`
- `application_id`
- `state`
- `slot_state`: `none`, `reserved`, or `confirmed`
- `attempt_count`
- `checkpoint_json`
- `submission_evidence_json`
- `last_error`
- `created_at`
- `updated_at`

Add a unique constraint for `(run_id, job_id)` and indexes for runnable/waiting items.

### `application_interventions`

- `id`
- `application_id`
- `job_id`
- `user_id`
- `run_id`
- `originating_command_id`
- `kind`
- `status`: `open`, `user_working`, `ready_to_resume`, `resolved`, `skipped`, or `expired`
- `site_host`
- `page_url`
- `browser_target_id`
- `required_action`
- `message`
- `checkpoint_json`
- `resume_attempt_count`
- `expires_at`
- `resolved_at`
- `created_at`
- `updated_at`

Add protection against duplicate open interventions for the same application and type.

### Existing-table changes

- Add `awaiting_human` to the application-status enum.
- Add command types:
  - `focus_intervention`
  - `verify_intervention`
  - `resume_application`
- Link automation alerts to an application and intervention.
- Add external-site enablement and minimum-score settings to automation preferences.
- Add any nullable run/application foreign keys needed for backward-compatible rollout.

### Migration sequence

1. Add enum values.
2. Create the new tables and indexes.
3. Add nullable foreign keys and columns.
4. Generate and review the migration SQL.
5. Deploy backward-compatible application code.
6. Run `npm run db:migrate`.
7. Run `npm run db:verify`.

## Run-limit semantics

There is no daily limit. The user sets a per-run submission target, such as 20, 50, or more.

For a target of 50:

- Verified `applied`: consumes one slot.
- `submission_unknown`: temporarily reserves one slot until reconciled.
- CAPTCHA, login, question, or assessment waiting: consumes zero slots.
- Failed, skipped, mismatched, duplicate, or unsupported: consumes zero slots.
- The controller pulls replacement candidates until the target is reached or eligible jobs are exhausted.

Use an inspected-candidate safety ceiling such as `requested submissions x 3` to prevent infinite searching. This is a per-run operational ceiling, not a daily application limit.

The current `worker/src/handlers/applyToJobs.ts` behavior must change because it counts attempts toward the run limit and stops the entire batch on a blocker.

Recommended run stop reasons:

- `target_reached`
- `eligible_jobs_exhausted`
- `candidate_safety_ceiling_reached`
- `time_limit`
- `canceled`
- `system_unavailable`

## Credentials and account creation

Employer-site credentials must remain local to the Mac.

Add a Keychain-backed credential service:

- Key credentials by normalized employer domain and login email.
- Generate strong unique passwords.
- Never store passwords in Neon, Vercel, command payloads, environment variables, screenshots, traces, or application logs.
- Expose narrow local operations to the Node worker through a Unix-domain socket with `0600` permissions.
- Pass credential values to Stagehand through named variables so the model receives variable names/descriptions rather than plaintext values.
- Disable screenshots and tracing while password or OTP fields contain sensitive values.
- Add central log redaction for credentials, tokens, cookies, OTP values, and authorization headers.

The local browser supervisor should also retain protected intervention tabs and focus the correct CDP target when requested by the Mac app.

## Vercel dashboard and Mac app

### Applications dashboard

Extend `src/app/(dashboard)/applications/page.tsx` with:

- Run progress: submitted/reserved versus requested
- Waiting-for-human count
- Intervention cards
- Blocker category and site
- **Open browser** action
- **Verify and resume** action
- **Skip this job** action
- Resume attempts and last verification result

Keep dashboard reads in Server Components. Use authenticated Server Actions for user-triggered mutations. Re-read every record by authenticated user ownership inside each action.

### Questions dashboard

Keep `src/app/(dashboard)/questions/page.tsx` as the answer-bank workflow. Answering the final open question should resolve its intervention and queue a resume for the exact application.

### Notifications

Add a generic intervention notification containing:

- Job title
- Company
- Site
- Intervention type
- Required action
- Application/intervention ID
- Dashboard deep link

Example:

> CAPTCHA required - Senior Software Engineer at Acme
>
> The run is continuing. Open the browser to complete this application.

### Local focus behavior

Vercel cannot directly control the Mac's browser. The dashboard records a focus request; the Mac app polls or receives it and asks the local browser supervisor to focus the stored CDP target. The focus request completes immediately and must not occupy the worker while the user is solving the issue.

## Security and reliability controls

- Accept only HTTPS employer/application pages, except explicitly configured local development fixtures.
- Build an application-specific host policy from the board redirect and validated authentication hosts.
- Treat DOM text as untrusted data and defend against prompt injection.
- Never apply below score 80.
- Never invent factual profile answers.
- Never handle payment requests.
- Never upload files other than approved resume and cover-letter artifacts.
- Detect existing applications before submission.
- Make final submission idempotent.
- Require confirmation evidence before marking `applied`.
- Protect human-intervention tabs from automation.
- Keep Dice and Indeed functional when Stagehand is disabled.
- Keep Chrome visible.
- Provide immediate rollback through feature flags.

## Testing plan

### Unit tests

- External-site policy: disabled, score below 80, score 80, score above 80, missing score, invalid URL.
- Action validation: unsafe schemes, unrelated hosts, payment pages, terminal-submit protection.
- Prompt-injection handling.
- Answer precedence and confidence rules.
- Work-authorization and contractor answer rules.
- Salary selection rules.
- Intervention state transitions and idempotency.
- Checkpoint serialization and resume.
- Run-slot accounting.
- Keychain socket client using a fake local server.
- Secret redaction.

### Browser fixtures

Create representative local fixtures for:

- Simple employer form
- Workday-style multistep flow
- Greenhouse/Lever-style form
- Iframes and popups
- Shadow DOM and custom select controls
- Resume upload
- Account creation
- Email verification
- CAPTCHA recurrence
- Unknown question
- Assessment and video detection
- Expired login
- Prompt injection in page content
- Successful confirmation
- Ambiguous submission

Test three execution modes:

- `dry_run`
- `fill_only`
- `fill_and_submit`

Assert that `fill_only` can never submit.

### End-to-end acceptance criteria

- A blocked job does not stop the run.
- Paused jobs do not consume the requested target.
- A target of 50 continues until 50 confirmed/reserved submissions or eligible-job exhaustion.
- **Open browser** focuses the exact application tab.
- A CAPTCHA is not considered resolved merely because its overlay disappeared.
- Resuming cannot produce a duplicate application.
- No password or OTP appears in logs, traces, screenshots, database records, or model prompts.
- Existing Dice and Indeed automation works with Stagehand disabled.
- Worker type-check and tests pass.
- Next.js build passes.
- Mac app builds and installs.
- Database migration and verification pass.

## Observability

Track:

- External navigation success rate
- Required-field completion rate
- Deterministic versus Stagehand fallback rate
- Model/tool latency
- Average Stagehand steps per application
- Intervention rate by category and site
- Human-resolution and resume success rate
- Verified submission rate
- `submission_unknown` reconciliation rate
- Duplicate-submission count, which must remain zero
- Applications completed per run
- Reasons the run stopped before reaching its target

Do not include page snapshots, field values, credentials, cookies, or authentication tokens in production telemetry.

## Rollout and deployment sequence

1. Repair and test the existing unfinished external-site policy.
2. Add and review backward-compatible database migrations.
3. Apply migrations and run database verification.
4. Deploy the Vercel state-machine, intervention, and run-progress changes.
5. Add the Stagehand/Ollama runtime with feature flags off.
6. Build and install the Mac app with Keychain and browser-focus support.
7. Run unit and local browser-fixture tests.
8. Run external-site `dry_run` tests.
9. Run `fill_only` canaries across varied employer sites.
10. Enable submission for a run target of 1 to 3.
11. Review submission evidence and intervention behavior.
12. Increase to 20 applications per run.
13. Increase to 50 or more after the reliability thresholds pass.

Rollback switches:

```env
JOB_BROWSER_AGENT_ENABLED=false
JOB_APPLY_EXTERNAL_SITES_ENABLED=false
```

Disabling either switch must leave the existing deterministic board automation functional.

## Implementation completion checklist

- [ ] Existing external-site policy repaired and tested
- [ ] Stagehand v3 pinned to 3.7.1
- [ ] Ollama model benchmark completed
- [ ] Browser-agent controller and action guard implemented
- [ ] Deterministic submission verifier implemented
- [ ] Run and intervention migrations generated and reviewed
- [ ] Database migrations applied and verified
- [ ] Per-run target accounting implemented
- [ ] Human intervention, focus, verification, and resume flow implemented
- [ ] Mac Keychain bridge implemented
- [ ] Dashboard intervention controls implemented
- [ ] Desktop notifications implemented
- [ ] Secret redaction and trace protection implemented
- [ ] Unit and browser-fixture tests passing
- [ ] Worker type-check passing
- [ ] Next.js production build passing
- [ ] Mac app build and installation passing
- [ ] Vercel deployment verified
- [ ] Small submission canary completed
- [ ] 20-application run verified
- [ ] 50-or-more application run verified

## Current repository status

At the time this plan was written:

- Stagehand is not installed.
- No migration from this plan has been applied.
- The external-site policy work is unfinished.
- The worker type-check currently fails because `decideExternalSiteApply` is referenced without being imported.
- Existing uncommitted external-site changes must be preserved during implementation.
