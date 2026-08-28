import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ALTANA_ORCHESTRATOR_BSC } from '@agripinaa/shared/funding';

import {
  lifetimeOptionForExistingSession,
  recoverExistingSession,
  type RecoveryDependencies,
} from '../src/lib/session-recovery';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;
const MANAGER = {
  address: '0x2222222222222222222222222222222222222222' as const,
  publicKey: `0x04${'11'.repeat(64)}` as const,
};
const ROUTER = '0x3333333333333333333333333333333333333333' as const;
const TOKEN = '0x4444444444444444444444444444444444444444' as const;
const CHECKER = '0x5555555555555555555555555555555555555555' as const;
const EXPIRY = 1_900_000_000;
const SCOPE = {
  permissions: {
    calls: [{ to: ROUTER, signature: 'rebalance()' }],
    spend: [
      { token: TOKEN, period: 'day' as const, limit: 10n },
      { period: 'day' as const, limit: 1n },
    ],
  },
  expiry: EXPIRY + 100,
};

function dependencies(overrides: Partial<RecoveryDependencies> = {}): RecoveryDependencies {
  return {
    findExpiry: async () => EXPIRY,
    isKeyValid: async () => true,
    wasKeyRegistered: async () => true,
    isDescriptorValid: async () => true,
    waitBeforeRetry: async () => {},
    ...overrides,
  };
}

test('returns null only when the descriptor and historical KeyStore record are absent', async () => {
  let descriptorReads = 0;
  const recovered = await recoverExistingSession({
    account: ACCOUNT,
    manager: MANAGER,
    scope: SCOPE,
    signatureCheckers: [CHECKER],
    signer: { type: 'verify-only' },
    dependencies: dependencies({
      findExpiry: async () => null,
      isKeyValid: async () => false,
      wasKeyRegistered: async () => false,
      isDescriptorValid: async () => {
        descriptorReads += 1;
        return true;
      },
    }),
  });
  assert.equal(recovered, null);
  assert.equal(descriptorReads, 0);
});

test('waits through a stale all-negative snapshot before deciding to grant', async () => {
  let observations = 0;
  let waits = 0;
  const recovered = await recoverExistingSession({
    account: ACCOUNT,
    manager: MANAGER,
    scope: SCOPE,
    signatureCheckers: [CHECKER],
    signer: {},
    nowSeconds: EXPIRY - 100,
    dependencies: dependencies({
      findExpiry: async () => (++observations >= 2 ? EXPIRY : null),
      isKeyValid: async () => observations >= 2,
      wasKeyRegistered: async () => observations >= 2,
      waitBeforeRetry: async () => { waits += 1; },
    }),
  });
  assert.ok(recovered);
  assert.equal(observations, 2);
  assert.equal(waits, 1);
});

test('never lets later all-negative snapshots erase positive registration evidence', async () => {
  let registrationReads = 0;
  let waits = 0;
  await assert.rejects(
    recoverExistingSession({
      account: ACCOUNT,
      manager: MANAGER,
      scope: SCOPE,
      signatureCheckers: [CHECKER],
      signer: {},
      dependencies: dependencies({
        findExpiry: async () => null,
        isKeyValid: async () => false,
        wasKeyRegistered: async () => registrationReads++ === 0,
        waitBeforeRetry: async () => { waits += 1; },
      }),
    }),
    /registered or partially visible on-chain/,
  );
  assert.equal(registrationReads, 4);
  assert.equal(waits, 3);
});

test('never lets later all-negative snapshots erase a visible account descriptor', async () => {
  let expiryReads = 0;
  await assert.rejects(
    recoverExistingSession({
      account: ACCOUNT,
      manager: MANAGER,
      scope: SCOPE,
      signatureCheckers: [CHECKER],
      signer: {},
      nowSeconds: EXPIRY - 100,
      dependencies: dependencies({
        findExpiry: async () => expiryReads++ === 0 ? EXPIRY : null,
        isKeyValid: async () => false,
        wasKeyRegistered: async () => false,
      }),
    }),
    /registered or partially visible on-chain/,
  );
  assert.equal(expiryReads, 4);
});

test('fails closed when positive account descriptors disagree across retries', async () => {
  let expiryReads = 0;
  await assert.rejects(
    recoverExistingSession({
      account: ACCOUNT,
      manager: MANAGER,
      scope: SCOPE,
      signatureCheckers: [CHECKER],
      signer: {},
      nowSeconds: EXPIRY - 100,
      dependencies: dependencies({
        findExpiry: async () => ++expiryReads === 1 ? EXPIRY - 1 : EXPIRY,
        isKeyValid: async () => expiryReads >= 2,
        wasKeyRegistered: async () => expiryReads >= 2,
      }),
    }),
    /conflicting manager-session expiries/,
  );
});

test('rebuilds only an exact live descriptor and preserves its on-chain expiry', async () => {
  const observed: unknown[] = [];
  const signer = { type: 'verify-only' as const };
  const recovered = await recoverExistingSession({
    account: ACCOUNT,
    manager: MANAGER,
    scope: SCOPE,
    signatureCheckers: [CHECKER],
    signer,
    nowSeconds: EXPIRY - 100,
    dependencies: dependencies({
      isDescriptorValid: async (args) => {
        observed.push(args);
        return args.permissions.signatureCheckers?.length === 1;
      },
    }),
  });
  assert.ok(recovered);
  assert.equal(recovered.session.expiry, EXPIRY);
  assert.equal(recovered.session.walletAddress, ACCOUNT);
  assert.equal(recovered.session.publicKey, MANAGER.publicKey);
  assert.equal(recovered.session.signer, signer);
  assert.deepEqual(recovered.session.permissions, SCOPE.permissions);
  assert.deepEqual(recovered.approvedSignatureCheckers, [CHECKER]);
  const checked = observed[0] as {
    sessionAddress: string;
    permissions: { relayOrchestrator?: string };
  };
  assert.equal(checked.sessionAddress, MANAGER.address);
  assert.equal(checked.permissions.relayOrchestrator, ALTANA_ORCHESTRATOR_BSC);
});

test('recovers a session whose checker approval is still pending', async () => {
  const recovered = await recoverExistingSession({
    account: ACCOUNT,
    manager: MANAGER,
    scope: SCOPE,
    signatureCheckers: [CHECKER],
    signer: {},
    nowSeconds: EXPIRY - 100,
    dependencies: dependencies({
      isDescriptorValid: async (args) => args.permissions.signatureCheckers?.length === 0,
    }),
  });
  assert.ok(recovered);
  assert.deepEqual(recovered.approvedSignatureCheckers, []);
});

test('fails closed for inconsistent or non-canonical existing authority', async () => {
  await assert.rejects(
    recoverExistingSession({
      account: ACCOUNT,
      manager: MANAGER,
      scope: SCOPE,
      signatureCheckers: [CHECKER],
      signer: {},
      dependencies: dependencies({ findExpiry: async () => null }),
    }),
    /registered or partially visible on-chain/,
  );
  await assert.rejects(
    recoverExistingSession({
      account: ACCOUNT,
      manager: MANAGER,
      scope: SCOPE,
      signatureCheckers: [CHECKER],
      signer: {},
      nowSeconds: EXPIRY - 100,
      dependencies: dependencies({ isDescriptorValid: async () => false }),
    }),
    /does not match this agent's exact on-chain policy/,
  );
});

test('never retries a revoked or expired KeyStore registration', async () => {
  await assert.rejects(
    recoverExistingSession({
      account: ACCOUNT,
      manager: MANAGER,
      scope: SCOPE,
      signatureCheckers: [CHECKER],
      signer: {},
      dependencies: dependencies({
        findExpiry: async () => null,
        isKeyValid: async () => false,
        wasKeyRegistered: async () => true,
      }),
    }),
    /registered or partially visible on-chain/,
  );
});

test('never recovers authority beyond the lifetime selected by the user', async () => {
  await assert.rejects(
    recoverExistingSession({
      account: ACCOUNT,
      manager: MANAGER,
      scope: { ...SCOPE, expiry: EXPIRY - 1 },
      signatureCheckers: [CHECKER],
      signer: {},
      nowSeconds: EXPIRY - 100,
      dependencies: dependencies(),
    }),
    /lasts longer than the lifetime selected/,
  );
});

test('manual preflight discovers and selects the lifetime of an existing 30-day grant', async () => {
  const nowSeconds = EXPIRY - (29 * 24 * 60 * 60);
  const recovered = await recoverExistingSession({
    account: ACCOUNT,
    manager: MANAGER,
    scope: { ...SCOPE, expiry: nowSeconds + (7 * 24 * 60 * 60) },
    signatureCheckers: [CHECKER],
    signer: {},
    maximumExpiry: null,
    nowSeconds,
    dependencies: dependencies(),
  });
  assert.ok(recovered);
  assert.equal(lifetimeOptionForExistingSession(recovered.session.expiry, nowSeconds), 720);
});
