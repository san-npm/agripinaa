import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MANAGED_STRATEGIES,
  OPHIS_SETTLEMENT_BSC,
  OPHIS_VAULT_RELAYER_BSC,
  managedStrategyFor,
} from '../src/managed-strategies';

test('managed strategy lookup rejects inherited object keys', () => {
  assert.equal(managedStrategyFor('constructor'), undefined);
  assert.equal(managedStrategyFor('__proto__'), undefined);
  assert.equal(managedStrategyFor('toString'), undefined);
});

const SIX = ['grid', 'grid-b', 'health-factor', 'venus-guardian', 'lp-range', 'weight-rebalancer'];

test('all six non-yield agents have a concrete managed policy', () => {
  assert.deepEqual(Object.keys(MANAGED_STRATEGIES), SIX);
  for (const slug of SIX) {
    const policy = managedStrategyFor(slug);
    assert.ok(policy, slug);
    assert.ok(policy.callScopes.length > 0, slug);
    assert.ok(policy.callScopes.every((scope) => scope.signatures.length > 0), slug);
    assert.ok(policy.depositTokens.length > 0, slug);
  }
});

test('no managed session delegates ERC20 approve or an unscoped target', () => {
  for (const policy of Object.values(MANAGED_STRATEGIES)) {
    for (const scope of policy.callScopes) {
      assert.ok(/^0x[0-9a-fA-F]{40}$/.test(scope.to), policy.slug);
      assert.equal(scope.signatures.includes('approve(address,uint256)'), false, policy.slug);
    }
  }
});

test('Ophis mandates pin both the settlement checker and canonical relayer', () => {
  for (const policy of Object.values(MANAGED_STRATEGIES)) {
    if (!policy.usesOphis) {
      assert.deepEqual(policy.signatureCheckers, [], policy.slug);
      continue;
    }
    assert.deepEqual(policy.signatureCheckers, [OPHIS_SETTLEMENT_BSC], policy.slug);
    assert.ok(policy.approvals.some((approval) => approval.spender === OPHIS_VAULT_RELAYER_BSC), policy.slug);
  }
});

test('Ranger grants the extra WBNB spend ceiling its direct mint requires', () => {
  assert.deepEqual(MANAGED_STRATEGIES['lp-range'].additionalSpendCaps, [
    { token: 'WBNB', amount: '100' },
  ]);
  for (const policy of Object.values(MANAGED_STRATEGIES)) {
    assert.ok(
      policy.additionalSpendCaps.every(({ token }) => policy.depositTokens.includes(token)),
      `${policy.slug}: a direct spend cap must cover only a declared strategy asset`,
    );
  }
});
