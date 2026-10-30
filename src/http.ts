import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DomainError, requireInteger, requireText, validationError } from './errors.ts';
import { Store } from './store.ts';

const BODY_LIMIT = 16_384;
type Body = Record<string, unknown>;

function parseJsonObject(bodyText: string, contentType: string | undefined): Body {
  const mediaType = contentType?.split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new DomainError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use Content-Type: application/json');
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(bodyText);
  } catch {
    throw new DomainError(400, 'INVALID_JSON', 'Request body must be valid JSON');
  }

  if (parsedBody === null || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    validationError('Body must be a JSON object');
  }
  return parsedBody as Body;
}

function readBody(request: IncomingMessage): Promise<Body> {
  return new Promise((resolve, reject) => {
    let receivedBytes = 0;
    let bodyTooLarge = false;
    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => {
      if (bodyTooLarge) {
        return; // Drain further bytes without keeping them in memory.
      }

      receivedBytes += chunk.length;
      if (receivedBytes > BODY_LIMIT) {
        bodyTooLarge = true;
        chunks.length = 0;
        reject(new DomainError(413, 'BODY_TOO_LARGE', 'JSON body exceeds 16384 bytes'));
        return;
      }
      chunks.push(chunk);
    });

    request.on('error', reject);
    request.on('end', () => {
      if (bodyTooLarge) {
        return;
      }
      if (receivedBytes === 0) {
        resolve({});
        return;
      }

      try {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        const body = parseJsonObject(bodyText, request.headers['content-type']);
        resolve(body);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function requireAllowedFields(body: Body, allowedFields: string[]): void {
  for (const fieldName of Object.keys(body)) {
    if (!allowedFields.includes(fieldName)) {
      validationError(`Unknown field: ${fieldName}`);
    }
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

export function createApp(store = new Store()) {
  const server = createServer(async (request, response) => {
    const requestId = randomUUID();
    response.setHeader('X-Request-Id', requestId);

    try {
      const method = request.method ?? 'GET';
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      let pathParts: string[];
      try {
        pathParts = pathname.split('/').slice(1).map(decodeURIComponent);
      } catch {
        throw new DomainError(400, 'INVALID_PATH', 'Path contains invalid URL encoding');
      }

      let body: Body = {};
      const methodCanHaveBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
      if (methodCanHaveBody) {
        // Complete asynchronous input handling before calling synchronous store methods.
        body = await readBody(request);
      }

      const collection = pathParts[0];
      const resourceId = pathParts[1];
      const operation = pathParts[2];
      const itemId = pathParts[3];

      if (method === 'GET' && pathname === '/health') {
        return sendJson(response, 200, { status: 'ok' });
      }
      if (method === 'GET' && pathname === '/products') {
        return sendJson(response, 200, { products: store.products() });
      }
      if (method === 'POST' && pathname === '/carts') {
        requireAllowedFields(body, []);
        const cart = store.createCart();
        return sendJson(response, 201, cart, { Location: `/carts/${cart.id}` });
      }
      if (
        method === 'GET' && collection === 'carts' &&
        resourceId && pathParts.length === 2
      ) {
        const cart = store.cart(resourceId);
        return sendJson(response, 200, cart);
      }
      if (
        method === 'POST' && collection === 'carts' && resourceId &&
        operation === 'items' && pathParts.length === 3
      ) {
        requireAllowedFields(body, ['productId', 'quantity']);
        const productId = requireText(body.productId, 'productId');
        const quantity = requireInteger(body.quantity, 'quantity', 1, 1_000_000);
        const cart = store.addItem(resourceId, productId, quantity);
        return sendJson(response, 200, cart);
      }
      if (
        method === 'PUT' && collection === 'carts' && resourceId &&
        operation === 'items' && itemId && pathParts.length === 4
      ) {
        requireAllowedFields(body, ['quantity']);
        const quantity = requireInteger(body.quantity, 'quantity', 1, 1_000_000);
        const cart = store.setItem(resourceId, itemId, quantity);
        return sendJson(response, 200, cart);
      }
      if (
        method === 'DELETE' && collection === 'carts' && resourceId &&
        operation === 'items' && itemId && pathParts.length === 4
      ) {
        requireAllowedFields(body, []);
        const cart = store.removeItem(resourceId, itemId);
        return sendJson(response, 200, cart);
      }
      if (
        method === 'POST' && collection === 'carts' && resourceId &&
        operation === 'checkout' && pathParts.length === 3
      ) {
        requireAllowedFields(body, ['couponCode']);
        let couponCode: string | null = null;
        if (body.couponCode !== undefined && body.couponCode !== null) {
          couponCode = requireText(body.couponCode, 'couponCode');
        }
        const idempotencyKey = requireText(request.headers['idempotency-key'], 'Idempotency-Key');
        const result = store.checkout(resourceId, idempotencyKey, couponCode);

        let status = 201;
        if (result.replayed) {
          status = 200;
        }
        return sendJson(response, status, result.order, {
          Location: `/orders/${result.order.id}`,
          'Idempotency-Replayed': String(result.replayed),
        });
      }
      if (method === 'GET' && collection === 'orders' && resourceId && pathParts.length === 2) {
        return sendJson(response, 200, store.order(resourceId));
      }
      if (method === 'POST' && pathname === '/admin/coupons') {
        requireAllowedFields(body, []);
        return sendJson(response, 201, store.generateCoupon());
      }
      if (method === 'GET' && pathname === '/admin/coupons') {
        return sendJson(response, 200, { coupons: store.coupons() });
      }
      if (method === 'GET' && pathname === '/admin/reports/summary') {
        return sendJson(response, 200, store.report());
      }
      const adminProductId = pathParts[2];
      if (
        method === 'PATCH' && collection === 'admin' && resourceId === 'products' &&
        adminProductId && pathParts.length === 3
      ) {
        requireAllowedFields(body, ['name', 'unitPriceCents', 'inventory']);
        if (Object.keys(body).length === 0) {
          validationError('Supply at least one product field');
        }
        return sendJson(response, 200, store.updateProduct(adminProductId, body));
      }

      throw new DomainError(404, 'ROUTE_NOT_FOUND', 'No endpoint matches this method and path');
    } catch (error) {
      if (error instanceof DomainError) {
        return sendJson(response, error.status, {
          error: {
            code: error.code,
            message: error.message,
            details: error.details,
            requestId,
          },
        });
      }

      console.error('Unhandled request failure', { requestId, error });
      sendJson(response, 500, {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Unexpected server error',
          details: {},
          requestId,
        },
      });
    }
  });

  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
