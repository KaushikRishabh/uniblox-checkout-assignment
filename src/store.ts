import { randomUUID } from 'node:crypto';
import { cents, DomainError, integer, text, invalid } from './errors.ts';

export interface Product {
  id: string;
  name: string;
  unitPriceCents: string;
  inventory: number;
}

interface Cart {
  id: string;
  items: Map<string, number>;
  orderId: string | null;
}

export interface OrderLine {
  productId: string;
  name: string;
  quantity: number;
  unitPriceCents: string;
  lineTotalCents: string;
}

export interface Order {
  id: string;
  cartId: string;
  sequence: number;
  createdAt: string;
  currency: 'USD';
  items: OrderLine[];
  grossCents: string;
  discountCents: string;
  netCents: string;
  couponCode: string | null;
  discountPercent: number;
}

export interface Coupon {
  code: string;
  milestoneOrderCount: number;
  discountPercent: number;
  redeemedByOrderId: string | null;
}

export const SEED_PRODUCTS: ReadonlyArray<Readonly<Product>> = [
  { id: 'notebook', name: 'Notebook', unitPriceCents: '1299', inventory: 100 },
  { id: 'pen', name: 'Pen', unitPriceCents: '199', inventory: 200 },
  { id: 'mug', name: 'Coffee mug', unitPriceCents: '1599', inventory: 30 },
  { id: 'bag', name: 'Canvas bag', unitPriceCents: '2499', inventory: 20 },
  { id: 'limited-print', name: 'Limited edition print', unitPriceCents: '9999', inventory: 1 },
];

export interface StoreOptions {
  milestoneEvery?: number;
  discountPercent?: number;
  products?: ReadonlyArray<Readonly<Product>>;
}

/**
 * All state access is synchronous. Node executes one JS call stack at a time:
 * no await, callbacks, external I/O or user hooks may be added inside a mutation.
 * Body parsing happens before entering the store. This is single-process only.
 */
export class Store {
  readonly #products = new Map<string, Product>();
  readonly #carts = new Map<string, Cart>();
  readonly #orders = new Map<string, Order>();
  readonly #coupons = new Map<string, Coupon>();
  readonly #rewardedMilestones = new Set<number>();
  readonly #idempotency = new Map<string, { fingerprint: string; orderId: string }>();
  readonly #milestoneEvery: number;
  readonly #discountPercent: number;

  constructor(options: StoreOptions = {}) {
    this.#milestoneEvery = integer(options.milestoneEvery ?? 5, 'milestoneEvery', 1, 1_000_000);
    this.#discountPercent = integer(options.discountPercent ?? 10, 'discountPercent', 1, 100);
    for (const product of options.products ?? SEED_PRODUCTS) {
      text(product.id, 'productId');
      text(product.name, 'name', 200);
      cents(product.unitPriceCents);
      integer(product.inventory, 'inventory', 0, 1_000_000);
      if (this.#products.has(product.id)) invalid('Duplicate seed product ID');
      this.#products.set(product.id, structuredClone(product));
    }
  }

  products(): Product[] {
    return structuredClone([...this.#products.values()]);
  }

  #product(id: string): Product {
    const product = this.#products.get(id);
    if (!product) throw new DomainError(404, 'PRODUCT_NOT_FOUND', 'Product does not exist', { productId: id });
    return product;
  }

  #cart(id: string): Cart {
    const cart = this.#carts.get(id);
    if (!cart) throw new DomainError(404, 'CART_NOT_FOUND', 'Cart does not exist');
    return cart;
  }

  #openCart(id: string): Cart {
    const cart = this.#cart(id);
    if (cart.orderId) {
      throw new DomainError(409, 'CART_CHECKED_OUT', 'Cart has already been checked out', { orderId: cart.orderId });
    }
    return cart;
  }

  createCart() {
    const id = randomUUID();
    this.#carts.set(id, { id, items: new Map(), orderId: null });
    return this.cart(id);
  }

  #lines(cart: Cart): OrderLine[] {
    return [...cart.items].map(([productId, quantity]) => {
      const product = this.#product(productId);
      return {
        productId, name: product.name, quantity, unitPriceCents: product.unitPriceCents,
        lineTotalCents: (BigInt(product.unitPriceCents) * BigInt(quantity)).toString(),
      };
    });
  }

  cart(id: string) {
    const cart = this.#cart(id);
    // A closed cart displays its immutable order prices, not today's catalogue.
    const order = cart.orderId ? this.#orders.get(cart.orderId)! : undefined;
    const lines = order?.items ?? this.#lines(cart);
    return structuredClone({
      id: cart.id, status: cart.orderId ? 'CHECKED_OUT' : 'OPEN', orderId: cart.orderId,
      currency: 'USD', items: lines.map(line => ({ ...line, availableInventory: this.#product(line.productId).inventory })),
      grossCents: order?.grossCents ?? this.#gross(lines).toString(),
    });
  }

  addItem(cartId: string, productId: string, quantity: number) {
    integer(quantity, 'quantity', 1, 1_000_000);
    const cart = this.#openCart(cartId);
    this.#product(productId);
    const next = integer((cart.items.get(productId) ?? 0) + quantity, 'combined quantity', 1, 1_000_000);
    if (!cart.items.has(productId) && cart.items.size >= 100) {
      throw new DomainError(409, 'CART_LIMIT', 'A cart may contain at most 100 distinct products');
    }
    cart.items.set(productId, next);
    return this.cart(cartId);
  }

  setItem(cartId: string, productId: string, quantity: number) {
    integer(quantity, 'quantity', 1, 1_000_000);
    const cart = this.#openCart(cartId);
    if (!cart.items.has(productId)) throw new DomainError(404, 'ITEM_NOT_FOUND', 'Item is not in the cart');
    cart.items.set(productId, quantity);
    return this.cart(cartId);
  }

  removeItem(cartId: string, productId: string) {
    const cart = this.#openCart(cartId);
    if (!cart.items.delete(productId)) throw new DomainError(404, 'ITEM_NOT_FOUND', 'Item is not in the cart');
    return this.cart(cartId);
  }

  updateProduct(id: string, update: { name?: string; unitPriceCents?: string; inventory?: number }): Product {
    const product = this.#product(id);
    // Validate the entire update before changing anything.
    const next = {
      ...product,
      name: update.name === undefined ? product.name : text(update.name, 'name', 200),
      unitPriceCents: update.unitPriceCents === undefined ? product.unitPriceCents : cents(update.unitPriceCents),
      inventory: update.inventory === undefined ? product.inventory : integer(update.inventory, 'inventory', 0, 1_000_000),
    };
    this.#products.set(id, next);
    return structuredClone(next);
  }

  #gross(lines: OrderLine[]): bigint {
    return lines.reduce((sum, line) => sum + BigInt(line.lineTotalCents), 0n);
  }

  checkout(cartId: string, key: string, couponCode: string | null = null): { order: Order; replayed: boolean } {
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
      invalid('Idempotency-Key is required: 1–128 ASCII letters, digits, dot, underscore, colon or hyphen');
    }
    if (couponCode !== null) text(couponCode, 'couponCode');
    const fingerprint = JSON.stringify([cartId, couponCode]);
    const prior = this.#idempotency.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new DomainError(409, 'IDEMPOTENCY_CONFLICT', 'This key was used for a different cart or coupon');
      }
      return { order: this.order(prior.orderId), replayed: true };
    }
    const cart = this.#openCart(cartId);
    if (cart.items.size === 0) throw new DomainError(409, 'EMPTY_CART', 'Cannot check out an empty cart');
    const lines = this.#lines(cart);
    for (const line of lines) {
      const available = this.#product(line.productId).inventory;
      if (line.quantity > available) {
        throw new DomainError(409, 'INSUFFICIENT_INVENTORY', 'Inventory no longer satisfies the cart', {
          productId: line.productId, requested: line.quantity, available,
        });
      }
    }
    const coupon = couponCode === null ? undefined : this.#coupons.get(couponCode);
    if (couponCode !== null && !coupon) throw new DomainError(422, 'COUPON_INVALID', 'Coupon does not exist');
    if (coupon?.redeemedByOrderId) throw new DomainError(409, 'COUPON_REDEEMED', 'Coupon was already redeemed');

    const gross = this.#gross(lines);
    const percent = coupon?.discountPercent ?? 0;
    // Round once at order level: nearest cent, ties up. No floating-point money.
    const discount = (gross * BigInt(percent) + 50n) / 100n;
    const order: Order = {
      id: randomUUID(), cartId, sequence: this.#orders.size + 1, createdAt: new Date().toISOString(),
      currency: 'USD', items: lines, grossCents: gross.toString(), discountCents: discount.toString(),
      netCents: (gross - discount).toString(), couponCode, discountPercent: percent,
    };
    // Commit section. Every business validation and allocation of the order is above.
    // No await / external I/O: inventory, coupon, cart, order and retry record publish together.
    for (const line of lines) this.#product(line.productId).inventory -= line.quantity;
    if (coupon) coupon.redeemedByOrderId = order.id;
    cart.orderId = order.id;
    this.#orders.set(order.id, order);
    this.#idempotency.set(key, { fingerprint, orderId: order.id });
    return { order: structuredClone(order), replayed: false };
  }

  order(id: string): Order {
    const order = this.#orders.get(id);
    if (!order) throw new DomainError(404, 'ORDER_NOT_FOUND', 'Order does not exist');
    return structuredClone(order);
  }

  generateCoupon(): Coupon {
    // Milestones are a contiguous prefix: always issue the oldest unissued one.
    const milestone = (this.#rewardedMilestones.size + 1) * this.#milestoneEvery;
    if (milestone > this.#orders.size) {
      throw new DomainError(409, 'NO_ELIGIBLE_MILESTONE', 'No unrewarded order milestone is eligible', {
        successfulOrders: this.#orders.size, nextMilestoneOrderCount: milestone,
      });
    }
    const coupon: Coupon = {
      code: `reward-${randomUUID()}`, milestoneOrderCount: milestone,
      discountPercent: this.#discountPercent, redeemedByOrderId: null,
    };
    this.#coupons.set(coupon.code, coupon);
    this.#rewardedMilestones.add(milestone);
    return structuredClone(coupon);
  }

  coupons(): Coupon[] {
    return structuredClone([...this.#coupons.values()]);
  }

  report() {
    const purchased = new Map<string, number>();
    let gross = 0n;
    let discount = 0n;
    for (const order of this.#orders.values()) {
      gross += BigInt(order.grossCents);
      discount += BigInt(order.discountCents);
      for (const line of order.items) purchased.set(line.productId, (purchased.get(line.productId) ?? 0) + line.quantity);
    }
    const coupons = this.coupons();
    const redeemed = coupons.filter(coupon => coupon.redeemedByOrderId !== null).length;
    return {
      currency: 'USD', successfulOrders: this.#orders.size,
      purchasedQuantityByProduct: [...this.#products.keys()].map(productId => ({ productId, quantity: purchased.get(productId) ?? 0 })),
      grossRevenueCents: gross.toString(), totalDiscountsCents: discount.toString(), netRevenueCents: (gross - discount).toString(),
      coupons: { generated: coupons.length, available: coupons.length - redeemed, redeemed, codes: coupons },
      rewards: { milestoneEvery: this.#milestoneEvery, discountPercent: this.#discountPercent,
        eligibleUnissued: Math.floor(this.#orders.size / this.#milestoneEvery) - this.#rewardedMilestones.size },
    };
  }
}
