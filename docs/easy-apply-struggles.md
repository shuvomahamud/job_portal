# Easy Apply struggles (observed from JobAgent)

Observed from the JobAgent Mac app worker log (`~/Library/Logs/JobAgent/worker.log`), the current apply code, and the intended Easy Apply path. The worker is not started from a terminal; JobAgent launches it.

This document is the first pass: what is going wrong. Fixes come after.

## Intended Easy Apply flow

1. Self-drive queues one `apply_to_jobs` command per job (`queueNextApplicationIfIdle`).
2. Worker opens the Indeed or Dice posting in the persistent Chrome CDP browser.
3. Dice prefers the **Easy Apply** control; Indeed uses Apply / Easily Apply.
4. If the click stays on Indeed (`smartapply.indeed.com`) or Dice, the existing field engine fills the form.
5. Known answers come from the profile and answer bank. Unknown required fields become `pending_questions`.
6. Application status becomes `awaiting_answer`. You answer on `/questions`.
7. When no open questions remain for that job, status becomes `ready` and a new `apply_to_jobs` command is queued for that job only.
8. On retry, learned answers should fill those fields and the form should advance.

Easy Apply vs employer-site apply is **not stored on `jobs`**. There is no `easy_apply` column. The worker only finds out when it looks at the posting and tries the apply button. Dice explicitly prefers Easy Apply; Indeed does not filter to Easily Apply before clicking.

## What the last live run actually did

Session: 2026-08-14 ~11:30–11:45 UTC (JobAgent apply worker). Pattern: queue one job, open Chrome, pick an address and salary, then fail. Zero submissions.

### Struggle 1 — Indeed city/country combobox treated as a `<select>`

Repeated crash:

```text
locator.selectOption: Error: Element is not a <select> element
```

Two Indeed Easy Apply contact fields:

- City: `#location-fields-locality-input` — `<input role="combobox">`
- Country: a `<div role="combobox" data-value="US">`

The detector reports `role="combobox"` as `inputType: "select"`. Current `fillField.ts` is supposed to type into those controls instead of calling `selectOption`. The live log still shows `selectOption` throwing, so either that run used older worker code, or `tagName === "select"` still takes a path that calls `selectOption` a second time after the first attempt fails.

Effect: the required city stays empty, Continue does nothing, the application dies. This is the “stuck on an easy place” failure. City and country are known profile data.

Jobs observed hitting this include `0cab247c-…`, `1523e46b-…`, `165bfa2a-…`, `1e848185-…`, `1eb7dffc-…` (city) and `22739bf8-…`, `1200e9be-…`, `30b1133e-…` (country).

### Struggle 2 — A fill crash leaves the job unretryable

When `selectOption` throws, `applyToJob` catches it and writes `needs_manual` (unless it had already written `submitting`). Self-drive only picks jobs **with no application row at all**. So a combobox crash permanently removes the job from the automatic queue.

Answering questions only requeues jobs in `awaiting_answer`. These combobox failures never become questions, so answering something else will not retry them.

`filling` and `awaiting_answer` are also in `BLOCKED_RETRY_STATUSES`. A retry command for the same job returns `already_applied` unless status was moved back to `ready` / `needs_manual` / `blocked` / `failed`.

### Struggle 3 — “Failed” + “left open for a human” with reason `run_limit_reached`

After switching to one job per command, `maxJobs` is 1. Any non-submit outcome with `results.length >= 1` is labeled `run_limit_reached`. Stalls leave the tab open, but the log records `run_limit_reached` instead of `stalled`.

So the Mac notification “0 applied · 1 failed” plus “leaving the browser open” is usually a stall or fill error, not a real run-limit. CDP managed cleanup then closes those leftover tabs on the next command (`closedPageCount` 1–4), which throws away the form a person could have finished.

### Struggle 4 — Continue with unanswered required radios

`applyRunner` already documents Indeed screening questions: required radios named like `q_ba7addb345ecad`, no error, Continue inert. If those are not classified as required (or are skipped as optional), the worker clicks Continue, the page does not change, and it reports stalled / “form would not advance”.

That is the other “easy place” stall: a yes/no or years-of-experience radio the engine did not ask you about.

### Struggle 5 — Question → answer → retry can ask the same easy field again

Retry path (`pendingAnswers.ts`):

1. Learn the answer into the answer bank.
2. Close matching open questions.
3. If that job has no open questions, set application `ready` and queue `apply_to_jobs` for that job.

Ways this still sticks:

- `decideFieldAction` asks again if the saved answer does not match dropdown options (`Answer does not match available options`).
- Rule matches on non-LOW risk are asked again.
- LLM matches are never auto-filled unless `JOB_APPLY_TRUST_LLM_ANSWERS` is on.
- Sensitive categories need an exact saved answer.
- Combobox fill still throws before the learned city answer can be typed.

So you can answer “city = Hoboken” and the next attempt still dies on `selectOption`, or asks the same field because the option list is “Hoboken, NJ” vs “Hoboken”.

### Struggle 6 — Dice Easy Apply vs Apply Now

Dice’s adapter waits 8s for **Easy Apply**, then falls back to **Apply Now** (employer site). Apply Now is the external path, score-gated, and currently much more likely to skip or stall. If Easy Apply renders late, or the label is not exact `easy apply` text, Dice jobs leave the platform.

### Struggle 7 — Host blockers and login walls

Earlier the same log:

- Indeed blocked the discovery/apply browser (CAPTCHA / “needs human attention”).
- Dice required login again.

Host-scoped pause now exists in `selfDrive` (`getBlockedSources`). An Indeed CAPTCHA should not freeze Dice. A false-positive blocker still pauses that board until verified.

### Struggle 8 — Self-drive never retries failed Easy Apply jobs

`getEligibleUnappliedJobIds` is “match score + no application row”. After the 11:30 UTC burst, those Indeed Easy Apply jobs have application rows in `needs_manual` / `failed`. The worker will skip them forever and keep picking fresh matches, which then hit the same combobox.

That is why it looks like it “applies to all the jobs” but never finishes Easy Apply: it burns each posting once on city/country, then moves on.

### Struggle 9 — Dismissing a question leaves the job dead

`dismissPendingQuestion` marks the question dismissed and does not set the application to `ready` or queue `apply_to_jobs`. Status stays `awaiting_answer`, which is blocked from claim and is not safe-retryable. The job sits until someone changes the row by hand.

### Struggle 10 — Prefill is ignored, so Easy Apply asks for fields already on the page

`decideFieldAction` never looks at `field.currentValue`. Indeed often pre-fills name, email, phone, and city from the logged-in account. If the answer bank does not match that value at high confidence, the worker still `ask`s. That is the “stuck on easy places after I already filled / the site already filled it” loop.

`needs_answers` also **closes the browser**. Retry always starts from the job URL, so any in-form progress is thrown away even when you answered correctly.

### Struggle 11 — Answer-retry still requires a `match` score

The requeue after answering sends `{ jobIds: [jobId] }` without `manual: true`. If that posting is no longer `match` against the active role, retry becomes `needs_manual` instead of applying.

## Easy Apply is not in the database

`jobs` has title, company, source, URL, location, etc. No apply-method flag.

To restrict or prefer Easy Apply we would have to:

- add a column and set it during discovery, or
- detect it at apply time and skip/record `external_ats` without consuming the job as failed.

Until that exists, “tweak the database for all the easy apply” can only mean: reset retryable Indeed/Dice application rows so the worker tries those postings again, and leave employer-site skips as `needs_manual`. That is a data change, not a filter that already exists.

## Live run after this document (2026-08-15 ~03:45 UTC)

JobAgent was already **Running** (`fill_and_submit`) when this note was written. Start Agent was not clicked again.

The worker immediately queued applications and failed them in about one second after choosing an address and salary:

- `db2b918b-…` Remote US, Latham address, $143/hr → `0 applied · 1 failed`, tab left open, logged as `run_limit_reached`
- `f617d7c3-…` same pattern; CDP then closed 3 leftover pages (`closedPageCount: 3`)

No `selectOption` stack trace on these two, which means they are likely stalling on Continue / missing Easy Apply control, or returning `stalled` which `applyToJobs.ts` counts as **failed**. The next command still destroys the “left open for a human” tabs.

## What to watch on the next Start Agent run

1. Does `selectOption: Element is not a <select> element` still appear? If yes, the combobox fill path is still wrong in the running worker.
2. Do applications stop in `awaiting_answer` with city/country/name questions, or in `needs_manual` with a Playwright error?
3. After answering one question, does that job get a new `apply_to_jobs` command, or sit in `awaiting_answer` / `filling`?
4. Does CDP cleanup close a tab that was left open for a stall (`closedPageCount` > 0 immediately after a failed apply)?
5. Dice: does the log show Easy Apply clicked, or a jump to an employer host?

## Code map

| Step | File |
| --- | --- |
| Queue next job | `worker/src/selfDrive.ts`, `worker/src/db.ts` (`getEligibleUnappliedJobIds`) |
| One-job command | `worker/src/handlers/applyToJobs.ts` |
| Fill + ask + submit | `worker/src/apply/applyRunner.ts` |
| Indeed / Dice buttons | `worker/src/apply/applySteps.ts` |
| Combobox vs select | `worker/src/apply/fillField.ts`, `worker/src/formfill/domDetector.ts` |
| Ask vs fill policy | `worker/src/apply/applyPolicy.ts` |
| Answer and requeue | `src/services/pendingAnswers.ts` |
| JobAgent start | `mac-app/JobAgent.swift` (`Start Agent`) |
| Live log | `~/Library/Logs/JobAgent/worker.log` |
