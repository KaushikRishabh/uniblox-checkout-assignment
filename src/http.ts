import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DomainError, invalid, integer, text } from './errors.ts';
import { Store } from './store.ts';

const BODY_LIMIT = 16_384;
type Body = Record<string, unknown>;

function readBody(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let rejected = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (rejected) return; // Drain the remaining body without retaining it.
      size += chunk.length;
      if (size > BODY_LIMIT) {
        rejected = true;
        chunks.length = 0;
        reject(new DomainError(413, 'BODY_TOO_LARGE', 'JSON body exceeds 16384 bytes'));
      } else chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (rejected) return;
      try {
        if (size === 0) return resolve({});
        if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
          throw new DomainError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use Content-Type: application/json');
        }
        let parsed: unknown;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new DomainError(400, 'INVALID_JSON', 'Request body must be valid JSON'); }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) invalid('Body must be a JSON object');
        resolve(parsed as Body);
      } catch (error) { reject(error); }
    });
  });
}

function fields(body: Body, allowed: string[]): void {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) invalid(`Unknown field: ${key}`);
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

export function createApp(store = new Store()) {
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    try {
      const method = req.method ?? 'GET';
      const rawPath = new URL(req.url ?? '/', 'http://localhost').pathname;
      let path: string[];
      try { path = rawPath.split('/').slice(1).map(decodeURIComponent); }
      catch { throw new DomainError(400, 'INVALID_PATH', 'Path contains invalid URL encoding'); }
      const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? await readBody(req) : {};

      if (rawPath === '/health' && method === 'GET') return send(res, 200, { status: 'ok' });
      if (rawPath === '/products' && method === 'GET') return send(res, 200, { products: store.products() });
      if (rawPath === '/carts' && method === 'POST') {
        fields(body, []);
        const cart = store.createCart();
        return send(res, 201, cart, { Location: `/carts/${cart.id}` });
      }
      if (path[0] === 'carts' && path[1]) {
        const cartId = path[1];
        if (path.length === 2 && method === 'GET') return send(res, 200, store.cart(cartId));
        if (path.length === 3 && path[2] === 'items' && method === 'POST') {
          fields(body, ['productId', 'quantity']);
          return send(res, 200, store.addItem(cartId, text(body.productId, 'productId'), integer(body.quantity, 'quantity', 1, 1_000_000)));
        }
        if (path.length === 4 && path[2] === 'items' && path[3]) {
          if (method === 'PUT') {
            fields(body, ['quantity']);
            return send(res, 200, store.setItem(cartId, path[3], integer(body.quantity, 'quantity', 1, 1_000_000)));
          }
          if (method === 'DELETE') {
            fields(body, []);
            return send(res, 200, store.removeItem(cartId, path[3]));
          }
        }
        if (path.length === 3 && path[2] === 'checkout' && method === 'POST') {
          fields(body, ['couponCode']);
          const couponCode = body.couponCode === undefined || body.couponCode === null ? null : text(body.couponCode, 'couponCode');
          const result = store.checkout(cartId, text(req.headers['idempotency-key'], 'Idempotency-Key'), couponCode);
          return send(res, result.replayed ? 200 : 201, result.order, {
            Location: `/orders/${result.order.id}`, 'Idempotency-Replayed': String(result.replayed),
          });
        }
      }
      if (path[0] === 'orders' && path[1] && path.length === 2 && method === 'GET') {
        return send(res, 200, store.order(path[1]));
      }
      if (rawPath === '/admin/coupons' && method === 'POST') {
        fields(body, []);
        return send(res, 201, store.generateCoupon());
      }
      if (rawPath === '/admin/coupons' && method === 'GET') return send(res, 200, { coupons: store.coupons() });
      if (rawPath === '/admin/reports/summary' && method === 'GET') return send(res, 200, store.report());
      if (path[0] === 'admin' && path[1] === 'products' && path[2] && path.length === 3 && method === 'PATCH') {
        fields(body, ['name', 'unitPriceCents', 'inventory']);
        if (Object.keys(body).length === 0) invalid('Supply at least one product field');
        // Store performs atomic validation; the shape is restricted above.
        return send(res, 200, store.updateProduct(path[2], body));
      }
      throw new DomainError(404, 'ROUTE_NOT_FOUND', 'No endpoint matches this method and path');
    } catch (error) {
      if (error instanceof DomainError) {
        send(res, error.status, { error: { code: error.code, message: error.message, details: error.details, requestId } });
      } else {
        console.error('Unhandled request failure', { requestId, error });
        send(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error', details: {}, requestId } });
      }
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
