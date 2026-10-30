# Interview walkthrough

Start with `npm run check` and `npm run demo`. The demo runs a fresh ephemeral HTTP
service and exits; it does not share state with `npm start`.

## Explain the design in two minutes

`src/http.ts` parses and validates HTTP requests before calling `src/store.ts`.
The store owns private Maps and returns detached snapshots. Checkout is one
synchronous JavaScript operation: it checks a successful retry record, checks
the cart, validates every inventory line and coupon, computes exact totals,
then publishes all state changes before another request callback can run.
This protects one process only. A database transaction replaces that boundary
when instances need shared state or restart recovery.

The order is the purchased snapshot. The cart is an editable intent until its
`orderId` is set. A coupon is a milestone grant with a single optional redemption
link. Reports derive from these records, not separately incremented money counters.

## Trace the simpler implementation

1. In `http.ts`, find the checkout route. It awaits body completion before entering
   the store. The key comes from a header, the optional coupon from JSON.
2. In `Store.checkout`, find `previousCheckout`, `sameCart` and `sameCoupon`. The
   stored cart/coupon fields directly identify the original request. A successful
   retry returns before
   checking the cart or coupon again. Explain why reversing that order breaks
   retries for a closed cart and a redeemed coupon.
3. Find `#getOpenCart`, `#checkInventory` and `#getAvailableCoupon`. No state has changed
   if any of these throws. A shortage in the last line cannot consume earlier lines.
4. Find `calculateDiscountCents`. It first multiplies gross cents by the percentage,
   then adds 50 before dividing by 100. Example: five cents at 10%
   is half a cent, rounded up to one cent. A 100% coupon produces zero net.
5. Find the `Atomic commit starts here` comment and all five mutations: inventory,
   coupon, cart, order,
   retry record. Explain why adding external I/O here would require a redesign.

For the surrounding code, `cart()` uses an explicit open/closed branch,
`updateProduct()` edits a copy and saves it only after validation, and `report()`
uses ordinary loops with named totals. `requireInteger`, `requireText` and
`requirePriceCents` reject invalid inputs. None of these readability changes remove
the original safeguards or make the AI-assisted work manually authored.

## Predict the race outcomes

| Scenario | Expected outcome |
| --- | --- |
| 30 carts buy the last print | One 201 order; 29 inventory conflicts; stock zero |
| 40 checkouts, same cart and key | One 201; 39 replays with 200 and identical order bodies |
| Same cart, 20 distinct keys | One order; 19 closed-cart conflicts |
| Same successful key, changed coupon/cart | 409 idempotency conflict |
| 20 carts use one available coupon | One discounted order; 19 coupon conflicts |
| Valid coupon, insufficient stock | No redemption/order/stock mutation; repair and retry allowed |
| One milestone eligible, 20 generation calls | One issued code; 19 no-eligible-milestone errors |
| Two old milestones are eligible | Two generation calls issue distinct milestones, oldest first |
| Admin changes a price after checkout | Product changes; existing order totals remain the same |
| Process restarts after a lost response | Memory and retry records are lost; no durability guarantee |

Find the corresponding tests in `test/http.test.ts` and `test/store.test.ts`.
The streamed-body test updates inventory while a checkout body is incomplete:
checkout must use the stock that exists once it actually enters the domain method.

## Be ready to modify a rule

- **Change n or x:** restart with `REWARD_EVERY_N=2 DISCOUNT_PERCENT=15`; existing
  state is intentionally reset. Runtime reward-policy migration is not implemented.
- **Round down instead:** change the discount expression to omit `+ 50n`, update
  half-cent expectations and the contract. Old order snapshots must remain unchanged.
- **Require price confirmation:** add a cart/quote version, compare it at checkout,
  return a price-conflict error before mutations, and include the version in the
  idempotency intent. Add a competing price-update regression test.
- **Make coupons customer-owned:** first add customer identity and authorization,
  then persist owner IDs on coupon/order and validate ownership before commit.

## State the weaknesses directly

Memory disappears on restart and cannot support multiple workers. Reports scan
all orders synchronously. Retry keys/carts/orders never expire. Admin endpoints
are unauthenticated. Cart prices can change without a quote confirmation. A lost
admin-generation response requires inspecting issued coupons. Payments are a
documented assumption, not an integration. Do not describe this as production ready.

See DECISIONS.md for the database migration plan and deferred concerns. Before
submission, explain these choices in your own words and practice changing one rule.
