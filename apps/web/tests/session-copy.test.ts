import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SESSION_GRANTED_COPY,
  readableManagedCeilings,
  readableSessionCeiling,
  sessionGrantedBody,
} from '../src/lib/session-copy';

/**
 * The third-party activation path grants a session that is stored in the
 * visitor's browser and handed to nobody: SessionWizard renders only for an
 * agent this site does not run, and no code path passes the key to it. The
 * copy has to say that, because the state it used to describe ("Session
 * active", "now holds a scoped, revocable key") never happened.
 */

const lines = [
  SESSION_GRANTED_COPY.headline,
  sessionGrantedBody('Some Agent'),
  SESSION_GRANTED_COPY.toastTitle,
  SESSION_GRANTED_COPY.toastDetail,
];

test('the granted copy claims no handoff that does not happen', () => {
  for (const line of lines) {
    assert.doesNotMatch(line, /now active/i, line);
    assert.doesNotMatch(line, /now holds/i, line);
    assert.doesNotMatch(line, /session active/i, line);
  }
});

test('the granted copy says where the key is and what has to happen next', () => {
  const body = sessionGrantedBody('Some Agent');
  assert.match(body, /stored in this browser/i);
  assert.match(body, /Some Agent/, 'the agent is named in the body');
  assert.match(SESSION_GRANTED_COPY.toastDetail, /stored in this browser/i);
  // The visitor is the one who has to pass it on, so both say so.
  assert.match(body, /you pass it to the agent/i);
  assert.match(SESSION_GRANTED_COPY.toastDetail, /given it/i);
});

test('the granted copy follows the repo copy rules', () => {
  for (const line of lines) {
    assert.doesNotMatch(line, /[–—]/, `dash in: ${line}`);
    assert.doesNotMatch(line, /\b(honest|genuine|authentic|factual)\b/i, `praise in: ${line}`);
  }
});

test('strategy ceiling copy removes the misleading inventory label and groups the amount', () => {
  assert.equal(
    readableSessionCeiling('Dedicated strategy-account inventory; 1000000 USDT per day direct-call cap'),
    '1,000,000 USDT per day for allowlisted direct calls',
  );
});

test('managed strategy copy lists stable, additional-token, and native BNB ceilings', () => {
  assert.deepEqual(
    readableManagedCeilings(
      'Dedicated strategy-account inventory; 1000000 USDT per day direct-call cap',
      [{ token: 'WBNB', amount: '100' }],
      '0.005',
    ),
    [
      '1,000,000 USDT per day for allowlisted direct calls',
      '100 WBNB per day for allowlisted direct calls',
      '0.005 BNB per day for native value on allowlisted calls and transaction gas',
    ],
  );
});

test('ceiling formatting preserves every fractional digit and large integer exactly', () => {
  assert.equal(readableSessionCeiling('0.0001 USDT per day'), '0.0001 USDT per day');
  assert.equal(readableSessionCeiling('25.123456 USDT per day'), '25.123456 USDT per day');
  assert.equal(
    readableSessionCeiling('9007199254740993 USDT per day'),
    '9,007,199,254,740,993 USDT per day',
  );
});
