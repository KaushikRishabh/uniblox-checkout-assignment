# Decisions and boundaries

## Invariants

1. Inventory never becomes negative through checkout. All order lines validate before any decrement.
2. A cart creates at most one successful order and becomes immutable afterward.
3. A successful idempotency key identifies exactly one cart/coupon intent and one order snapshot.
4. Failed checkout does not change inventory, coupons, carts, orders, milestone eligibility or retry records.
5. Every issued coupon corresponds to one distinct, reached global order milestone.
6. A coupon references at most one successful redemption order.
7. Order totals use exact integer arithmetic: `gross = sum(lines)`, `0 <= discount <= gross`, `net = gross - discount`.
8. Reports describe committed history: `grossRevenue = totalDiscounts + netRevenue` and `generated = available + redeemed`.
9. Catalogue edits cannot rewrite order snapshots; reads cannot mutate internal state.

These guarantees are scoped to a running **single Node process**. Process crashes
and restarts discard memory; the service does not claim durable exactly-once behavior.

## Decision: A synchronous in-memory transaction boundary

**Context:** Inventory, cart closure, coupon consumption, order creation and retry
records must agree when HTTP requests overlap.

**Options considered:** PostgreSQL transactions/row locks; SQLite transactions;
an async mutex around in-memory state; synchronous in-memory domain methods.

**Choice:** One `Store` instance in one Node process. Parse HTTP bodies before
entering the store. `checkout()` performs all validation and monetary calculation,
then a synchronous commit section with no await, callbacks, timers or external I/O.
Product edits and coupon generation are synchronous too.

**Why:** JavaScript call stacks are not interleaved by other request callbacks.
An async mutex would add machinery without additional protection while all state
access remains synchronous. The brief explicitly allows memory; focused HTTP races
demonstrate the guarantee instead of relying only on sequential domain tests.

**Consequences:** Good bounded demonstration, but memory loss on restart, no shared
state across instances, and synchronous report scans block the event loop as data
grows. Business failures are atomic because they happen before mutations. OOM or
process termination is outside this model; this is not a durable transaction manager.
Adding an await inside a store mutation invalidates the concurrency argument.

## Decision: Client-supplied checkout idempotency with a separate cart guard

**Context:** A client can lose the response, retry concurrently, accidentally reuse
a key, or try a different key for an already purchased cart.

**Options considered:** Treat cart ID alone as the retry key; accept an optional
key; require a key and preserve successful request fingerprints; store all failures.

**Choice:** Require `Idempotency-Key` and globally store a successful checkout
record containing `cartId`, `couponCode` and `orderId` for each key. Compare the
stored cart and coupon directly on retry. Normalize absent/null coupons to
null. Check the retry record before checking cart closure or current coupon state.
Replay returns the exact original order body; a different stored cart or coupon returns
409. A separate `cart.orderId` guard prevents a new key from checking out a closed
cart. Failure responses do not retain keys.

**Why:** Revalidating the coupon on a successful retry would reject the caller's
own already-redeemed coupon. Merely relying on unique keys would still permit
same-cart/different-key duplication. Allowing failures to be retried lets clients
repair shortages without inventing a new key.

**Consequences:** A failed key can later be used for another intent; only successful
keys are bound. Add-item requests are additive and are not idempotent: after a
timeout, inspect the cart or use PUT for an absolute quantity. Retry storage is
unbounded and non-durable in this exercise. Clients must use unique successful keys.

## Decision: Live cart pricing, no stock reservation, immutable purchased lines

**Context:** Product price, name or stock can change between adding and paying.

**Options considered:** Reserve stock and lock prices at add time; reject checkout
when a catalogue version changes; price and validate availability at checkout.

**Choice:** Open carts display current prices and availability. Adding validates
product existence and quantity bounds, but does not promise or reserve stock.
Checkout re-evaluates every line from current product data. Orders store the
purchased names, IDs, quantities, unit prices, line totals and discount calculation.
Closed-cart prices read the corresponding order snapshot.

**Why:** Reservation expiry and quote acceptance would expand the timebox. Live
prices are defensible when explicitly documented. Snapshotting gives historical
explainability after a catalogue edit.

**Consequences:** A customer can observe a different final price than at add time;
a production storefront should present a quote/confirmation protocol. Absolute
admin inventory changes serialize with checkout but can intentionally replenish
stock. Deletion of products and reservation/stock-adjustment ledgers are deferred.

## Decision: Global, explicitly generated milestone coupons

**Context:** The brief leaves coupon ownership, expiry, delayed generation and
milestone counting ambiguous.

**Options considered:** Per-customer milestones; automatically issue on checkout;
allow only the latest milestone; preserve all global unissued milestones.

**Choice:** Count successful orders globally, including discounted and zero-total
orders. Admin generation issues one coupon for the oldest unissued eligible
milestone, retaining a contiguous prefix of issued milestones. A generation race
can issue distinct eligible milestones but never duplicate one. Coupons are global,
case-sensitive bearer codes with random UUIDs, a configured integer percentage,
no expiry and no stacking. Redemption links the coupon to exactly one order.

**Why:** This follows the explicit administrative-generation requirement and avoids
losing rewards when admins wait until multiple milestones have passed. No customer
identity or authentication is required by the assignment.

**Consequences:** The nth order makes a coupon eligible for a later order; it cannot
redeem its own unissued reward. Repeated generation calls with a backlog create
different coupons; use the coupon list to recover after a lost admin response.
Public exposure would require authorization. Ownership, expiry, fraud controls,
generation idempotency keys and coupon delivery are deferred.

## Decision: Exact minor-unit strings and one order-level rounding rule

**Context:** Floating-point currency and differing rounding stages can make orders
and reports disagree, particularly at half-cent boundaries and large values.

**Options considered:** Floating-point dollars; bounded safe-integer cents; a
decimal library; BigInt minor units with explicit JSON serialization.

**Choice:** USD cents are canonical decimal strings at the API boundary and `BigInt`
inside calculations. Product prices permit up to twelve digits, quantity up to one
million. Compute `discount = (gross * percent + 50) / 100` using integer division,
once per whole order. Percentage is an integer 1–100; absent coupon means 0%.
Zero-priced products and a 100% discount are allowed. Redeeming a coupon on an
already-zero subtotal still consumes the coupon on successful checkout; the
client explicitly chose to supply it. No minimum-spend rule is implied.

**Why:** Exactness holds even when a line total exceeds Number.MAX_SAFE_INTEGER.
Integer inputs and percent bounds prove `discount <= gross`, so a negative total
cannot arise. String serialization avoids JSON's lack of a BigInt type.

**Consequences:** Clients must preserve money strings and use exact arithmetic.
Multi-currency, fractional percentages, tax, shipping, refunds and line-level
discount allocation are deferred. A new rule would require new stored calculation
inputs; existing orders would retain their original snapshots.

## Decision: Derive reporting from committed snapshots

**Context:** Independently incremented revenue and coupon counters can drift after
partial failures or retry bugs.

**Options considered:** Mutate aggregate counters during checkout; asynchronously
build reporting projections; compute reports from the source records.

**Choice:** Scan orders for purchased quantities, gross and discount totals. Net is
gross minus discounts. Read generated coupons and their redemption links for coupon
counts and code details. Include zero-purchase products and eligible unissued rewards.

**Why:** The dataset is small, scans are easy to reconcile, and reports remain pure
reads. Product edits do not change historical revenue. BigInt is also used for
monetary aggregates.

**Consequences:** O(orders + order lines + coupons) per report. At scale, use durable
ledger/projection tables with transactional updates or a replayable outbox and
periodic reconciliation; paginate detail lists. Do not run unbounded synchronous
scans on a busy event loop.

## Decision: Small typed error contract and native HTTP adapter

**Context:** Clients need to distinguish invalid input, missing resources,
availability conflicts, invalid coupons and a successful replay.

**Options considered:** Express/Fastify with schema plugins; native HTTP with a
small explicit adapter; return generic 400/500 responses for all failures.

**Choice:** Native HTTP and typed `DomainError(status, code, message, details)`.
400 is invalid input, 404 is missing resources/routes, 409 is a state conflict,
422 is an unknown coupon. Request IDs correlate all handled errors. A replay is
200 versus initial checkout's 201. Bodies are capped, unknown fields rejected,
integers validated strictly and nonempty bodies require JSON content type.

**Why:** The API is small enough to remain understandable without runtime packages.
Business error codes stay stable even if human messages evolve. Central validation
and consistent JSON responses support executable client examples.

**Consequences:** Routing/schema validation are manual. Unsupported methods return
404 rather than a dedicated 405. Native HTTP transport failures can precede the
JSON adapter. A larger API should adopt a framework and generated OpenAPI schemas.
No authentication, rate limiting or full production observability is implemented.

## Decision: Treat successful checkout as payment success

**Context:** Real payments introduce external side effects, retries and compensations.

**Options considered:** Fake asynchronous payment gateway; real payment provider;
accept the brief's successful-checkout-is-payment-success option.

**Choice:** Successful atomic order creation is payment success. There is no pretend
external charge or payment abstraction that suggests guarantees it cannot provide.

**Why:** The assignment explicitly permits this, and no external call means checkout
can remain a coherent synchronous transaction within the timebox.

**Consequences:** Production payment work needs pending orders, reservations,
provider idempotency keys, verified webhooks and an outbox/saga or compensation
model. Never simply insert `await charge()` inside this synchronous design.

## Decision: Prefer explicit steps for candidate readability

**Context:** The original implementation was compact, but chained expressions,
short private names and compressed reporting loops made the invariants harder for
a beginner to trace during review.

**Options considered:** Leave the compact code; add comments around every expression;
introduce a service/repository framework; expand the flow with descriptive names,
ordinary loops and a few focused synchronous helpers.

**Choice:** Use `#getOpenCart`, `#buildOrderLines`, `#checkInventory` and
`#getAvailableCoupon` for separate checkout steps. Keep the complete commit block
visible inside `checkout`. Compare the stored cart/coupon fields directly instead
of encoding them into a JSON fingerprint. Build report totals with ordinary loops,
and validate product edits on a local copy before replacing the stored product.
Separate JSON parsing from body collection, with flat endpoint handling and named
validated inputs. Use comments for the reasons behind ordering and arithmetic.

**Why:** A longer sequence of named steps is easier to explain than nested
operators. A new abstraction layer would add navigation rather than understanding.
Explicit code still needs the same validation and synchronous transaction boundary.

**Consequences:** More lines, fewer dense expressions. API fields, error precedence,
money rules, coupon accounting and single-process limitations remain unchanged.
The refactor keeps AI disclosure; simpler style does not imply manual authorship.
Regression assertions cover a product patch failing on its last field and closed
cart snapshot prices with current stock. Old/new HTTP comparison scenarios check
the outward contract as well as the repository's concurrency tests.

## Multiple instances and production evolution

Use PostgreSQL as the shared authority. Persist orders, order lines, carts, products,
coupons, milestone grants and idempotency records. Enforce unique `orders.cart_id`,
unique successful idempotency key and unique milestone count, plus nonnegative stock
and coupon-redemption uniqueness constraints. Store money as exact NUMERIC/integer
minor units within explicit limits.

Within one database transaction, lock/check the cart and idempotency intent, lock
product rows in a stable ID order, conditionally decrement sufficient stock, lock
or conditionally redeem the coupon, and insert the order snapshot and retry result.
Roll back the whole transaction on any conflict. Derive successful-order milestones
from a transactionally incremented order counter, **not a database sequence with
rollback gaps**. Coupon issuance locks that counter/grant state and uses a unique
milestone constraint. Handle uniqueness races by loading the winning retry result;
retry serialization failures or deadlocks with bounded backoff. HTTP responses
publish only after database commit.

Add payment orchestration separately, then auth, limits, telemetry, migrations,
pagination and retention policies. Durable idempotency retention must cover the
documented retry window; a cart uniqueness constraint remains after key expiry.

## AI assistance and ownership

Codex read the brief, selected and implemented the architecture, generated tests,
ran validation and drafted these documents. This is substantial AI-assisted work;
it is not presented as hours of manual candidate coding. No private transcripts,
credentials or customer data are included.

Two actual corrections during review: the first generated draft labeled money
fields in cents while declaring INR; the example currency was changed to USD to
make the wire contract consistent. The initially selected ESLint 9 emitted an
unsupported-version warning, so it was replaced with ESLint 10 after checking
the TypeScript ESLint peer dependency range, then the full checks were rerun.

Tests exercise real overlapping HTTP requests and exact failures rather than only
checking a happy-path CRUD sequence. Validation evidence and actual elapsed time
are recorded in WORK_LOG.md. Candidate understanding has **not** been verified by
the agent: before submission, the candidate should run the walkthrough, explain
the commit boundary, and modify a business rule without relying on this document.

After the candidate requested easier code, Codex also refactored dense expressions
into explicit steps and replaced the encoded retry fingerprint with direct intent
fields. The side-by-side comparison of 88 HTTP responses and the same concurrency
suite validated that this readability change preserved outward behavior. This work
and its additional elapsed time are disclosed in WORK_LOG.md.

## With two more hours

First replace memory with a transactional SQLite/PostgreSQL prototype and rerun the
same concurrency contract across multiple processes and restarts, including lost
response recovery. Then add randomized invariant testing against a reference
ledger, and inspect performance/retention boundaries for large reports and retry
records. Production auth and payments would remain separately scoped work.
