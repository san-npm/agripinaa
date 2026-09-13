import assert from 'node:assert/strict';
import { test } from 'node:test';

/** A typo in the knob must stop Ranger's own capital only, never the runner or a mandate. */
process.env.LP_RANGE_VENUE = 'sushi-v3';

const { venueContext, lpRangeAgent } = await import('../src/agents/lp-range');

type Ctx = Parameters<typeof venueContext>[0];
function fakeCtx(managedAccount?: `0x${string}`, logged: unknown[] = []): Ctx {
  return {
    name: 'lp-range', chainId: 56,
    account: { address: '0x1111111111111111111111111111111111111111', type: 'local' },
    log: (row: unknown) => logged.push(row),
    state: { get: <T,>(_k: string, f: T): T => f, set: () => {} },
    ...(managedAccount ? { managedAccount } : {}),
  } as unknown as Ctx;
}

test('own capital reports the bad venue name and sits out; a mandate still binds to PancakeSwap', async () => {
  const own = venueContext(fakeCtx());
  assert.ok('configError' in own && /LP_RANGE_VENUE=sushi-v3/.test(own.configError));
  const logged: unknown[] = [];
  await lpRangeAgent.tick(fakeCtx(undefined, logged));
  assert.deepEqual(logged.map((r) => (r as { event: string }).event), ['config-error']);
  assert.deepEqual(await lpRangeAgent.status(fakeCtx()), { configError: (own as { configError: string }).configError });
  const managed = venueContext(fakeCtx('0x2222222222222222222222222222222222222222'));
  assert.ok(!('configError' in managed) && managed.venue.name === 'pancakeswap-v3');
});
