import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RequestGate } from '../src/request-gate';

test('request gate limits one client inside its window and resets afterward', () => {
  const gate = new RequestGate(2, 1_000, 10);
  const first = gate.enter('ip', 0);
  const second = gate.enter('ip', 0);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok) first.release();
  if (second.ok) second.release();
  assert.equal(gate.enter('ip', 1).ok, false);
  assert.equal(gate.enter('ip', 1_001).ok, true);
});

test('request gate caps concurrent validation globally', () => {
  const gate = new RequestGate(10, 1_000, 1);
  const first = gate.enter('one', 0);
  assert.equal(first.ok, true);
  assert.equal(gate.enter('two', 0).ok, false);
  if (first.ok) first.release();
  assert.equal(gate.enter('two', 0).ok, true);
});

test('request gate bounds unique-client memory', () => {
  const gate = new RequestGate(2, 1_000, 10, 2);
  assert.equal(gate.enter('a', 0).ok, true);
  assert.equal(gate.enter('b', 0).ok, true);
  assert.equal(gate.enter('c', 0).ok, false);
  assert.equal(gate.enter('c', 1_001).ok, true);
});
