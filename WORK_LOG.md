# Work log

- 2026-10-30 01:22:56 UTC: began requirement retrieval and isolated-path checks.
- Read both upstream READMEs; confirmed the backend brief takes precedence for concurrency, retries and disclosure.
- Created a fresh local repository; no existing project was edited.
- Chose TypeScript, Node's HTTP server and test runner, and a single-process in-memory store.
- 01:26 UTC: strict types, lint and nine focused domain tests passed.
- 01:27 UTC: all fifteen tests passed, including simultaneous HTTP checkout,
  idempotency, single-coupon competition and a body-stream/catalogue-update overlap.
- 01:29 UTC: executable HTTP demo passed all assertions and reconciled three orders:
  gross `14195`, discounts `1000`, net `13195` cents.
- Replaced the initial ESLint 9 choice after its unsupported-version warning;
  checked TypeScript ESLint peer support and reran types, lint, tests and demo
  successfully with ESLint 10.
- Corrected the initial currency/field-name mismatch (INR with `Cents`) to USD cents.
- 01:31 UTC: independent test-sensitivity review in temporary copies deliberately
  disabled inventory validation, idempotency lookup, coupon reuse protection and
  half-up rounding. Each corresponding focused regression test failed as expected.
  The real repo was read only during this review. The first review harness demanded
  assertion errors specifically; it was corrected to also accept the expected domain
  exception from the broken retry implementation. Temporary copies were removed.

Times record AI-assisted implementation and validation, not manual candidate work.
Candidate review and interview preparation have not yet occurred.

## Final verification

- Clean `npm ci --ignore-scripts --no-audit --no-fund` completed from the lockfile.
- Node 26.0.0: `npm run check` passed (strict types, ESLint, fifteen tests);
  `npm run demo` passed.
- Official Node 22.18.0 darwin-arm64 archive was downloaded to a temporary directory
  and verified against Node's published SHA-256 manifest. No installed runtime was changed.
- On Node 22.18.0: TypeScript no-emit check, ESLint, all fifteen tests (0 failures)
  and the demo passed. This included the final zero-subtotal coupon assertions.
- Real `src/server.ts` startup on a temporary loopback port: health and environment
  policy verified; SIGTERM exited cleanly with code 0. Invalid n=0, x=101 and fractional
  port configurations failed startup as expected. All temporary listeners were stopped.
- `git diff --check` passed. No browser/UI automation, email, submission, public
  remote, push, paid service or unrelated project modification was performed.

Implementation and validation completed by **2026-10-30 01:33:58 UTC**, approximately **11 minutes**
of elapsed AI-assisted work from the recorded start. Final local commit/report
housekeeping adds a small amount of time. This is not a claim of 4–6 hours spent
by the candidate; the brief sets a maximum timebox, not a minimum.

Known boundaries: volatile process-local storage, no multi-instance coordination,
no auth/payments, no retention/pagination, and synchronous report scans. The current
requested backend scope is implemented; candidate review and authorized submission
remain outstanding.

## Readability refactor on 2026-10-30

- Began at **01:44:18 UTC** after the candidate asked for easier-to-read Uniblox code.
- Replaced compact private names and chained expressions with descriptive helpers,
  explicit branches and ordinary loops. Checkout keeps the whole synchronous commit
  block visible; no async storage operations or external calls were introduced.
- Successful retry records now hold cart ID, coupon code and order ID directly,
  with explicit same-cart and same-coupon checks instead of a JSON-encoded fingerprint.
- Expanded product edits on a temporary copy, separated JSON parsing from stream
  collection, flattened endpoint handling and simplified demo request construction.
- Preserved API/status/error contracts, validation order, snapshot semantics, exact
  money arithmetic, milestone accounting and all original single-process limitations.
- Strengthened regressions for failure on the last field of a multi-field product
  patch and closed-cart names/prices with current available inventory.
- Node 26.0.0: `npm run check` and `npm run demo` passed.
- Node 22.18.0: strict type checking, ESLint, all 15 tests and the demo passed.
  Type checking/lint/demo were repeated after the final demo readability edit.
- Compared the original commit e699369 with the refactor in five separate HTTP
  scenarios. All **88 response contracts** matched after normalizing generated IDs
  and timestamps: cart/pricing/retries (14), delayed rewards/rounding/report reads (27),
  validation/media/path errors (13), atomic failures/repair (19), and large/zero money (15).
- The previously reported reviewer's five test scripts were not present in this
  workspace; they are not represented as rerun here. The separate five-scenario
  comparison above and the repository suite were executed in this run.
- `git diff --check` passed. No required behavior was intentionally changed.

Refactor implementation, review and validation completed by **2026-10-30 01:53:25 UTC**,
approximately **9 additional minutes** of AI-assisted elapsed work. Initial work
remains the separately recorded 11 minutes. Packaging/private saving are additional;
no part is presented as manual candidate authorship or candidate understanding.
