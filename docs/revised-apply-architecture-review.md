# Revised apply architecture review

Review of the evolve-in-place plan against the current worker (`selfDrive.ts`, `applyToJobs.ts`, `applyRunner.ts`, `session.ts`, `automation_alerts`) and against `docs/stagehand-v3-ollama-integration-plan.md`.

## Verdict

**Adopt this revision.** Evolve the existing apply engine and use Stagehand only as a fallback. Durable runs, one application per command, and JobAgent-owned submit match how the worker actually works. Do not build a second automation stack.

Change the global apply pause to a **host-scoped pause** before coding. Keep the original plan’s action-guard, fixture, and model-budget sections.

## What is already correct

| Decision | Why it fits this codebase |
| --- | --- |
| Stagehand inside `applyRunner`, not instead of it | `applyRunner` already owns matching, answers, blockers, and `submission_unknown`. `onExternalSite` is set and then ignored — that is the insertion point. |
| Durable `automation_runs` / `automation_run_items` | Dashboard `maxJobs` only limits discovery. `selfDrive` then drains every eligible unapplied job. A run row with `targetSubmissions` is the only way 50 means 50. |
| Keep level-triggered self-drive | `selfDrive.ts` already recovers from interrupted scoring/applying by reading the database. Returning to a discovery → score → apply command chain would reintroduce lost handoffs. |
| One application per `apply_to_jobs` command | The current loop aborts 49 jobs on one CAPTCHA, then requeues the whole batch. Command-scoped work matches the queue, claim, and restart model. |
| JobAgent owns the final click | `fill_only`, score gates, and sponsorship answers must not be prompt-dependent. Stagehand may point at a control; `SubmissionGuard` decides. |
| Defer Keychain until fill-only is stable | Credential plumbing is a separate security surface. Signup → human intervention is the correct first external-site policy. |

The three simplifications versus the original markdown plan are the ones to keep:

- Extend `automation_alerts` instead of creating a second intervention table.
- Use one application per worker command instead of a 50-job command loop.
- Preserve level-triggered self-drive, scoped to a durable run target.

## The one design change to insist on

`hasOpenBlockerAlert()` is crude, but it exists because the worker uses **one persistent Chrome profile** over CDP. Applying the next Indeed job while an Indeed CAPTCHA sits in another tab is how boards re-challenge or lock the session.

Continue the run — but pause applying on the **same host/session**, not on every host.

| Current: global pause | Recommended: host-scoped pause |
| --- | --- |
| Any open `automation_alerts` row stops all `apply_to_jobs` queuing. Scoring keeps running. One Indeed CAPTCHA freezes Dice too. | An open CAPTCHA/login on `indeed.com` pauses only Indeed applying. Dice and unrelated employer hosts may continue. Board-wide login still pauses that board. |
| Too coarse. That is the real operational failure. | Same Chrome profile, same cookies. Isolation is by host, not by tab. |

## Must-fix before this is implementable

### 1. Pin the Playwright page

After Apply, `applyRunner` uses `browserContext.pages()[length - 1]`. Protected human-help tabs make that the wrong page.

Pin the Playwright `Page` (and CDP target id) for the application. Never infer the active tab from `pages()`.

### 2. Pass protected targets into CDP cleanup

`prepareManagedCdpBrowser` closes all existing page targets, then keeps one blank tab.

Pass protected target ids into managed cleanup before one-command-per-job plus keep-open tabs can work.

### 3. Do not add `waiting_for_human` as a command status

`command_status` is `pending` / `claimed` / `completed` / `failed` / `canceled`.

Complete the command. Put wait state on the application and alert. A paused command status fights claim, heartbeat, and idle detection.

### 4. Ship one-job commands and host-scoped pause together

One job per command still hits `hasOpenBlockerAlert` and will not queue the next job.

Ship one-job commands, host-scoped pause, and tab protection together or the continue-the-run benefit does not appear.

## Where to simplify further

### Checkpoint lives on `applications`, not on alerts

Do not put `checkpointJson` on both `applications` and `automation_alerts`. That will drift.

`applications` already has `applyUrl`, `stopReason`, and `confirmationEvidence`. Add `browserTargetId`, `checkpointJson`, `resumeAttemptCount`, and `lastExecutionStage` there.

The alert should be a pointer: `applicationId`, `requiredAction`, `verificationAttempts`, `verifiedAt`.

### Extending `automation_alerts` is fine if it stays a notification

A second `application_interventions` table is unnecessary. Folding a full intervention state machine into alerts is also unnecessary.

- Keep `pending_questions` for field-level Q&A.
- Keep `applications` as the paused-work record.
- Keep alerts as the user-visible “something needs you” row that drives notifications, focus, and verify-and-resume.

Statuses worth adding on alerts: `open`, `verifying`, `resolved`, `skipped`, `expired`. `user_working` is implied by an open alert plus a focused tab and does not need its own durable state.

### Reuse already-scored jobs across runs

Passing `runId` through discovery/import/matching is right for attribution. The next run should first consume leftover eligible jobs that already have a score, then discover more only if the candidate pool is short. Otherwise every run of 50 re-pays the discovery CAPTCHA cost.

## Gaps the original plan still owns

This revision correctly simplifies run accounting, interventions, and command granularity. Do not drop these sections from the markdown plan — they are still required for a safe Stagehand rollout.

| Keep from original plan | Why |
| --- | --- |
| `actionGuard` + host allowlist | Stagehand can navigate. Bound it to the board host, employer host, and discovered auth hosts. Reject payment, downloads, and unrelated domains. |
| Prompt-injection rule | Treat page text as untrusted. Employer forms will contain instructions that conflict with JobAgent policy. |
| Stall definition | “If the form stalls” is the whole escalation product. Define it: unclassified required field, no DOM/URL change after a click, unsupported control, or timeout. |
| Browser fixtures | Workday/Greenhouse/iframe/shadow-DOM/CAPTCHA-recurrence fixtures are how you know `fill_only` cannot submit. |
| `verify_submission` for slot release | The command type already exists. Reserved `submission_unknown` slots need a reconciler, not only a new `verify_intervention` command. |
| Ollama model pick + memory budget | `qwen3.5:9b` vs `qwen2.5-coder:14b` on 24 GB with Chrome still running is a runtime constraint, not an architecture footnote. |

## Open product rules to write down

### Manual apply vs run target

`apply_to_jobs` currently accepts `manual: true` and skips the score gate. Decide whether a manual application consumes a run slot, lives outside the run, or is forbidden while a run is active.

### Retry across runs

`applications` has a unique `(job_id, user_id)`. A job skipped or blocked in run 1 cannot silently re-enter run 2. Define which statuses are retryable and who resets them.

### Auto-extend discovery

`selfDrive` currently treats discovery as user-triggered. Auto discovery while applying is extra Chrome time and extra CAPTCHA risk. Prefer “Stop further discovery” as the default, with an explicit allow-extend setting.

### Protected-tab ceiling

Five concurrent CAPTCHAs plus applying in a sixth tab will exhaust Chrome and humans. Cap open interventions (for example 3) and skip or expire the rest rather than accumulating tabs.

## Implementation order

| Slice | What becomes true | Risk if skipped |
| --- | --- | --- |
| 0. Repair | `decideExternalSiteApply` imported; worker type-check green; score 80 gate tested. | Stagehand work starts on a broken apply path. |
| 1. Durable run | `automation_runs` + `run_items` exist. Dashboard number is `targetSubmissions`. One active run per user. | `maxJobs` still only limits discovery. |
| 2. Apply isolation | One job per command, host-scoped pause, protected targets, pinned `Page`, exact-tab focus, verify-and-resume. | CAPTCHA still kills the run, or next apply hits the wrong tab. |
| 3. External executor | Board adapters untouched. `ExternalApplyExecutor` uses the current field engine first. | Stagehand becomes the default instead of a fallback. |
| 4. Stagehand off | Pinned 3.7.1, CDP attach, page-scoped act, `actionGuard`, flags off. Fixtures for `dry_run` and `fill_only`. | First real employer form is also the first test. |
| 5. Canary submit | 1–3 jobs, then 20, then 50. Keychain only after fill-only is boring. | Credential code and submit bugs land in the same week. |

## Net

Adopt this revision over the original markdown architecture. Change global pause to host-scoped pause, pin the Playwright page, keep checkpoints on `applications`, and do not drop the original action-guard, fixture, and model-budget sections. After that, the implementation order is the plan.
