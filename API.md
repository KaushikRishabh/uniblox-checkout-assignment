# HTTP API

Base URL: `http://127.0.0.1:3000`. All responses are JSON. Nonempty request bodies
must be JSON objects with `Content-Type: application/json` (charset allowed).
Empty bodies are treated as `{}`. Unknown fields are rejected. Bodies are capped
at 16384 bytes. Queries have no effect; paths have no trailing slash.

Money is a canonical integer decimal **string**, denominated in USD cents.
Quantities, inventory, counts, sequence and percentage are JSON integers.
IDs are opaque strings. Generated cart/order IDs are UUIDs. Timestamps are ISO UTC.
No endpoints implement authentication; `/admin/*` operations require admin trust.

## Response models

`Product`:
```json
{"id":"pen","name":"Pen","unitPriceCents":"199","inventory":200}
```

`Cart`:
```json
{
  "id":"cart-id",
  "status":"OPEN",
  "orderId":null,
  "currency":"USD",
  "items":[{"productId":"pen","name":"Pen","quantity":2,"unitPriceCents":"199","lineTotalCents":"398","availableInventory":200}],
  "grossCents":"398"
}
```
After checkout, `status` is `CHECKED_OUT` and `orderId` is the created order's ID.
Its prices are then frozen; `availableInventory` always reflects current stock.
Gross is the undiscounted cart total. See the order for the final discount and net.

`Order`:
```json
{
  "id":"order-id","cartId":"cart-id","sequence":1,"createdAt":"2026-10-30T01:30:00.000Z",
  "currency":"USD",
  "items":[{"productId":"pen","name":"Pen","quantity":2,"unitPriceCents":"199","lineTotalCents":"398"}],
  "grossCents":"398","discountCents":"0","netCents":"398",
  "couponCode":null,"discountPercent":0
}
```
`sequence` is the global successful order number. Each order preserves all inputs
to its monetary calculation. Coupon orders store the exact code and percentage.

`Coupon`:
```json
{"code":"reward-uuid","milestoneOrderCount":5,"discountPercent":10,"redeemedByOrderId":null}
```
A non-null `redeemedByOrderId` identifies the one successful redemption.

`Summary` (example with one undiscounted order and no coupons yet):
```json
{
  "currency":"USD","successfulOrders":1,
  "purchasedQuantityByProduct":[
    {"productId":"notebook","quantity":0},{"productId":"pen","quantity":2},
    {"productId":"mug","quantity":0},{"productId":"bag","quantity":0},
    {"productId":"limited-print","quantity":0}
  ],
  "grossRevenueCents":"398","totalDiscountsCents":"0","netRevenueCents":"398",
  "coupons":{"generated":0,"available":0,"redeemed":0,"codes":[]},
  "rewards":{"milestoneEvery":5,"discountPercent":10,"eligibleUnissued":0}
}
```
`codes` contains full `Coupon` objects, including redeemed codes. Products with no
purchases appear with zero quantity. Names/prices are available from order snapshots.
Revenue remains historical when catalogue prices change.

## Endpoints

| Method and path | Request | Success response | Important errors |
| --- | --- | --- | --- |
| `GET /health` | None | 200 `{"status":"ok"}` | — |
| `GET /products` | None | 200 `{"products":[Product,...]}` | — |
| `POST /carts` | `{}` or empty | 201 `Cart`; `Location: /carts/:id` | 400 unknown fields |
| `GET /carts/:id` | None | 200 `Cart` | 404 `CART_NOT_FOUND` |
| `POST /carts/:id/items` | `{"productId":"pen","quantity":2}` | 200 updated `Cart`; accumulates quantity | 400 validation; 404 cart/product; 409 closed cart or `CART_LIMIT` |
| `PUT /carts/:id/items/:productId` | `{"quantity":3}` | 200 updated `Cart`; replaces quantity | 400 validation; 404 cart/item; 409 closed cart |
| `DELETE /carts/:id/items/:productId` | `{}` or empty | 200 updated `Cart` | 404 cart/item; 409 closed cart |
| `POST /carts/:id/checkout` | `{}` or `{"couponCode":"reward-uuid"}` plus `Idempotency-Key` header | 201 `Order` initially; 200 **same Order** on replay; `Location: /orders/:id`, `Idempotency-Replayed: false/true` | 400 validation/missing key; 404 cart; 409 conflicts listed below; 422 invalid coupon |
| `GET /orders/:id` | None | 200 immutable `Order` | 404 `ORDER_NOT_FOUND` |
| `POST /admin/coupons` | `{}` or empty | 201 `Coupon` for oldest eligible unissued milestone | 409 `NO_ELIGIBLE_MILESTONE` |
| `GET /admin/coupons` | None | 200 `{"coupons":[Coupon,...]}` | — |
| `GET /admin/reports/summary` | None | 200 `Summary`; read only | — |
| `PATCH /admin/products/:id` | At least one of `{"name":"Pen","unitPriceCents":"205","inventory":20}` | 200 updated `Product`; fields omitted retain previous values | 400 validation/empty patch; 404 product |

### Limits and validation

- `quantity`: integer 1–1000000. Adding also checks the accumulated quantity.
  Use DELETE to remove an item; zero quantity is rejected.
- At most 100 distinct products per cart. No inventory reservation or availability
  rejection occurs at add time. Shortage is checked at checkout.
- `inventory`: integer 0–1000000; updates set an absolute quantity.
- `unitPriceCents`: string matching `0` or 1–12 decimal digits without leading zero.
  `"1.50"`, `"01"`, negative strings and JSON numbers are rejected. Free products are allowed.
- `name`: nonempty string, max 200 characters, no surrounding whitespace.
- `productId` and `couponCode`: nonempty string, max 128 characters, no surrounding whitespace.
- `Idempotency-Key`: 1–128 ASCII letters, digits, `.`, `_`, `:`, `-`.
  Use a unique key per intended successful checkout. Keys are global within the process.
- `couponCode: null` is equivalent to omitted. Empty strings are invalid.

### Error model

Every handled error has this shape and `X-Request-Id` matches `requestId`:
```json
{
  "error":{
    "code":"INSUFFICIENT_INVENTORY",
    "message":"Inventory no longer satisfies the cart",
    "details":{"productId":"limited-print","requested":2,"available":1},
    "requestId":"request-uuid"
  }
}
```
Treat `code` as the stable programmatic field; messages explain the failure.
Errors do not mutate business state. Validation precedes checkout commit;
when multiple conditions fail, the first validation encountered wins.

| HTTP status | Code | Meaning / client action |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Invalid/missing fields, malformed key, unknown fields; fix request |
| 400 | `INVALID_JSON` | Request JSON cannot be parsed |
| 400 | `INVALID_PATH` | Invalid percent encoding in path |
| 404 | `PRODUCT_NOT_FOUND`, `CART_NOT_FOUND`, `ITEM_NOT_FOUND`, `ORDER_NOT_FOUND` | Requested resource does not exist |
| 404 | `ROUTE_NOT_FOUND` | Unsupported method/path combination |
| 409 | `EMPTY_CART` | Add items before checkout |
| 409 | `CART_CHECKED_OUT` | Cart already has an order; `details.orderId` identifies it |
| 409 | `CART_LIMIT` | Too many distinct cart products |
| 409 | `INSUFFICIENT_INVENTORY` | Reduce quantity or retry after replenishment; details identify first shortage |
| 409 | `IDEMPOTENCY_CONFLICT` | Successful key belongs to a different cart/coupon; use the original payload or another key |
| 409 | `COUPON_REDEEMED` | Coupon was consumed by another successful order |
| 409 | `NO_ELIGIBLE_MILESTONE` | No coupon can be issued; details give order count and next milestone |
| 413 | `BODY_TOO_LARGE` | JSON body exceeds 16384 bytes |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Nonempty body must use application/json |
| 422 | `COUPON_INVALID` | Code does not identify an issued coupon |
| 500 | `INTERNAL_ERROR` | Unexpected bug; request ID is logged, internal details are hidden |

Native HTTP parsing/transport failures (e.g. invalid HTTP framing or connection
timeouts) can be handled by Node before this JSON adapter runs.

## Direct administrative examples

```sh
# Change a live price and available inventory before checkout.
curl -X PATCH http://127.0.0.1:3000/admin/products/pen \
  -H 'Content-Type: application/json' -d '{"unitPriceCents":"205","inventory":20}'
# After the fifth successful order with the default n=5:
curl -i -X POST http://127.0.0.1:3000/admin/coupons
curl http://127.0.0.1:3000/admin/coupons
curl http://127.0.0.1:3000/admin/reports/summary
```
