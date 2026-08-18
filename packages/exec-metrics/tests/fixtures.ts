import { readFileSync } from 'node:fs';

import type { CowOrder, CowTrade } from '../src/cow';

export function loadOrderFixture(): CowOrder {
  return JSON.parse(readFileSync(new URL('./fixtures/order.json', import.meta.url), 'utf8')) as CowOrder;
}

export function loadTradesFixture(): CowTrade[] {
  return JSON.parse(readFileSync(new URL('./fixtures/trades.json', import.meta.url), 'utf8')) as CowTrade[];
}
