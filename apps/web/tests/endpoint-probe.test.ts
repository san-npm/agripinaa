import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  endpointProbeLabel,
  readEndpointProbe,
  type EndpointProbe,
} from '../src/lib/endpoint-probe';

/**
 * The one phrasing of what a probe found, shared by the claim panel (which
 * renders the result the POST just came back with) and the agent profile
 * (which renders the stored one). Both read the same reason, so an owner is
 * told the same thing wherever they look.
 */

const URL = 'https://agent.example.com/status';
const NOW = Date.parse('2026-08-25T12:00:00.000Z');
const CHECKED_AT = '2026-08-25T11:59:00.000Z';
const DAY = 24 * 60 * 60 * 1_000;

const probe = (over: Partial<EndpointProbe> = {}): EndpointProbe => ({
  url: URL,
  live: true,
  checkedAt: CHECKED_AT,
  status: 200,
  ...over,
});

test('a fresh answer is reported live, with the status it answered', () => {
  assert.equal(endpointProbeLabel(probe(), URL, NOW), 'live, answered 200');
  assert.equal(endpointProbeLabel(probe({ status: undefined }), URL, NOW), 'live');
});

test('every failure reason reaches the reader instead of being dropped', () => {
  const cases: [Partial<EndpointProbe>, string][] = [
    [{ live: false, status: 404, reason: 'status' }, 'not live: answered 404'],
    [{ live: false, status: undefined, reason: 'timeout' }, 'not live: no answer within the probe timeout'],
    [{ live: false, status: undefined, reason: 'unreachable' }, 'not live: the host did not answer'],
    [
      { live: false, status: undefined, reason: 'blocked' },
      'not live: the url was refused before we connected (a private host, or too many redirects)',
    ],
    [{ live: false, status: undefined, reason: undefined }, 'not live'],
  ];
  for (const [over, expected] of cases) {
    assert.equal(endpointProbeLabel(probe(over), URL, NOW), expected, JSON.stringify(over));
  }
});

test('an answer nobody refreshed inside the window stops counting as live', () => {
  const stale = probe({ checkedAt: new Date(NOW - DAY - 1).toISOString() });
  assert.equal(endpointProbeLabel(stale, URL, NOW), 'not live: nothing has answered in the last 24 hours');
});

test('a result about a different endpoint is not a result about this one', () => {
  const other = probe({ url: 'https://elsewhere.example.com/status' });
  assert.equal(endpointProbeLabel(other, URL, NOW), 'not checked yet');
  assert.equal(endpointProbeLabel(null, URL, NOW), 'not checked yet');
});

test('a probe is read out of a response body only when it is one', () => {
  const record = probe();
  assert.deepEqual(readEndpointProbe(record), record);
  assert.deepEqual(readEndpointProbe({ ...record, reason: 'timeout' }), { ...record, reason: 'timeout' });
  // Fields the record does not define are dropped rather than carried through.
  assert.deepEqual(readEndpointProbe({ ...record, extra: '<img src=x>' }), record);
  for (const bad of [null, undefined, 'live', 42, {}, { url: URL }, { ...record, live: 'yes' }]) {
    assert.equal(readEndpointProbe(bad), null, JSON.stringify(bad));
  }
  // A reason the module does not know is dropped, so the label never echoes it.
  assert.equal(readEndpointProbe({ ...record, reason: 'made up' })?.reason, undefined);
});
