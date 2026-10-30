import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/http.ts';
import { Store } from '../src/store.ts';
import type { Order, StoreOptions } from '../src/store.ts';

async function fixture(t: TestContext, options: StoreOptions = {}) {
  const store = new Store(options);
  const server = createApp(store);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function call(method: string, path: string, body?: unknown, key?: string) {
    return fetch(base + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function cart(productId = 'pen', quantity = 1) {
    const response = await call('POST', '/carts', {});
    assert.equal(response.status, 201);
    const data = await response.json() as { id: string };
    assert.equal((await call('POST', `/carts/${data.id}/items`, { productId, quantity })).status, 200);
    return data.id;
  }
  return { store, server, base, call, cart };
}

test('30 simultaneous HTTP checkouts compete for the last item: exactly one succeeds', async t => {
  const { store, call, cart } = await fixture(t);
  const ids = await Promise.all(Array.from({ length: 30 }, () => cart('limited-print')));
  const replies = await Promise.all(ids.map((id, i) => call('POST', `/carts/${id}/checkout`, {}, `last-${i}`)));
  assert.equal(replies.filter(r => r.status === 201).length, 1);
  assert.equal(replies.filter(r => r.status === 409).length, 29);
  for (const reply of replies.filter(r => r.status === 409)) assert.equal((await reply.json()).error.code, 'INSUFFICIENT_INVENTORY');
  assert.equal(store.products().find(p => p.id === 'limited-print')?.inventory, 0);
  assert.equal(store.report().successfulOrders, 1);
  assert.equal(store.report().purchasedQuantityByProduct.find(p => p.productId === 'limited-print')?.quantity, 1);
});

test('40 overlapping retries return the exact same order and consume inventory once', async t => {
  const { store, call, cart } = await fixture(t);
  const id = await cart();
  const replies = await Promise.all(Array.from({ length: 40 }, () => call('POST', `/carts/${id}/checkout`, {}, 'same-request')));
  assert.equal(replies.filter(r => r.status === 201).length, 1);
  assert.equal(replies.filter(r => r.status === 200).length, 39);
  const bodies = await Promise.all(replies.map(r => r.json()));
  for (const body of bodies) assert.deepEqual(body, bodies[0]);
  assert.equal(replies.filter(r => r.headers.get('idempotency-replayed') === 'true').length, 39);
  const order = bodies[0] as Order;
  assert.deepEqual(await (await call('GET', `/orders/${order.id}`)).json(), order);
  assert.equal((await call('POST', `/carts/${id}/checkout`, { couponCode: 'changed' }, 'same-request')).status, 409);
  assert.equal(store.report().successfulOrders, 1);
  assert.equal(store.products().find(p => p.id === 'pen')?.inventory, 199);
});

test('different idempotency keys cannot concurrently check out the same cart twice', async t => {
  const { store, call, cart } = await fixture(t);
  const id = await cart();
  const replies = await Promise.all(Array.from({ length: 20 }, (_, i) => call('POST', `/carts/${id}/checkout`, {}, `different-${i}`)));
  assert.equal(replies.filter(r => r.status === 201).length, 1);
  assert.equal(replies.filter(r => r.status === 409).length, 19);
  assert.equal(store.report().successfulOrders, 1);
});

test('concurrent administrators cannot generate twice for a milestone; one coupon has only one winning redemption', async t => {
  const { store, call, cart } = await fixture(t, { milestoneEvery: 1 });
  const earn = await cart();
  assert.equal((await call('POST', `/carts/${earn}/checkout`, {}, 'earn')).status, 201);
  const generation = await Promise.all(Array.from({ length: 20 }, () => call('POST', '/admin/coupons', {})));
  assert.equal(generation.filter(r => r.status === 201).length, 1);
  assert.equal(generation.filter(r => r.status === 409).length, 19);
  const coupon = await generation.find(r => r.status === 201)!.json() as { code: string };
  const ids = await Promise.all(Array.from({ length: 20 }, () => cart()));
  const redemption = await Promise.all(ids.map((id, i) => call('POST', `/carts/${id}/checkout`, { couponCode: coupon.code }, `redeem-${i}`)));
  assert.equal(redemption.filter(r => r.status === 201).length, 1);
  assert.equal(redemption.filter(r => r.status === 409).length, 19);
  for (const reply of redemption.filter(r => r.status === 409)) assert.equal((await reply.json()).error.code, 'COUPON_REDEEMED');
  const report = await (await call('GET', '/admin/reports/summary')).json();
  assert.equal(report.successfulOrders, 2);
  assert.equal(report.coupons.redeemed, 1);
  assert.equal(report.coupons.generated, 1);
  assert.equal(report.grossRevenueCents, '398');
  assert.equal(report.totalDiscountsCents, '20');
  assert.equal(report.netRevenueCents, '378');
  assert.deepEqual(await (await call('GET', '/admin/reports/summary')).json(), report);
  assert.deepEqual((await (await call('GET', '/admin/coupons')).json()).coupons, report.coupons.codes);
  assert.equal(store.products().find(p => p.id === 'pen')?.inventory, 198);
});

test('HTTP mutation contracts, typed errors and malformed bodies are explicit', async t => {
  const { call, base } = await fixture(t);
  const response = await call('POST', '/carts');
  const { id } = await response.json() as { id: string };
  assert.equal(response.headers.get('location'), `/carts/${id}`);
  assert.equal((await call('GET', '/health')).status, 200);
  assert.equal((await (await call('GET', '/products')).json()).products.length, 5);
  assert.equal((await call('POST', `/carts/${id}/items`, { productId: 'pen', quantity: 2 })).status, 200);
  assert.equal((await call('PUT', `/carts/${id}/items/pen`, { quantity: 3 })).status, 200);
  assert.equal((await (await call('GET', `/carts/${id}`)).json()).grossCents, '597');
  assert.equal((await call('DELETE', `/carts/${id}/items/pen`)).status, 200);
  const cases: [string, string, unknown, number, string][] = [
    ['POST', '/carts', { typo: true }, 400, 'VALIDATION_ERROR'],
    ['POST', '/carts', [], 400, 'VALIDATION_ERROR'],
    ['POST', '/carts', null, 400, 'VALIDATION_ERROR'],
    ['POST', `/carts/${id}/items`, { productId: 'pen', quantity: '2' }, 400, 'VALIDATION_ERROR'],
    ['POST', `/carts/${id}/items`, { productId: 'pen', quantity: 0 }, 400, 'VALIDATION_ERROR'],
    ['POST', `/carts/${id}/items`, { productId: 'unknown', quantity: 1 }, 404, 'PRODUCT_NOT_FOUND'],
    ['POST', `/carts/${id}/checkout`, {}, 400, 'VALIDATION_ERROR'],
    ['PATCH', '/admin/products/pen', { inventory: null }, 400, 'VALIDATION_ERROR'],
    ['PATCH', '/admin/products/pen', {}, 400, 'VALIDATION_ERROR'],
    ['PATCH', '/admin/products/pen', { unitPriceCents: 199 }, 400, 'VALIDATION_ERROR'],
    ['GET', '/orders/missing', undefined, 404, 'ORDER_NOT_FOUND'],
    ['GET', '/carts/missing', undefined, 404, 'CART_NOT_FOUND'],
    ['GET', '/missing', undefined, 404, 'ROUTE_NOT_FOUND'],
  ];
  for (const [method, path, body, status, code] of cases) {
    const reply = await call(method, path, body);
    const error = (await reply.json()).error;
    assert.equal(reply.status, status, `${method} ${path}`);
    assert.equal(error.code, code);
    assert.equal(reply.headers.get('x-request-id'), error.requestId);
  }
  for (const [body, contentType, status, code] of [
    ['{', 'application/json', 400, 'INVALID_JSON'],
    ['{}', 'text/plain', 415, 'UNSUPPORTED_MEDIA_TYPE'],
    [JSON.stringify({ huge: 'x'.repeat(20_000) }), 'application/json', 413, 'BODY_TOO_LARGE'],
  ] as const) {
    const reply = await fetch(base + '/carts', { method: 'POST', headers: { 'Content-Type': contentType }, body });
    assert.equal(reply.status, status);
    assert.equal((await reply.json()).error.code, code);
  }
  assert.equal((await fetch(base + '/%ZZ')).status, 400);
});

test('checkout evaluates inventory after its body completes; failed request preserves coupon and can be retried', async t => {
  const { store, call, cart, base } = await fixture(t, { milestoneEvery: 1 });
  const earn = await cart();
  await call('POST', `/carts/${earn}/checkout`, {}, 'earn');
  const coupon = await (await call('POST', '/admin/coupons', {})).json() as { code: string };
  const id = await cart('limited-print');
  const pending = request(`${base}/carts/${id}/checkout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'slow-checkout' },
  });
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    pending.on('error', reject);
    pending.on('response', reply => {
      let body = '';
      reply.on('data', chunk => { body += String(chunk); });
      reply.on('error', reject);
      reply.on('end', () => resolve({ status: reply.statusCode!, body }));
    });
  });
  pending.write('{"couponCode":');
  assert.equal((await call('PATCH', '/admin/products/limited-print', { inventory: 0 })).status, 200);
  const before = store.report();
  pending.end(JSON.stringify(coupon.code) + '}');
  const failed = await response;
  assert.equal(failed.status, 409);
  assert.equal(JSON.parse(failed.body).error.code, 'INSUFFICIENT_INVENTORY');
  assert.deepEqual(store.report(), before);
  assert.equal(store.coupons()[0]?.redeemedByOrderId, null);
  await call('PATCH', '/admin/products/limited-print', { inventory: 1 });
  const retry = await call('POST', `/carts/${id}/checkout`, { couponCode: coupon.code }, 'slow-checkout');
  assert.equal(retry.status, 201);
  assert.equal(store.report().successfulOrders, 2);
});
