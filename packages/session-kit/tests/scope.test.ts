import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOKENS_BSC } from '@agripinaa/shared';
import {
  MAX_SESSION_SECONDS,
  buildSessionScope,
  describeScope,
  type Address,
  type SessionScopeInput,
} from '../src/index';

const TARGET: Address = '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd';

function validInput(overrides: Partial<SessionScopeInput> = {}): SessionScopeInput {
  return {
    allowlist: [TARGET],
    spendCap: { token: 'USDT', amount: '50', period: 'day' },
    expiresInSeconds: 3600,
    ...overrides,
  };
}

test('empty allowlist throws (fail-closed against upstream unrestricted default)', () => {
  assert.throws(() => buildSessionScope(validInput({ allowlist: [] })), /allowlist-required/);
});

test('missing allowlist throws', () => {
  assert.throws(
    () => buildSessionScope(validInput({ allowlist: undefined as unknown as Address[] })),
    /allowlist-required/,
  );
});

test('malformed allowlist entry throws', () => {
  assert.throws(
    () => buildSessionScope(validInput({ allowlist: ['0x123' as Address] })),
    /allowlist-address-shape/,
  );
});

test('zero expiry throws', () => {
  assert.throws(
    () => buildSessionScope(validInput({ expiresInSeconds: 0 })),
    /positive-integer-expiry/,
  );
});

test('negative expiry throws', () => {
  assert.throws(
    () => buildSessionScope(validInput({ expiresInSeconds: -60 })),
    /positive-integer-expiry/,
  );
});

test('non-integer expiry throws', () => {
  assert.throws(
    () => buildSessionScope(validInput({ expiresInSeconds: 1.5 })),
    /positive-integer-expiry/,
  );
});

test('expiry beyond 30 days throws', () => {
  assert.throws(
    () => buildSessionScope(validInput({ expiresInSeconds: MAX_SESSION_SECONDS + 1 })),
    /max-expiry-30-days/,
  );
});

test('expiry of exactly 30 days is accepted', () => {
  const scope = buildSessionScope(validInput({ expiresInSeconds: MAX_SESSION_SECONDS }));
  assert.equal(typeof scope.expiry, 'number');
});

test('unknown token throws', () => {
  assert.throws(
    () =>
      buildSessionScope(
        validInput({ spendCap: { token: 'DOGE' as 'USDT', amount: '1', period: 'day' } }),
      ),
    /known-token/,
  );
});

test('non-day period throws', () => {
  assert.throws(
    () =>
      buildSessionScope(
        validInput({ spendCap: { token: 'USDT', amount: '1', period: 'week' as 'day' } }),
      ),
    /day-period-only/,
  );
});

test('malformed amount throws (delegated to toBaseUnits)', () => {
  assert.throws(() =>
    buildSessionScope(validInput({ spendCap: { token: 'USDT', amount: 'fifty', period: 'day' } })),
  );
});

test('"50" USDT cap converts to 50n * 10n**18n (18 decimals on BNB)', () => {
  const scope = buildSessionScope(validInput());
  assert.equal(scope.permissions.spend.length, 1);
  assert.equal(scope.permissions.spend[0]?.limit, 50n * 10n ** 18n);
});

test('spend entry carries the token address (a token-less cap would cap native BNB)', () => {
  const scope = buildSessionScope(validInput());
  assert.equal(scope.permissions.spend[0]?.token, TOKENS_BSC.USDT?.address);
  const usdc = buildSessionScope(
    validInput({ spendCap: { token: 'USDC', amount: '50', period: 'day' } }),
  );
  assert.equal(usdc.permissions.spend[0]?.token, TOKENS_BSC.USDC?.address);
});

test('calls mirror the allowlist exactly', () => {
  const second: Address = '0x55d398326f99059fF775485246999027B3197955';
  const scope = buildSessionScope(validInput({ allowlist: [TARGET, second] }));
  assert.deepEqual(scope.permissions.calls, [{ to: TARGET }, { to: second }]);
});

test('expiry is now + expiresInSeconds', () => {
  const before = Math.floor(Date.now() / 1000);
  const scope = buildSessionScope(validInput({ expiresInSeconds: 3600 }));
  const after = Math.floor(Date.now() / 1000);
  assert.ok(scope.expiry >= before + 3600);
  assert.ok(scope.expiry <= after + 3600);
});

test('describeScope formats a summary for UI rendering', () => {
  const scope = buildSessionScope(
    validInput({ spendCap: { token: 'USDT', amount: '50.5', period: 'day' } }),
  );
  const summary = describeScope(scope);
  assert.equal(summary.allowlistCount, 1);
  assert.equal(summary.capFormatted, '50.5 USDT per day');
  assert.equal(summary.expiresAt, new Date(scope.expiry * 1000).toISOString());
});

test('describeScope falls back to base units for an unknown token address', () => {
  const scope = buildSessionScope(validInput());
  const foreign = {
    ...scope,
    permissions: {
      ...scope.permissions,
      spend: [
        {
          limit: 7n,
          period: 'day' as const,
          token: '0x0000000000000000000000000000000000000001' as Address,
        },
      ],
    },
  };
  const summary = describeScope(foreign);
  assert.equal(
    summary.capFormatted,
    '7 base units of 0x0000000000000000000000000000000000000001 per day',
  );
});

// --- Managed per-selector scopes + native gas cap (drain-proof yield sessions) ---

const ROUTER: Address = '0x841CF14Dfc0A315115EC5C9714c918210447b260';

test('callScopes emit one {signature,to} per selector', () => {
  const scope = buildSessionScope({
    callScopes: [{ to: ROUTER, signatures: ['toAave()', 'toVenus()', 'toIdle()'] }],
    spendCap: { token: 'USDT', amount: '50', period: 'day' },
    expiresInSeconds: 3600,
  });
  assert.deepEqual(scope.permissions.calls, [
    { signature: 'toAave()', to: ROUTER },
    { signature: 'toVenus()', to: ROUTER },
    { signature: 'toIdle()', to: ROUTER },
  ]);
});

test('providing both allowlist and callScopes throws', () => {
  assert.throws(
    () =>
      buildSessionScope({
        allowlist: [ROUTER],
        callScopes: [{ to: ROUTER, signatures: ['toAave()'] }],
        spendCap: { token: 'USDT', amount: '50', period: 'day' },
        expiresInSeconds: 3600,
      }),
    /one-call-shape/,
  );
});

test('empty signatures list throws (would widen to every selector)', () => {
  assert.throws(
    () =>
      buildSessionScope({
        callScopes: [{ to: ROUTER, signatures: [] }],
        spendCap: { token: 'USDT', amount: '50', period: 'day' },
        expiresInSeconds: 3600,
      }),
    /call-scope-nonempty/,
  );
});

test('a bare selector or function name (not a signature) throws', () => {
  for (const bad of ['toAave', '0xdb1a4d6d', 'toAave(']) {
    assert.throws(
      () =>
        buildSessionScope({
          callScopes: [{ to: ROUTER, signatures: [bad] }],
          spendCap: { token: 'USDT', amount: '50', period: 'day' },
          expiresInSeconds: 3600,
        }),
      /call-scope-signature-shape/,
      `expected "${bad}" to be rejected`,
    );
  }
});

test('a malformed router address in callScopes throws', () => {
  assert.throws(
    () =>
      buildSessionScope({
        callScopes: [{ to: '0xabc' as Address, signatures: ['toAave()'] }],
        spendCap: { token: 'USDT', amount: '50', period: 'day' },
        expiresInSeconds: 3600,
      }),
    /allowlist-address-shape/,
  );
});

test('nativeGasCap adds a token-less native spend entry alongside the USDT cap', () => {
  const scope = buildSessionScope({
    callScopes: [{ to: ROUTER, signatures: ['toAave()'] }],
    spendCap: { token: 'USDT', amount: '50', period: 'day' },
    nativeGasCap: { amount: '0.02', period: 'day' },
    expiresInSeconds: 3600,
  });
  assert.equal(scope.permissions.spend.length, 2);
  assert.equal(scope.permissions.spend[0]?.token, TOKENS_BSC.USDT?.address);
  assert.equal(scope.permissions.spend[1]?.token, undefined);
  assert.equal(scope.permissions.spend[1]?.limit, 2n * 10n ** 16n); // 0.02 BNB
});

// --- Porto wildcard sentinels must never produce a scope (codex finding) ---

const ANY_TARGET = '0x3232323232323232323232323232323232323232' as Address;
const SELF_TARGET = '0x2323232323232323232323232323232323232323' as Address;

test('allowlist with Porto anyTarget wildcard throws', () => {
  assert.throws(
    () => buildSessionScope(validInput({ allowlist: [ANY_TARGET] })),
    /no-wildcard-target/,
  );
});

test('allowlist with Porto selfAddress sentinel throws', () => {
  assert.throws(
    () => buildSessionScope(validInput({ allowlist: [SELF_TARGET] })),
    /no-wildcard-target/,
  );
});

test('callScopes targeting the anyTarget wildcard throws', () => {
  assert.throws(
    () =>
      buildSessionScope({
        callScopes: [{ to: ANY_TARGET, signatures: ['toAave()'] }],
        spendCap: { token: 'USDT', amount: '50', period: 'day' },
        expiresInSeconds: 3600,
      }),
    /no-wildcard-target/,
  );
});

test('a mixed allowlist with one wildcard entry is rejected wholesale', () => {
  assert.throws(
    () => buildSessionScope(validInput({ allowlist: [TARGET, ANY_TARGET] })),
    /no-wildcard-target/,
  );
});
