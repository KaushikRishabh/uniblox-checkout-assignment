import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DomainError } from '../src/errors.ts';
import { Store } from '../src/store.ts';

function expectCode(fn: () => unknown, code: string) {
  assert.throws(fn, (error: unknown) => error instanceof DomainError && error.code === code);
}

function filled(store: Store, product = 'pen', quantity = 1) {
  const cart = store.createCart();
  store.addItem(cart.id, product, quantity);
  return cart.id;
}

test('invalid products/quantities cannot mutate carts; add accumulates, update replaces, remove deletes', () => {
  const store = new Store();
  const id = store.createCart().id;
  for (const quantity of [0, -1, 1.5, NaN, Infinity, 1_000_001]) {
    expectCode(() => store.addItem(id, 'pen', quantity), 'VALIDATION_ERROR');
  }
  expectCode(() => store.addItem(id, 'missing', 1), 'PRODUCT_NOT_FOUND');
  assert.equal(store.cart(id).items.length, 0);
  store.addItem(id, 'pen', 2);
  store.addItem(id, 'pen', 3);
  assert.equal(store.cart(id).items[0]?.quantity, 5);
  store.setItem(id, 'pen', 4);
  assert.equal(store.cart(id).grossCents, '796');
  store.removeItem(id, 'pen');
  expectCode(() => store.removeItem(id, 'pen'), 'ITEM_NOT_FOUND');
  expectCode(() => store.setItem(id, 'pen', 1), 'ITEM_NOT_FOUND');
  expectCode(() => store.checkout(id, 'empty'), 'EMPTY_CART');
});

test('live prices and availability are revalidated; committed order and closed cart keep price snapshots', () => {
  const store = new Store();
  const id = filled(store, 'pen', 2);
  store.updateProduct('pen', { unitPriceCents: '205', name: 'New pen', inventory: 1 });
  assert.equal(store.cart(id).grossCents, '410');
  expectCode(() => store.checkout(id, 'price'), 'INSUFFICIENT_INVENTORY');
  assert.equal(store.report().successfulOrders, 0);
  store.updateProduct('pen', { inventory: 2 });
  const { order } = store.checkout(id, 'price');
  assert.equal(order.grossCents, '410');
  store.updateProduct('pen', { unitPriceCents: '999', name: 'Later pen' });
  assert.equal(store.order(order.id).items[0]?.name, 'New pen');
  assert.equal(store.cart(id).grossCents, '410');
  assert.equal(store.products().find(p => p.id === 'pen')?.inventory, 0);
  expectCode(() => store.addItem(id, 'pen', 1), 'CART_CHECKED_OUT');
  expectCode(() => store.setItem(id, 'pen', 1), 'CART_CHECKED_OUT');
  expectCode(() => store.removeItem(id, 'pen'), 'CART_CHECKED_OUT');
});

test('successful idempotency replays exact order; conflicting keys and independent keys cannot duplicate checkout', () => {
  const store = new Store();
  const id = filled(store);
  const first = store.checkout(id, 'request-1');
  const retry = store.checkout(id, 'request-1', null);
  assert.deepEqual(retry.order, first.order);
  assert.equal(retry.replayed, true);
  expectCode(() => store.checkout(id, 'request-2'), 'CART_CHECKED_OUT');
  expectCode(() => store.checkout(id, 'request-1', 'different'), 'IDEMPOTENCY_CONFLICT');
  expectCode(() => store.checkout(filled(store), 'request-1'), 'IDEMPOTENCY_CONFLICT');
  assert.equal(store.report().successfulOrders, 1);
  assert.equal(store.products().find(p => p.id === 'pen')?.inventory, 199);
});

test('failed checkout is atomic across multiple lines, inventory, coupon, milestone and idempotency record', () => {
  const store = new Store({ milestoneEvery: 1 });
  store.checkout(filled(store), 'earn');
  const coupon = store.generateCoupon();
  const id = filled(store, 'pen', 2);
  store.addItem(id, 'limited-print', 2);
  const reportBefore = store.report();
  const productsBefore = store.products();
  expectCode(() => store.checkout(id, 'repairable', coupon.code), 'INSUFFICIENT_INVENTORY');
  assert.deepEqual(store.report(), reportBefore);
  assert.deepEqual(store.products(), productsBefore);
  store.setItem(id, 'limited-print', 1);
  const result = store.checkout(id, 'repairable', coupon.code);
  assert.equal(result.replayed, false);
  assert.equal(store.coupons()[0]?.redeemedByOrderId, result.order.id);
  assert.equal(store.report().successfulOrders, 2);
});

test('invalid and redeemed coupons leave cart and inventory unchanged; coupon retries still succeed', () => {
  const store = new Store({ milestoneEvery: 1 });
  store.checkout(filled(store), 'earn');
  const coupon = store.generateCoupon();
  const id = filled(store);
  const before = store.products();
  expectCode(() => store.checkout(id, 'invalid', 'bad-code'), 'COUPON_INVALID');
  assert.deepEqual(store.products(), before);
  const first = store.checkout(id, 'valid', coupon.code);
  assert.deepEqual(store.checkout(id, 'valid', coupon.code).order, first.order);
  const next = filled(store);
  expectCode(() => store.checkout(next, 'used', coupon.code), 'COUPON_REDEEMED');
  assert.equal(store.cart(next).status, 'OPEN');
  assert.equal(store.report().successfulOrders, 2);
});

test('milestones accrue globally and oldest eligible milestone is generated exactly once, even when delayed', () => {
  const store = new Store({ milestoneEvery: 2 });
  expectCode(() => store.generateCoupon(), 'NO_ELIGIBLE_MILESTONE');
  for (let i = 0; i < 5; i++) store.checkout(filled(store), `order-${i}`);
  assert.equal(store.report().rewards.eligibleUnissued, 2);
  assert.equal(store.generateCoupon().milestoneOrderCount, 2);
  assert.equal(store.generateCoupon().milestoneOrderCount, 4);
  expectCode(() => store.generateCoupon(), 'NO_ELIGIBLE_MILESTONE');
  assert.equal(store.report().rewards.eligibleUnissued, 0);
});

test('BigInt money is exact above Number safe range, half-cent rounds up and 100% cannot go negative', () => {
  const store = new Store({ milestoneEvery: 1, discountPercent: 10 });
  store.checkout(filled(store), 'earn');
  store.updateProduct('pen', { unitPriceCents: '5' });
  const small = store.checkout(filled(store), 'half', store.generateCoupon().code).order;
  assert.equal(small.discountCents, '1');
  assert.equal(small.netCents, '4');
  store.updateProduct('pen', { unitPriceCents: '999999999999', inventory: 1_000_000 });
  const large = store.checkout(filled(store, 'pen', 1_000_000), 'large', store.generateCoupon().code).order;
  assert.equal(large.grossCents, '999999999999000000');
  assert.equal(large.discountCents, '99999999999900000');
  assert.equal(large.netCents, '899999999999100000');
  const full = new Store({ milestoneEvery: 1, discountPercent: 100 });
  full.checkout(filled(full), 'earn');
  assert.equal(full.checkout(filled(full), 'free', full.generateCoupon().code).order.netCents, '0');
});

test('reports reconcile with immutable orders and coupons, and returned values cannot mutate internal state', () => {
  const store = new Store({ milestoneEvery: 1 });
  const first = store.checkout(filled(store, 'pen', 2), 'one').order;
  const coupon = store.generateCoupon();
  const second = store.checkout(filled(store, 'notebook', 3), 'two', coupon.code).order;
  const report = store.report();
  assert.equal(report.grossRevenueCents, (BigInt(first.grossCents) + BigInt(second.grossCents)).toString());
  assert.equal(report.totalDiscountsCents, second.discountCents);
  assert.equal(BigInt(report.netRevenueCents) + BigInt(report.totalDiscountsCents), BigInt(report.grossRevenueCents));
  assert.deepEqual(report.coupons.codes, store.coupons());
  assert.equal(report.purchasedQuantityByProduct.find(p => p.productId === 'pen')?.quantity, 2);
  assert.equal(report.purchasedQuantityByProduct.find(p => p.productId === 'notebook')?.quantity, 3);
  assert.deepEqual(store.report(), report);
  first.items[0]!.quantity = 999;
  coupon.redeemedByOrderId = 'forged';
  store.products()[0]!.inventory = 999;
  store.cart(second.cartId).items[0]!.quantity = 999;
  report.coupons.codes[0]!.redeemedByOrderId = 'forged';
  assert.equal(store.order(first.id).items[0]?.quantity, 2);
  assert.equal(store.coupons()[0]?.redeemedByOrderId, second.id);
  assert.equal(store.products()[0]?.inventory, 97);
});

test('invalid config and mixed invalid product patch fail without partial mutation', () => {
  for (const milestoneEvery of [0, 1.5, NaN]) expectCode(() => new Store({ milestoneEvery }), 'VALIDATION_ERROR');
  for (const discountPercent of [0, 101, 1.5]) expectCode(() => new Store({ discountPercent }), 'VALIDATION_ERROR');
  const store = new Store();
  const before = store.products();
  expectCode(() => store.updateProduct('pen', { name: 'Changed', unitPriceCents: '1.5' }), 'VALIDATION_ERROR');
  assert.deepEqual(store.products(), before);
  const id = filled(store, 'pen', 1_000_000);
  expectCode(() => store.addItem(id, 'pen', 1), 'VALIDATION_ERROR');
  assert.equal(store.cart(id).items[0]?.quantity, 1_000_000);
});
