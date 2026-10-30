import { requireInteger } from './errors.ts';
import { createApp } from './http.ts';
import { Store } from './store.ts';

function readIntegerSetting(name: string, defaultValue: number, min: number, max: number): number {
  const rawValue = process.env[name];
  if (rawValue === undefined) {
    return requireInteger(defaultValue, name, min, max);
  }
  if (!/^\d+$/.test(rawValue)) {
    throw new Error(`${name} must be an integer`);
  }
  return requireInteger(Number(rawValue), name, min, max);
}

const port = readIntegerSetting('PORT', 3000, 1, 65535);
const host = process.env['HOST'] ?? '127.0.0.1';
const store = new Store({
  milestoneEvery: readIntegerSetting('REWARD_EVERY_N', 5, 1, 1_000_000),
  discountPercent: readIntegerSetting('DISCOUNT_PERCENT', 10, 1, 100),
});
const server = createApp(store);
server.on('error', error => {
  console.error(error.message);
  process.exitCode = 1;
});
server.listen(port, host, () => {
  console.log(`Checkout service listening on http://${host}:${port}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      process.exitCode = 0;
    });
  });
}
