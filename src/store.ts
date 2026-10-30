import { randomUUID } from 'node:crypto';
import { DomainError, requireInteger, requirePriceCents, requireText, validationError } from './errors.ts';

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

interface SuccessfulCheckout {
  cartId: string;
  couponCode: string | null;
  orderId: string;
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

function calculateDiscountCents(grossCents: bigint, discountPercent: number): bigint {
  const amountTimesOneHundred = grossCents * BigInt(discountPercent);

  // BigInt division drops the remainder. Adding 50 rounds half a cent upward.
  return (amountTimesOneHundred + 50n) / 100n;
}

/**
 * Each method runs synchronously in one Node process. Keep all state changes free
 * of await, callbacks and external I/O so another request cannot interrupt them.
 */
export class Store {
  readonly #products = new Map<string, Product>();
  readonly #carts = new Map<string, Cart>();
  readonly #orders = new Map<string, Order>();
  readonly #coupons = new Map<string, Coupon>();
  readonly #issuedMilestones = new Set<number>();
  readonly #successfulCheckoutsByKey = new Map<string, SuccessfulCheckout>();
  readonly #milestoneEvery: number;
  readonly #discountPercent: number;

  constructor(options: StoreOptions = {}) {
    this.#milestoneEvery = requireInteger(options.milestoneEvery ?? 5, 'milestoneEvery', 1, 1_000_000);
    this.#discountPercent = requireInteger(options.discountPercent ?? 10, 'discountPercent', 1, 100);

    const seedProducts = options.products ?? SEED_PRODUCTS;
    for (const product of seedProducts) {
      requireText(product.id, 'productId');
      requireText(product.name, 'name', 200);
      requirePriceCents(product.unitPriceCents);
      requireInteger(product.inventory, 'inventory', 0, 1_000_000);

      if (this.#products.has(product.id)) {
        validationError('Duplicate seed product ID');
      }
      this.#products.set(product.id, structuredClone(product));
    }
  }

  products(): Product[] {
    return structuredClone([...this.#products.values()]);
  }

  #getProduct(productId: string): Product {
    const product = this.#products.get(productId);
    if (!product) {
      throw new DomainError(404, 'PRODUCT_NOT_FOUND', 'Product does not exist', { productId });
    }
    return product;
  }

  #getCart(cartId: string): Cart {
    const cart = this.#carts.get(cartId);
    if (!cart) {
      throw new DomainError(404, 'CART_NOT_FOUND', 'Cart does not exist');
    }
    return cart;
  }

  #getOpenCart(cartId: string): Cart {
    const cart = this.#getCart(cartId);
    if (cart.orderId !== null) {
      throw new DomainError(409, 'CART_CHECKED_OUT', 'Cart has already been checked out', {
        orderId: cart.orderId,
      });
    }
    return cart;
  }

  createCart() {
    const cartId = randomUUID();
    const cart: Cart = {
      id: cartId,
      items: new Map(),
      orderId: null,
    };
    this.#carts.set(cartId, cart);
    return this.cart(cartId);
  }

  #buildOrderLines(cart: Cart): OrderLine[] {
    const orderLines: OrderLine[] = [];

    for (const [productId, quantity] of cart.items) {
      const product = this.#getProduct(productId);
      const lineTotalCents = BigInt(product.unitPriceCents) * BigInt(quantity);

      orderLines.push({
        productId,
        name: product.name,
        quantity,
        unitPriceCents: product.unitPriceCents,
        lineTotalCents: lineTotalCents.toString(),
      });
    }
    return orderLines;
  }

  #calculateGrossCents(orderLines: OrderLine[]): bigint {
    let grossCents = 0n;
    for (const line of orderLines) {
      grossCents += BigInt(line.lineTotalCents);
    }
    return grossCents;
  }

  cart(cartId: string) {
    const cart = this.#getCart(cartId);
    let status = 'OPEN';
    let orderLines: OrderLine[];
    let grossCents: string;

    if (cart.orderId === null) {
      orderLines = this.#buildOrderLines(cart);
      grossCents = this.#calculateGrossCents(orderLines).toString();
    } else {
      // Completed carts keep the prices actually paid, even after product edits.
      const placedOrder = this.order(cart.orderId);
      status = 'CHECKED_OUT';
      orderLines = placedOrder.items;
      grossCents = placedOrder.grossCents;
    }

    const items = [];
    for (const line of orderLines) {
      const product = this.#getProduct(line.productId);
      items.push({ ...line, availableInventory: product.inventory });
    }

    return structuredClone({
      id: cart.id,
      status,
      orderId: cart.orderId,
      currency: 'USD',
      items,
      grossCents,
    });
  }

  addItem(cartId: string, productId: string, quantity: number) {
    requireInteger(quantity, 'quantity', 1, 1_000_000);
    const cart = this.#getOpenCart(cartId);
    this.#getProduct(productId);

    const currentQuantity = cart.items.get(productId) ?? 0;
    const newQuantity = currentQuantity + quantity;
    requireInteger(newQuantity, 'combined quantity', 1, 1_000_000);

    const isNewProduct = !cart.items.has(productId);
    if (isNewProduct && cart.items.size >= 100) {
      throw new DomainError(409, 'CART_LIMIT', 'A cart may contain at most 100 distinct products');
    }

    cart.items.set(productId, newQuantity);
    return this.cart(cartId);
  }

  setItem(cartId: string, productId: string, quantity: number) {
    requireInteger(quantity, 'quantity', 1, 1_000_000);
    const cart = this.#getOpenCart(cartId);
    if (!cart.items.has(productId)) {
      throw new DomainError(404, 'ITEM_NOT_FOUND', 'Item is not in the cart');
    }

    cart.items.set(productId, quantity);
    return this.cart(cartId);
  }

  removeItem(cartId: string, productId: string) {
    const cart = this.#getOpenCart(cartId);
    if (!cart.items.has(productId)) {
      throw new DomainError(404, 'ITEM_NOT_FOUND', 'Item is not in the cart');
    }

    cart.items.delete(productId);
    return this.cart(cartId);
  }

  updateProduct(productId: string, changes: { name?: string; unitPriceCents?: string; inventory?: number }): Product {
    const currentProduct = this.#getProduct(productId);

    // Edit a copy: an invalid later field must not leave earlier changes behind.
    const updatedProduct = { ...currentProduct };
    if (changes.name !== undefined) {
      updatedProduct.name = requireText(changes.name, 'name', 200);
    }
    if (changes.unitPriceCents !== undefined) {
      updatedProduct.unitPriceCents = requirePriceCents(changes.unitPriceCents);
    }
    if (changes.inventory !== undefined) {
      updatedProduct.inventory = requireInteger(changes.inventory, 'inventory', 0, 1_000_000);
    }

    this.#products.set(productId, updatedProduct);
    return structuredClone(updatedProduct);
  }

  #checkInventory(orderLines: OrderLine[]): void {
    for (const line of orderLines) {
      const product = this.#getProduct(line.productId);
      const available = product.inventory;
      if (line.quantity > available) {
        throw new DomainError(409, 'INSUFFICIENT_INVENTORY', 'Inventory no longer satisfies the cart', {
          productId: line.productId,
          requested: line.quantity,
          available,
        });
      }
    }
  }

  #getAvailableCoupon(couponCode: string | null): Coupon | undefined {
    if (couponCode === null) {
      return undefined;
    }

    const coupon = this.#coupons.get(couponCode);
    if (!coupon) {
      throw new DomainError(422, 'COUPON_INVALID', 'Coupon does not exist');
    }
    if (coupon.redeemedByOrderId !== null) {
      throw new DomainError(409, 'COUPON_REDEEMED', 'Coupon was already redeemed');
    }
    return coupon;
  }

  checkout(cartId: string, key: string, couponCode: string | null = null): { order: Order; replayed: boolean } {
    const validKey = typeof key === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(key);
    if (!validKey) {
      validationError('Idempotency-Key is required: 1–128 ASCII letters, digits, dot, underscore, colon or hyphen');
    }
    if (couponCode !== null) {
      requireText(couponCode, 'couponCode');
    }

    const previousCheckout = this.#successfulCheckoutsByKey.get(key);
    if (previousCheckout) {
      const sameCart = previousCheckout.cartId === cartId;
      const sameCoupon = previousCheckout.couponCode === couponCode;
      if (!sameCart || !sameCoupon) {
        throw new DomainError(409, 'IDEMPOTENCY_CONFLICT', 'This key was used for a different cart or coupon');
      }

      // Replay before validating current state: the original cart/coupon is already used.
      return { order: this.order(previousCheckout.orderId), replayed: true };
    }

    const cart = this.#getOpenCart(cartId);
    if (cart.items.size === 0) {
      throw new DomainError(409, 'EMPTY_CART', 'Cannot check out an empty cart');
    }

    const orderLines = this.#buildOrderLines(cart);
    this.#checkInventory(orderLines);
    const coupon = this.#getAvailableCoupon(couponCode);

    let discountPercent = 0;
    if (coupon) {
      discountPercent = coupon.discountPercent;
    }
    const grossCents = this.#calculateGrossCents(orderLines);
    const discountCents = calculateDiscountCents(grossCents, discountPercent);
    const netCents = grossCents - discountCents;

    const order: Order = {
      id: randomUUID(),
      cartId,
      sequence: this.#orders.size + 1,
      createdAt: new Date().toISOString(),
      currency: 'USD',
      items: orderLines,
      grossCents: grossCents.toString(),
      discountCents: discountCents.toString(),
      netCents: netCents.toString(),
      couponCode,
      discountPercent,
    };

    // Atomic commit starts here. All business checks above succeeded.
    // Keep this entire block synchronous: no await or external calls between writes.
    for (const line of orderLines) {
      const product = this.#getProduct(line.productId);
      product.inventory -= line.quantity;
    }
    if (coupon) {
      coupon.redeemedByOrderId = order.id;
    }
    cart.orderId = order.id;
    this.#orders.set(order.id, order);
    this.#successfulCheckoutsByKey.set(key, { cartId, couponCode, orderId: order.id });

    return { order: structuredClone(order), replayed: false };
  }

  order(orderId: string): Order {
    const order = this.#orders.get(orderId);
    if (!order) {
      throw new DomainError(404, 'ORDER_NOT_FOUND', 'Order does not exist');
    }
    return structuredClone(order);
  }

  generateCoupon(): Coupon {
    // We always issue oldest first, so issued milestones have no gaps.
    const issuedMilestoneCount = this.#issuedMilestones.size;
    const nextMilestoneNumber = issuedMilestoneCount + 1;
    const nextMilestoneOrderCount = nextMilestoneNumber * this.#milestoneEvery;
    const successfulOrderCount = this.#orders.size;

    if (nextMilestoneOrderCount > successfulOrderCount) {
      throw new DomainError(409, 'NO_ELIGIBLE_MILESTONE', 'No unrewarded order milestone is eligible', {
        successfulOrders: successfulOrderCount,
        nextMilestoneOrderCount,
      });
    }

    const coupon: Coupon = {
      code: 'reward-' + randomUUID(),
      milestoneOrderCount: nextMilestoneOrderCount,
      discountPercent: this.#discountPercent,
      redeemedByOrderId: null,
    };
    this.#coupons.set(coupon.code, coupon);
    this.#issuedMilestones.add(nextMilestoneOrderCount);
    return structuredClone(coupon);
  }

  coupons(): Coupon[] {
    return structuredClone([...this.#coupons.values()]);
  }

  report() {
    const quantitiesByProduct = new Map<string, number>();
    let grossRevenueCents = 0n;
    let totalDiscountsCents = 0n;

    for (const order of this.#orders.values()) {
      grossRevenueCents += BigInt(order.grossCents);
      totalDiscountsCents += BigInt(order.discountCents);

      for (const line of order.items) {
        const previousQuantity = quantitiesByProduct.get(line.productId) ?? 0;
        quantitiesByProduct.set(line.productId, previousQuantity + line.quantity);
      }
    }

    const purchasedQuantityByProduct = [];
    for (const productId of this.#products.keys()) {
      const quantity = quantitiesByProduct.get(productId) ?? 0;
      purchasedQuantityByProduct.push({ productId, quantity });
    }

    const coupons = this.coupons();
    let redeemedCouponCount = 0;
    for (const coupon of coupons) {
      if (coupon.redeemedByOrderId !== null) {
        redeemedCouponCount += 1;
      }
    }

    const generatedCouponCount = coupons.length;
    const availableCouponCount = generatedCouponCount - redeemedCouponCount;
    const reachedMilestoneCount = Math.floor(this.#orders.size / this.#milestoneEvery);
    const unissuedMilestoneCount = reachedMilestoneCount - this.#issuedMilestones.size;
    const netRevenueCents = grossRevenueCents - totalDiscountsCents;

    return {
      currency: 'USD',
      successfulOrders: this.#orders.size,
      purchasedQuantityByProduct,
      grossRevenueCents: grossRevenueCents.toString(),
      totalDiscountsCents: totalDiscountsCents.toString(),
      netRevenueCents: netRevenueCents.toString(),
      coupons: {
        generated: generatedCouponCount,
        available: availableCouponCount,
        redeemed: redeemedCouponCount,
        codes: coupons,
      },
      rewards: {
        milestoneEvery: this.#milestoneEvery,
        discountPercent: this.#discountPercent,
        eligibleUnissued: unissuedMilestoneCount,
      },
    };
  }
}
