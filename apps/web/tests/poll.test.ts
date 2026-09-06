import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { startPolling } from '../src/lib/poll';

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('dashboard polling refreshes after unavailable status, without overlapping reads', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  let finish!: () => void;
  const stop = startPolling(async () => {
    reads += 1;
    if (reads === 1) await new Promise<void>((resolve) => { finish = resolve; });
    if (reads === 2) throw new Error('temporarily unavailable');
  });
  t.mock.timers.tick(0);
  assert.equal(reads, 1);
  t.mock.timers.tick(60_000);
  assert.equal(reads, 1, 'slow reads must not overlap');
  finish();
  await settle();
  t.mock.timers.tick(15_000);
  await settle();
  assert.equal(reads, 2);
  t.mock.timers.tick(15_000);
  await settle();
  assert.equal(reads, 3, 'an error must not freeze the dashboard');
  stop();
  t.mock.timers.tick(60_000);
  assert.equal(reads, 3);
});

test('unmount stops both initial and in-flight refreshes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  let finish!: () => void;
  const read = async () => {
    reads += 1;
    await new Promise<void>((resolve) => { finish = resolve; });
  };
  startPolling(read)();
  t.mock.timers.tick(0);
  assert.equal(reads, 0);
  const stop = startPolling(read);
  t.mock.timers.tick(0);
  stop();
  finish();
  await settle();
  t.mock.timers.tick(60_000);
  assert.equal(reads, 1);
});

test('all live session cards use the cancellable polling path', () => {
  for (const name of ['ManagedPositionCard', 'StrategyPositionCard', 'SessionCard']) {
    const source = readFileSync(new URL(`../src/components/${name}.tsx`, import.meta.url), 'utf8');
    assert.match(source, /const stop = startPolling\(/, name);
    assert.match(source, /cancelled = true;\s+stop\(\)/, name);
  }
});
