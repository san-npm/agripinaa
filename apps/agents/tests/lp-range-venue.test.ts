import assert from 'node:assert/strict';
import { test } from 'node:test';

/** The venue is chosen once at import, like the runner does. */
process.env.LP_RANGE_VENUE = 'uniswap-v3';

const { venueContext, venueOf } = await import('../src/agents/lp-range');
const { LP_VENUES } = await import('../src/lp-venues');

type Ctx = Parameters<typeof venueContext>[0];

function fakeCtx(accountType: 'local' | 'json-rpc'): { ctx: Ctx; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const ctx = {
    name: 'lp-range',
    chainId: 56,
    account: { address: '0x1111111111111111111111111111111111111111', type: accountType },
    log: () => {},
    state: {
      get: <T,>(key: string, fallback: T): T => (store.has(key) ? (store.get(key) as T) : fallback),
      set: (key: string, value: unknown) => void store.set(key, value),
    },
  } as unknown as Ctx;
  return { ctx, store };
}

test('own capital runs on the selected venue; a managed mandate stays on the venue its session policy names', () => {
  const own = venueContext(fakeCtx('local').ctx);
  assert.equal(venueOf(own).name, 'uniswap-v3');
  const managed = venueContext(fakeCtx('json-rpc').ctx);
  assert.equal(venueOf(managed).name, 'pancakeswap-v3');
  assert.equal(venueOf(managed).positionManager, LP_VENUES['pancakeswap-v3'].positionManager);
});

test('on a non-default venue only the position state is kept apart; a pending order is the wallet\'s', () => {
  const { ctx, store } = fakeCtx('local');
  const own = venueContext(ctx);
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
  const managed = venueContext(fakeCtx('json-rpc').ctx);
  managed.state.set('position', { tokenId: 'm' });
  assert.deepEqual(managed.state.get('position', null), { tokenId: 'm' });
});
