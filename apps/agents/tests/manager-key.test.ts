import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { MANAGED_TOKENS, PRIMARY_MANAGED_TOKEN } from '@agripinaa/shared';
import { keccak256, stringToHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  buildManagerKeySet,
  deriveManagerKey,
  managerKeySetFrom,
  type ManagerKey,
} from '../src/manager-key';

/**
 * A synthetic master key, derived in-test so no wallet file is read and no
 * secret is committed. Its addresses below are pinned on purpose: they are
 * the tripwire for the two ways an on-chain key identity can move without
 * anyone meaning to move it.
 */
const TEST_MASTER_PRIV = keccak256(stringToHex('agripinaa manager-key test vector')) as Hex;

function testMaster(): ManagerKey {
  const account = privateKeyToAccount(TEST_MASTER_PRIV);
  return { privateKey: TEST_MASTER_PRIV, address: account.address, publicKey: account.publicKey };
}

const MASTER_ADDRESS = '0xF51df94Ec1f73c2557DDEeB3A6F7045f485C6980';
const DERIVED_USDC_ADDRESS = '0xEaF9ec3569042530473846772eD49219ccBfBEd0';

test('the primary managed token is a member of the display array', () => {
  assert.ok(
    (MANAGED_TOKENS as readonly string[]).includes(PRIMARY_MANAGED_TOKEN),
    'PRIMARY_MANAGED_TOKEN must name a token that actually has a router',
  );
});

test('the master key stays on the primary token whatever the display order is', () => {
  const master = testMaster();
  assert.equal(master.address, MASTER_ADDRESS, 'test vector drifted');

  const displayOrder = managerKeySetFrom(master, MANAGED_TOKENS, PRIMARY_MANAGED_TOKEN);
  const reversed = managerKeySetFrom(
    master,
    [...MANAGED_TOKENS].reverse(),
    PRIMARY_MANAGED_TOKEN,
  );

  // Reordering MANAGED_TOKENS is a cosmetic edit: it changes which button the
  // wizard renders first. It must not decide which token holds the master key,
  // because every live mandate for that token was granted to the master public
  // key and the executor rejects any other signer.
  for (const symbol of MANAGED_TOKENS) {
    assert.equal(
      displayOrder.byToken.get(symbol)!.address,
      reversed.byToken.get(symbol)!.address,
      `${symbol}: manager key moved when the display array was reordered`,
    );
  }
  assert.equal(displayOrder.byToken.get(PRIMARY_MANAGED_TOKEN)!.address, MASTER_ADDRESS);
});

test('derived addresses are pinned, so a derivation change fails CI not production', () => {
  const master = testMaster();
  // Changing the derivation tag (adding a chain id, renaming the prefix)
  // silently orphans every mandate already granted to the old address. If this
  // assertion fails, that is the change under review, not a stale fixture.
  assert.equal(deriveManagerKey(master, 'USDC').address, DERIVED_USDC_ADDRESS);
  assert.equal(
    managerKeySetFrom(master, MANAGED_TOKENS, PRIMARY_MANAGED_TOKEN).byToken.get('USDC')!.address,
    DERIVED_USDC_ADDRESS,
  );
});

test('every manager key is reachable by its own public key', () => {
  const set = managerKeySetFrom(testMaster(), MANAGED_TOKENS, PRIMARY_MANAGED_TOKEN);
  for (const symbol of MANAGED_TOKENS) {
    const key = set.byToken.get(symbol)!;
    assert.equal(set.byPublicKey.get(key.publicKey.toLowerCase())!.address, key.address);
  }
  assert.equal(set.byToken.size, MANAGED_TOKENS.length);
});

test('taking the primary from the display array is what used to rotate the key', () => {
  const master = testMaster();
  const reversed: string[] = [...MANAGED_TOKENS].reverse();
  const firstAfterReorder = reversed[0]!;
  // What the runner did before: the primary came from position 0 of the display
  // array. With the array reordered, the master key lands on the other token
  // and every mandate held by the master public key is stranded.
  const rotated = managerKeySetFrom(master, reversed, firstAfterReorder);
  assert.notEqual(rotated.byToken.get(PRIMARY_MANAGED_TOKEN)!.address, MASTER_ADDRESS);
  assert.equal(rotated.byToken.get(firstAfterReorder)!.address, MASTER_ADDRESS);
});

test('the runner does not take the manager-key primary from the display array', () => {
  // The library above cannot enforce this: the coupling can only be
  // reintroduced at the call site, and that call site is the one place a
  // cosmetic edit reaches on-chain key identity.
  const src = readFileSync(new URL('../src/runner.ts', import.meta.url), 'utf8');
  assert.ok(
    src.includes('buildManagerKeySet(name, MANAGED_TOKENS, PRIMARY_MANAGED_TOKEN)'),
    'runner.ts must pass PRIMARY_MANAGED_TOKEN as the manager-key primary',
  );
  assert.ok(
    !/MANAGED_TOKENS\[\d+\]/.test(src),
    'runner.ts indexes MANAGED_TOKENS: display order must not decide key identity',
  );
});

test('a primary that is not among the symbols is rejected, not silently derived', () => {
  const master = testMaster();
  // Without this, an unknown primary hands every token a derived key and the
  // master key holds no mandate at all, which fails only at tick time.
  assert.throws(() => managerKeySetFrom(master, MANAGED_TOKENS, 'BUSD'), /BUSD/);
  assert.throws(() => buildManagerKeySet('yield', MANAGED_TOKENS, 'BUSD'), /BUSD/);
});
