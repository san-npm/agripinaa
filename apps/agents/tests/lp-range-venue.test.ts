import assert from 'node:assert/strict';
import { test } from 'node:test';

/** The venue is chosen once at import, like the runner does. */
process.env.LP_RANGE_VENUE = 'uniswap-v3';

const { managedStrategyFor } = await import('@agripinaa/shared');
const { knownMintedTokenIds, managedPositionStateKey, venueContext } = await import('../src/agents/lp-range');
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

test('own capital runs on the selected venue; a managed mandate runs on the venue its session policy names', () => {
  assert.equal(bound(fakeCtx().ctx).venue.name, 'uniswap-v3');
  const managed = bound(fakeCtx('0x2222222222222222222222222222222222222222').ctx);
  assert.equal(managed.venue.name, 'uniswap-v3');
  assert.equal(managed.venue.positionManager, managedStrategyFor('lp-range')!.callScopes[0]!.to);
  assert.equal(managed.venue.positionManager, LP_VENUES['uniswap-v3'].positionManager);
  assert.equal(managedPositionStateKey(), 'venue:uniswap-v3:position');
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
  // A managed context keeps its position state apart the same way, so a
  // mandate re-activated after the venue change never reads the PancakeSwap
  // position its account held under the earlier policy.
  const { ctx: managedCtx, store: managedStore } = fakeCtx('0x2222222222222222222222222222222222222222');
  managedStore.set('position', { tokenId: 'pancake-7425769' });
  const managed = bound(managedCtx);
  assert.equal(managed.state.get('position', null), null);
  managed.state.set('position', { tokenId: 'm' });
  assert.deepEqual(managedStore.get('venue:uniswap-v3:position'), { tokenId: 'm' });
  managed.state.set('pendingOrder', { uid: '0xorder' });
  assert.deepEqual(managedStore.get('pendingOrder'), { uid: '0xorder' });
});

test('the legacy PancakeSwap mint seed is trusted only by own capital on PancakeSwap', () => {
  const managed = bound(fakeCtx('0x2222222222222222222222222222222222222222').ctx);
  assert.deepEqual([...knownMintedTokenIds(managed)], [], 'a managed Uniswap account starts with no adoptable ids');
  assert.deepEqual(
    [...knownMintedTokenIds({ ...managed, venue: { ...managed.venue, name: 'pancakeswap-v3' as const } })],
    [],
    'a managed account never trusts the seed, whatever venue it is bound to',
  );
  const own = bound(fakeCtx().ctx);
  assert.deepEqual([...knownMintedTokenIds(own)], [], 'own capital on Uniswap does not inherit the PancakeSwap seed');
  own.state.set('mintedTokenIds', ['2745250']);
  assert.deepEqual([...knownMintedTokenIds(own)], ['2745250']);
  const pancake = { ...own, managedAccount: undefined, venue: { ...own.venue, name: 'pancakeswap-v3' as const } };
  assert.deepEqual([...knownMintedTokenIds(pancake)], ['7248592', '2745250']);
});
