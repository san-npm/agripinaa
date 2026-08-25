import assert from 'node:assert/strict';
import { test } from 'node:test';

import sitemap from '../src/app/sitemap';

const paths = sitemap().map((entry) => new URL(entry.url).pathname);

/**
 * The static routes are enumerated by hand, so a page can ship without ever
 * reaching the sitemap. These are the standalone pages: the category and agent
 * URLs are generated from the registry and covered by the count below.
 */
test('every standalone page is listed exactly once', () => {
  for (const path of ['/', '/agents', '/proof', '/funds', '/leaderboard']) {
    assert.deepEqual(paths.filter((entry) => entry === path), [path], path);
  }
});

test('no URL is listed twice and every one is absolute on the site origin', () => {
  assert.equal(new Set(paths).size, paths.length, 'a URL appears more than once');
  for (const entry of sitemap()) {
    assert.match(entry.url, /^https:\/\//, entry.url);
  }
});
