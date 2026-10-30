export class DomainError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function invalid(message: string): never {
  throw new DomainError(400, 'VALIDATION_ERROR', message);
}

export function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    invalid(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function text(value: unknown, field: string, max = 128): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.trim() !== value) {
    invalid(`${field} must be a nonempty string of at most ${max} characters with no surrounding whitespace`);
  }
  return value;
}

export function cents(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,11})$/.test(value)) {
    invalid('unitPriceCents must be a canonical integer string between "0" and "999999999999"');
  }
  return value;
}
