import assert from 'node:assert/strict';
import { test } from 'node:test';

/** The venue is chosen once at import, like the runner does. */
process.env.LP_RANGE_VENUE = 'uniswap-v3';

const { venueContext } = await import('../src/agents/lp-range');
const { LP_VENUES } = await import('../src/lp-venues');

type Ctx = Parameters<typeof venueContext>[0];

function fakeCtx(managedAccount?: `0x${string}`): { ctx: Ctx; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const ctx = {
    name: 'lp-range',
    chainId: 56,
    account: { address: '0x1111111111111111111111111111111111111111', type: 'local' },
    log: () => {},
    state: {
      get: <T,>(key: string, fallback: T): T => (store.has(key) ? (store.get(key) as T) : fallback),
      set: (key: string, value: unknown) => void store.set(key, value),
    },
    ...(managedAccount ? { managedAccount } : {}),
  } as unknown as Ctx;
  return { ctx, store };
}

function bound(ctx: Ctx) {
  const out = venueContext(ctx);
  assert.ok(!('configError' in out), 'venue resolved');
  return out;
}

test('own capital runs on the selected venue; a managed mandate stays on the venue its session policy names', () => {
  assert.equal(bound(fakeCtx().ctx).venue.name, 'uniswap-v3');
  const managed = bound(fakeCtx('0x2222222222222222222222222222222222222222').ctx);
  assert.equal(managed.venue.name, 'pancakeswap-v3');
  assert.equal(managed.venue.positionManager, LP_VENUES['pancakeswap-v3'].positionManager);
});

test('on a non-default venue only the position state is kept apart; a pending order is the wallet\'s', () => {
  const { ctx, store } = fakeCtx();
  const own = bound(ctx);
  own.state.set('position', { tokenId: '1' });
  own.state.set('poolInfo', { pool: '0xpool' });
  own.state.set('mintedTokenIds', ['1']);
  own.state.set('pendingOrder', { uid: '0xorder' });
  own.state.set('rebalanceTimes', [1]);
  assert.deepEqual(
    [...store.keys()].sort(),
    ['pendingOrder', 'rebalanceTimes', 'venue:uniswap-v3:mintedTokenIds', 'venue:uniswap-v3:poolInfo', 'venue:uniswap-v3:position'],
  );
  // The PancakeSwap position written before the switch is invisible here, not misread.
  store.set('position', { tokenId: 'pancake-7271073' });
  assert.deepEqual(own.state.get('position', null), { tokenId: '1' });
  // A managed context reads the plain keys, exactly as before the venue switch existed.
  const managed = bound(fakeCtx('0x2222222222222222222222222222222222222222').ctx);
  managed.state.set('position', { tokenId: 'm' });
  assert.deepEqual(managed.state.get('position', null), { tokenId: 'm' });
});
