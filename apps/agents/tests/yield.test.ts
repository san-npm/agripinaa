import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  aaveApyBps,
  chooseFirstVenue,
  decideRotation,
  deriveBlocksPerYear,
  detectVenue,
  venusApyBps,
} from '../src/agents/yield';

describe('deriveBlocksPerYear', () => {
  it('extrapolates from two block timestamps', () => {
    // 5000 blocks in 2250s = 0.45s/block => 31,536,000 / 0.45 = 70,080,000
    assert.equal(deriveBlocksPerYear(BigInt(10_000), BigInt(7_750), 5000), 70_080_000);
  });

  it('handles legacy 3s cadence', () => {
    assert.equal(deriveBlocksPerYear(BigInt(15_000), BigInt(0), 5000), 10_512_000);
  });

  it('throws on non-positive elapsed time', () => {
    assert.throws(() => deriveBlocksPerYear(BigInt(100), BigInt(100), 5000));
    assert.throws(() => deriveBlocksPerYear(BigInt(50), BigInt(100), 5000));
  });

  it('throws on non-positive span', () => {
    assert.throws(() => deriveBlocksPerYear(BigInt(100), BigInt(50), 0));
  });
});

describe('venusApyBps', () => {
  it('converts a WAD per-block rate to bps APR', () => {
    // 1e9 per block * 10,512,000 blocks / 1e18 = 1.0512% = 105.12 bps
    const bps = venusApyBps(BigInt('1000000000'), 10_512_000);
    assert.ok(Math.abs(bps - 105.12) < 1e-9, `got ${bps}`);
  });

  it('is zero for a zero rate', () => {
    assert.equal(venusApyBps(BigInt(0), 70_000_000), 0);
  });

  it('scales linearly with block cadence', () => {
    const slow = venusApyBps(BigInt('1000000000'), 10_512_000);
    const fast = venusApyBps(BigInt('1000000000'), 21_024_000);
    assert.ok(Math.abs(fast - slow * 2) < 1e-9);
  });
});

describe('aaveApyBps', () => {
  it('converts a RAY annual rate to bps', () => {
    // 0.02e27 = 2% APR = 200 bps
    assert.equal(aaveApyBps(BigInt('20000000000000000000000000')), 200);
  });

  it('is zero for a zero rate', () => {
    assert.equal(aaveApyBps(BigInt(0)), 0);
  });

  it('handles the probed mainnet magnitude', () => {
    const bps = aaveApyBps(BigInt('20677442659781966265526085'));
    assert.ok(bps > 200 && bps < 215, `got ${bps}`);
  });
});

describe('chooseFirstVenue', () => {
  it('picks the higher APY venue', () => {
    assert.equal(chooseFirstVenue(200, 300), 'aave');
    assert.equal(chooseFirstVenue(300, 200), 'venus');
  });

  it('ties go to venus', () => {
    assert.equal(chooseFirstVenue(250, 250), 'venus');
  });
});

describe('detectVenue', () => {
  const dust = BigInt('10000000000000000'); // 0.01 in 18 decimals

  it('reports none when both positions are dust', () => {
    assert.equal(detectVenue(BigInt(0), BigInt(0), dust), 'none');
    assert.equal(detectVenue(dust, dust, dust), 'none');
  });

  it('reports the single funded venue', () => {
    const size = BigInt('5000000000000000000');
    assert.equal(detectVenue(size, BigInt(0), dust), 'venus');
    assert.equal(detectVenue(BigInt(0), size, dust), 'aave');
  });

  it('resolves a double position to the larger side', () => {
    const small = BigInt('1000000000000000000');
    const large = BigInt('4000000000000000000');
    assert.equal(detectVenue(large, small, dust), 'venus');
    assert.equal(detectVenue(small, large, dust), 'aave');
  });
});

describe('decideRotation', () => {
  it('holds and keeps streak at zero when edge is inside hysteresis', () => {
    const d = decideRotation({ venue: 'venus', venusBps: 200, aaveBps: 240, betterStreak: 0 });
    assert.equal(d.action, 'hold');
    assert.equal(d.nextStreak, 0);
    assert.equal(d.edgeBps, 40);
  });

  it('holds at exactly the hysteresis boundary (strictly greater required)', () => {
    const d = decideRotation({ venue: 'venus', venusBps: 200, aaveBps: 250, betterStreak: 5 });
    assert.equal(d.action, 'hold');
    assert.equal(d.nextStreak, 0);
  });

  it('first qualifying check only arms the streak', () => {
    const d = decideRotation({ venue: 'venus', venusBps: 200, aaveBps: 260, betterStreak: 0 });
    assert.equal(d.action, 'hold');
    assert.equal(d.nextStreak, 1);
  });

  it('second consecutive qualifying check rotates and resets the streak', () => {
    const d = decideRotation({ venue: 'venus', venusBps: 200, aaveBps: 260, betterStreak: 1 });
    assert.equal(d.action, 'rotate');
    assert.equal(d.target, 'aave');
    assert.equal(d.nextStreak, 0);
    assert.equal(d.edgeBps, 60);
  });

  it('streak resets when the edge flips before the second check', () => {
    const armed = decideRotation({ venue: 'venus', venusBps: 200, aaveBps: 260, betterStreak: 0 });
    assert.equal(armed.nextStreak, 1);
    const flipped = decideRotation({ venue: 'venus', venusBps: 260, aaveBps: 200, betterStreak: armed.nextStreak });
    assert.equal(flipped.action, 'hold');
    assert.equal(flipped.nextStreak, 0);
    assert.equal(flipped.edgeBps, -60);
  });

  it('is symmetric from the aave side', () => {
    const d = decideRotation({ venue: 'aave', venusBps: 280, aaveBps: 200, betterStreak: 1 });
    assert.equal(d.action, 'rotate');
    assert.equal(d.target, 'venus');
    assert.equal(d.edgeBps, 80);
  });

  it('respects custom hysteresis and streak parameters', () => {
    const wide = decideRotation({
      venue: 'venus', venusBps: 200, aaveBps: 290, betterStreak: 1, hysteresisBps: 100,
    });
    assert.equal(wide.action, 'hold');
    assert.equal(wide.nextStreak, 0);

    const patient = decideRotation({
      venue: 'venus', venusBps: 200, aaveBps: 290, betterStreak: 1, requiredStreak: 3,
    });
    assert.equal(patient.action, 'hold');
    assert.equal(patient.nextStreak, 2);

    const trigger = decideRotation({
      venue: 'venus', venusBps: 200, aaveBps: 290, betterStreak: 2, requiredStreak: 3,
    });
    assert.equal(trigger.action, 'rotate');
  });
});
