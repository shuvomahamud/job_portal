You are implementing a bounded upgrade in `/home/shuvo/project/job_portal`.

Read `docs/h1b-contract-fit-implementation-plan.md` first and implement the immediate scope only.

Context and hard constraints:
- User wants discovered jobs to be useful for applying, not just random Indeed links.
- The dashboard must preserve/show real source links.
- Jobs must be enriched and scored for user profile fit plus H-1B transfer / contract likelihood before applying.
- No applying/submitting/clicking submit.
- Browser workflow is for a 4GB VPS/local browser: one page/tab only; no 20-tab behavior.
- Use deterministic extraction/rules first; do not add LLM/API dependencies.
- Preserve existing command names and DB shape if possible.
- There are already local edits in `worker/src/search/browserDiscovery.ts` and `worker/tests/browserDiscovery.test.ts` that fix HTML entity decoding and metadata title/company extraction; keep or improve them, do not revert them.

Implement:
1. Add pure job detail extraction helpers/tests:
   - Prefer `worker/src/search/jobDetailExtraction.ts` and `worker/tests/jobDetailExtraction.test.ts`.
   - Extract JSON-LD JobPosting when present.
   - Extract Indeed URL metadata (`ti`, `cmp`) after decoding HTML entities.
   - Strip/summarize HTML text safely.
   - Return safe partial normalized job data without throwing on bad/missing data.
2. Integrate enrichment into `discover_jobs_browser` conservatively:
   - Search page finds URLs.
   - Reuse the same page to visit found job detail URLs one at a time.
   - Extract/enrich details when possible.
   - Still save the URL if extraction fails.
   - Keep command cancellation/time limit/quota behavior.
   - Do not create more tabs.
3. Strengthen `worker/src/rules/ruleEngine.ts`:
   - Contract/vendor/staffing + .NET/support should be elevated.
   - Full-time .NET with unknown sponsorship should generally be `needs_review`, not blindly `ready_to_apply`.
   - No sponsorship, USC/GC only, citizen-only, clearance-required should skip/archived even when .NET matches.
   - Add concise notes explaining H-1B/contract decision.
   - Use existing output shape/DB fields; store any new detail in notes/visaNotes/matched rules if schema does not have a direct field.
4. Add/extend tests:
   - job detail extraction tests.
   - rule engine tests for contract/vendor likely fit, full-time unknown sponsorship, and no-sponsorship/citizen/clearance negatives.
5. Update worker README with the new discovery -> enrichment -> rule filter flow and apply gate.

Run and fix until these pass:
- `npm run worker:typecheck`
- `npm run worker:test`

If possible also run:
- `npm run lint`
- `npm run typecheck`

Final response should list changed files and test output summary. Do not commit.
