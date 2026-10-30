import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/http.ts';
import type { Order } from '../src/store.ts';
import { Store } from '../src/store.ts';

// Uses its own fresh store and ephemeral loopback port; no running service is touched.
const server = createApp(new Store({ milestoneEvery: 2, discountPercent: 10 }));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function call(method: string, path: string, body: unknown = undefined, key?: string) {
  return fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function cart(items: [string, number][]) {
  const created = await call('POST', '/carts', {});
  assert.equal(created.status, 201);
  const { id } = await created.json() as { id: string };
  for (const [productId, quantity] of items) {
    assert.equal((await call('POST', `/carts/${id}/items`, { productId, quantity })).status, 200);
  }
  return id;
}

try {
  const firstCart = await cart([['pen', 2], ['notebook', 1]]);
  const first = await call('POST', `/carts/${firstCart}/checkout`, {}, 'demo-1');
  assert.equal(first.status, 201);
  const firstOrder = await first.json() as Order;
  const retry = await call('POST', `/carts/${firstCart}/checkout`, {}, 'demo-1');
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), firstOrder);
  console.log('PASS: checkout retry returns the same order; inventory deducted once.');

  const secondCart = await cart([['bag', 1]]);
  assert.equal((await call('POST', `/carts/${secondCart}/checkout`, {}, 'demo-2')).status, 201);
  const couponReply = await call('POST', '/admin/coupons', {});
  assert.equal(couponReply.status, 201);
  const coupon = await couponReply.json() as { code: string; milestoneOrderCount: number };
  assert.equal(coupon.milestoneOrderCount, 2);
  assert.equal((await call('POST', '/admin/coupons', {})).status, 409);
  console.log('PASS: two successful orders make exactly one milestone coupon eligible.');

  const thirdCart = await cart([['limited-print', 1]]);
  const discounted = await call('POST', `/carts/${thirdCart}/checkout`, { couponCode: coupon.code }, 'demo-3');
  assert.equal(discounted.status, 201);
  const order = await discounted.json() as Order;
  assert.equal(order.grossCents, '9999');
  assert.equal(order.discountCents, '1000');
  assert.equal(order.netCents, '8999');
  assert.deepEqual(await (await call('GET', `/orders/${order.id}`)).json(), order);
  console.log('PASS: 10% of 9999 cents rounds to 1000 cents; stored order explains the calculation.');

  const unavailable = await cart([['limited-print', 1]]);
  const failed = await call('POST', `/carts/${unavailable}/checkout`, {}, 'demo-failed');
  assert.equal(failed.status, 409);
  assert.equal((await failed.json()).error.code, 'INSUFFICIENT_INVENTORY');
  const report = await (await call('GET', '/admin/reports/summary')).json();
  assert.equal(report.successfulOrders, 3);
  assert.equal(report.grossRevenueCents, '14195');
  assert.equal(report.totalDiscountsCents, '1000');
  assert.equal(report.netRevenueCents, '13195');
  assert.equal(report.coupons.redeemed, 1);
  console.log('PASS: sold-out checkout fails without changing revenue or successful order count.');
  console.log(JSON.stringify(report, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
