import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentSummary } from '@agripinaa/agent-index/types';

import {
  MAX_QUERY_CHARS,
  applyLocalFilters,
  directoryHref,
  parseDirectoryQuery,
} from '../src/lib/directory-query';

test('a plain search term is trimmed and lower-cased', () => {
  const q = parseDirectoryQuery({ q: '  Grid Trader ' });
  assert.equal(q.query, 'grid trader');
  assert.equal(q.category, undefined);
  assert.equal(q.live, false);
  assert.equal(q.claimed, false);
  assert.equal(q.cursor, undefined);
});

test('a long search term is capped, because it becomes part of a cache key', () => {
  const q = parseDirectoryQuery({ q: 'a'.repeat(500) });
  assert.equal(q.query.length, MAX_QUERY_CHARS);
});

test('a repeated parameter takes its first value rather than joining them', () => {
  const q = parseDirectoryQuery({ q: ['grid', 'yield'], c: ['yield', 'grid'] });
  assert.equal(q.query, 'grid');
  assert.equal(q.category, 'yield');
});

test('only one of the four hub slugs survives as a category', () => {
  assert.equal(parseDirectoryQuery({ c: 'yield' }).category, 'yield');
  assert.equal(parseDirectoryQuery({ c: 'health-factor' }).category, 'health-factor');
  assert.equal(parseDirectoryQuery({ c: 'not-a-hub' }).category, undefined);
  assert.equal(parseDirectoryQuery({ c: '' }).category, undefined);
});

test('the two toggles are on only for an explicit 1', () => {
  assert.equal(parseDirectoryQuery({ live: '1' }).live, true);
  assert.equal(parseDirectoryQuery({ claimed: '1' }).claimed, true);
  assert.equal(parseDirectoryQuery({ live: 'true' }).live, false);
  assert.equal(parseDirectoryQuery({ live: '0' }).live, false);
  assert.equal(parseDirectoryQuery({ claimed: 'yes' }).claimed, false);
});

test('a cursor is kept only when it is the numeric offset the index issues', () => {
  assert.equal(parseDirectoryQuery({ cursor: '24' }).cursor, '24');
  assert.equal(parseDirectoryQuery({ cursor: '0' }).cursor, '0');
  assert.equal(parseDirectoryQuery({ cursor: 'abc' }).cursor, undefined);
  assert.equal(parseDirectoryQuery({ cursor: '-1' }).cursor, undefined);
  assert.equal(parseDirectoryQuery({ cursor: '1e3' }).cursor, undefined);
  assert.equal(parseDirectoryQuery({ cursor: '24 ' }).cursor, undefined);
  assert.equal(parseDirectoryQuery({ cursor: '1234567890' }).cursor, undefined);
});

test('an empty query builds the bare directory url', () => {
  assert.equal(
    directoryHref({ query: '', live: false, claimed: false }),
    '/agents',
  );
});

test('a url carries every set filter', () => {
  const href = directoryHref({
    query: 'grid trader',
    category: 'grid',
    live: true,
    claimed: true,
    cursor: '48',
  });
  assert.equal(href, '/agents?q=grid+trader&c=grid&live=1&claimed=1&cursor=48');
});

test('a patch overrides one filter and keeps the rest', () => {
  const current = { query: 'grid', category: 'grid' as const, live: true, claimed: false };
  assert.equal(
    directoryHref(current, { cursor: '24' }),
    '/agents?q=grid&c=grid&live=1&cursor=24',
  );
  assert.equal(
    directoryHref({ ...current, cursor: '24' }, { cursor: undefined }),
    '/agents?q=grid&c=grid&live=1',
  );
});

const base = {
  id: '56-1',
  tokenId: '1',
  name: 'One',
} as unknown as AgentSummary;

test('the live filter keeps only endpoints that answered', () => {
  const agents = [
    { ...base, id: '56-1', endpointLive: true },
    { ...base, id: '56-2', endpointLive: false },
    { ...base, id: '56-3' },
  ];
  const kept = applyLocalFilters(agents, { live: true, claimed: false });
  assert.deepEqual(
    kept.map((a) => a.id),
    ['56-1'],
  );
});

test('the claimed filter keeps only agents their owner signed for', () => {
  const agents = [
    { ...base, id: '56-1', claimed: true },
    { ...base, id: '56-2', claimed: false },
    { ...base, id: '56-3' },
  ];
  const kept = applyLocalFilters(agents, { live: false, claimed: true });
  assert.deepEqual(
    kept.map((a) => a.id),
    ['56-1'],
  );
});

test('both filters together keep only what passes both', () => {
  const agents = [
    { ...base, id: '56-1', claimed: true, endpointLive: true },
    { ...base, id: '56-2', claimed: true },
    { ...base, id: '56-3', endpointLive: true },
  ];
  const kept = applyLocalFilters(agents, { live: true, claimed: true });
  assert.deepEqual(
    kept.map((a) => a.id),
    ['56-1'],
  );
});

test('neither filter set returns the list untouched', () => {
  const agents = [{ ...base, id: '56-1' }];
  assert.equal(applyLocalFilters(agents, { live: false, claimed: false }), agents);
});
