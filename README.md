# Checkout and rewards

A TypeScript HTTP backend for the Uniblox checkout and rewards assignment.
No runtime packages, credentials, frontend, or payment services are required.

## Run

Use Node.js **22.18.0 or later** (native TypeScript stripping). No compilation step is needed.
All dependencies are development tools. The HTTP service and tests use Node built-ins.

```sh
npm ci --ignore-scripts
npm run check       # strict TypeScript, ESLint, then unit + HTTP concurrency tests
npm run demo        # isolated HTTP example with assertions; exits afterward
npm start          # http://127.0.0.1:3000
```

`npm start`, `npm test`, and `npm run demo` also work without installing packages;
the install is needed for type checking and linting. Start a single process only.
Memory is reset to seed data on every restart. Do not use Node cluster, PM2 cluster,
multiple containers or multiple workers with this storage implementation.

| Environment variable | Default | Accepted values |
| --- | --- | --- |
| `PORT` | `3000` | Integer 1–65535 |
| `HOST` | `127.0.0.1` | Bind address |
| `REWARD_EVERY_N` | `5` | Integer 1–1000000 |
| `DISCOUNT_PERCENT` | `10` | Integer 1–100 |

```sh
REWARD_EVERY_N=2 DISCOUNT_PERCENT=10 PORT=3001 npm start
```

Authentication is omitted as permitted by the brief. Every `/admin/*` endpoint is
an administrative operation; protect these before exposing the service publicly.

## Behavior

- Adding to a cart does **not reserve inventory**. Out-of-stock products may appear
  in a cart; checkout validates stock for every line and fails atomically on shortage.
- Open cart views and checkout use the current product price and name. Checkout does
  not promise the price originally seen at add time. Orders snapshot line names,
  prices, quantities, discount percentage, coupon code and totals permanently for
  the life of the process. Checked-out cart prices match its order snapshot.
- Every monetary field ends in `Cents` and is an **integer decimal string in USD
  cents**, e.g. `"1299"` means $12.99. Arithmetic uses `BigInt`; clients should not
  convert large totals to JavaScript `Number`. Discounts round once per order,
  nearest cent with half-cent ties rounded up.
- Checkout requires `Idempotency-Key`. A successful key is globally bound to its
  cart and normalized coupon (`null` and omitted are equivalent). Repeating that
  request returns the same order body with HTTP 200 and `Idempotency-Replayed: true`.
  A changed cart/coupon with the same successful key returns 409. A different key
  for a closed cart returns 409. Failed requests do not retain keys, so a repaired
  cart can be retried. Keys and orders survive only until process restart.
- Successful orders, including discounted or zero-total orders, count toward global
  milestones `n, 2n, 3n...`. Failed attempts and retries do not count. An admin call
  generates **one coupon for the oldest unissued eligible milestone**. Delayed
  milestones accumulate. Coupons are global bearer codes, case-sensitive, do not
  expire and cannot be stacked. Their only limit is one successful redemption.
  Supplying a coupon for a zero-priced cart still redeems it on successful checkout.
  The order earning a milestone cannot use that milestone's not-yet-generated coupon.
- Repeating coupon generation with a backlog issues the next milestone, so this
  operation intentionally does not have checkout-style idempotency. Inspect
  `GET /admin/coupons` after a lost generation response. Generation never duplicates
  a milestone, even when concurrent admin requests compete for it.
- Product edits set absolute current price/inventory values. They serialize with
  checkout; use `/admin/products/:id` to demonstrate price and availability changes.
- Reports derive solely from committed order snapshots and issued coupons; they
  reconcile gross = discounts + net and never change state.

## API and examples

See [API.md](API.md) for every route, request/response shape, status and error.
`npm run demo` is an executable API client example with an isolated fresh service.
It proves retry behavior, milestone generation, coupon rounding and failure handling.
For an already running default service:

```sh
curl http://127.0.0.1:3000/products
curl -i -X POST http://127.0.0.1:3000/carts
# Replace CART_ID with the id returned above.
curl -X POST http://127.0.0.1:3000/carts/CART_ID/items \
  -H 'Content-Type: application/json' -d '{"productId":"pen","quantity":2}'
curl -i -X POST http://127.0.0.1:3000/carts/CART_ID/checkout \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: example-1' -d '{}'
# Repeat the exact checkout command to observe 200 and the same order.
curl http://127.0.0.1:3000/admin/reports/summary
```

## Seed data

| Product ID | Name | Unit price, cents | Inventory |
| --- | --- | ---: | ---: |
| `notebook` | Notebook | 1299 | 100 |
| `pen` | Pen | 199 | 200 |
| `mug` | Coffee mug | 1599 | 30 |
| `bag` | Canvas bag | 2499 | 20 |
| `limited-print` | Limited edition print | 9999 | **1** |

## Verification and review

The automated suite targets overselling, same-key retries, same-cart different-key
races, competing coupon generation/redemption, failed-checkout rollback, delayed
milestones, live catalogue changes, immutable order snapshots, validation, exact
money above JavaScript's safe integer range and report reconciliation.

```sh
npm test
node --test --test-name-pattern='simultaneous|overlapping|concurrent' test/http.test.ts
```

Read [DECISIONS.md](DECISIONS.md) for invariants, alternatives and production scaling;
[WALKTHROUGH.md](WALKTHROUGH.md) for an interview guide; and
[WORK_LOG.md](WORK_LOG.md) for actual elapsed work and validation evidence.
The implementation was created with Codex assistance. Candidate review and the
ability to explain and modify it remain necessary before submission.

Deliberately deferred: durable persistence, real payment orchestration, auth,
multi-instance coordination, pagination/retention and production operations.

The current `be/README.md` and root README were read on 2026-10-30.
Requirements source: https://github.com/neustackapp/assignment/tree/main/be
Source revision: `589169931fc546aada470fbcb6f683b98052b947`.

No remote has been created and no submission has been sent.
