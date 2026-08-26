import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentSummary } from '@agripinaa/agent-index/types';
import type { ClaimRecord } from '../src/lib/claims';

import {
  DIRECTORY_PAGE_SIZE,
  DIRECTORY_WALK_DEPTH,
  MAX_DIRECTORY_PAGES,
  RegistryCursorExpiredError,
  RegistryCursorInvalidError,
  directoryPage,
  directoryPageIndex,
  excludeInjectedRegistryEntries,
  mergeRegistryWindow,
  pageRegistryWindow,
  rankClaimedSearchResults,
  reconcileInjectedRegistryEntries,
  validRegistryCursor,
} from '../src/lib/data';

/**
 * What "Load more" cuts. Every registration the walk has read is ranked and
 * de-duplicated as one listing, grouped by the read it arrived in, and a page
 * is a contiguous slice of that. The shape carries three properties worth
 * pinning: a name minted either side of a read boundary collapses, every
 * registration a read brought back has a page of its own, and a later read
 * appends rather than pushing the pages before it around.
 */
function agent(over: Partial<AgentSummary> & { tokenId: string }): AgentSummary {
  return {
    id: `56-${over.tokenId}`,
    chainId: 56,
    agentId: `56:0x8004a169:${over.tokenId}`,
    name: `Agent #${over.tokenId}`,
    description: '',
    imageUrl: null,
    owner: '0x1111111111111111111111111111111111111111',
    category: null,
    supportedProtocols: [],
    x402Supported: false,
    registeredAt: null,
    trust: {
      totalScore: null,
      averageScore: null,
      rank: null,
      healthScore: null,
      totalFeedbacks: 0,
      starCount: null,
      isVerified: false,
      source: 'registry',
      asOf: '2026-08-24T00:00:00.000Z',
    },
    ...over,
  };
}

/** `count` agents that each carry enough signal to keep their own card. */
function classified(count: number, from = 1): AgentSummary[] {
  return Array.from({ length: count }, (_, i) =>
    agent({
      tokenId: String(from + i),
      name: `Harvester ${from + i}`,
      category: 'yield',
      // Strictly descending registration time, which is how rankAndDedupe
      // breaks a tie between equal scores, so the ranked order of these
      // fixtures is the order they are given in.
      registeredAt: new Date(
        Date.UTC(2026, 7, 24) - (from + i) * 86_400_000,
      ).toISOString(),
    }),
  );
}

test('a page comes back ranked by signal quality', () => {
  const bare = agent({ tokenId: '1' });
  const evaluable = agent({ tokenId: '2', name: 'Harvester', category: 'yield' });
  assert.deepEqual(
    directoryPage([[bare, evaluable]], 0).items.map((a) => a.id),
    ['56-2', '56-1'],
  );
});

test('every registration a read brought back lands on exactly one page', () => {
  // One read of 30, a page of 24: the 6 behind the first page are the second
  // page, not a tail with no url. Paging a whole read at a time skipped them.
  const read = classified(30);
  const first = directoryPage([read], 0);
  const second = directoryPage([read], 1);

  assert.equal(first.items.length, DIRECTORY_PAGE_SIZE);
  assert.equal(first.hasMore, true);
  assert.equal(second.items.length, 30 - DIRECTORY_PAGE_SIZE);
  assert.equal(second.hasMore, false);

  const shown = [...first.items, ...second.items].map((a) => a.id);
  assert.equal(new Set(shown).size, shown.length, 'no card is shown twice');
  assert.deepEqual(
    new Set(shown),
    new Set(read.map((a) => a.id)),
    'every agent in the read has a page',
  );
});

test('locally injected cards do not displace entries behind the upstream cursor', () => {
  const raw = classified(100);
  const injected = classified(4, 1_001);
  const merged = mergeRegistryWindow(raw, injected);
  assert.equal(merged.length, 104);

  const shown = Array.from({ length: Math.ceil(merged.length / DIRECTORY_PAGE_SIZE) }, (_, page) =>
    directoryPage([merged], page).items,
  ).flat();
  assert.deepEqual(
    new Set(shown.map((a) => a.tokenId)),
    new Set([...injected, ...raw].map((a) => a.tokenId)),
    'the next upstream cursor may advance past all 100 because all 100 remain reachable',
  );
});

test('an injected native-category agent is removed if a later source window reaches it', () => {
  const lateNative = classified(1, 1_001)[0]!;
  const first = mergeRegistryWindow(classified(100), [lateNative]);
  const later = excludeInjectedRegistryEntries(
    [lateNative, ...classified(10, 101)],
    [lateNative],
  );
  const shown = [...first, ...later].map((a) => a.tokenId);

  assert.equal(shown.filter((id) => id === lateNative.tokenId).length, 1);
  assert.equal(later.some((a) => a.tokenId === lateNative.tokenId), false);
  assert.equal(
    later.length,
    10,
    'only the already-injected identity is removed from the later source window',
  );
});

test('a transferred listing is retained instead of being hidden by its stale injection', () => {
  const stale = classified(1, 1_001)[0]!;
  const transferred = {
    ...stale,
    owner: '0x2222222222222222222222222222222222222222',
    claimed: false,
    claimedFields: [],
  } satisfies AgentSummary;

  const injection = reconcileInjectedRegistryEntries([stale], [transferred]);
  const first = mergeRegistryWindow(classified(10), injection);
  const later = excludeInjectedRegistryEntries([transferred], injection);
  const shown = [...first, ...later].filter((a) => a.tokenId === stale.tokenId);

  assert.deepEqual(injection, [], 'the stale first-window injection is removed');
  assert.deepEqual(shown, [transferred], 'only the fresh owner survives the walk');
});

test('registry cursors can retain a position inside a complete upstream window', () => {
  assert.equal(validRegistryCursor('1'), true);
  assert.equal(validRegistryCursor('w:0:24:0123456789abcdef'), true);
  assert.equal(validRegistryCursor('w:12:96:fedcba9876543210'), true);
  assert.equal(validRegistryCursor('w:0:24:short'), false);
  assert.equal(validRegistryCursor('w:nope:24:0123456789abcdef'), false);
  assert.equal(validRegistryCursor('w:1:9999:0123456789abcdef'), false);
  assert.equal(validRegistryCursor('w:1:999:0123456789abcdef'), false);
  assert.equal(validRegistryCursor('w:1:0:0123456789abcdef'), false);
});

test('a small API limit walks an entire raw window before advancing upstream', () => {
  const raw = classified(100);
  const shown: AgentSummary[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
    const page = pageRegistryWindow(raw, 24, cursor, '2', '0123456789abcdef');
    shown.push(...page.items);
    if (page.nextCursor === '2') break;
    cursor = page.nextCursor ?? undefined;
  }
  assert.deepEqual(
    shown.map((a) => a.tokenId),
    raw.map((a) => a.tokenId),
  );
});

test('an API cursor remains valid when the continuation changes its page limit', () => {
  // The listing models one fixed upstream window plus its fixed claimed-only
  // injection. A client may omit `limit` on the next request; changing the
  // slice size must not invalidate the cursor or skip any identity.
  const listing = mergeRegistryWindow(classified(100), classified(8, 1_001));
  const first = pageRegistryWindow(listing, 100, undefined, '2', '0123456789abcdef');
  const second = pageRegistryWindow(
    listing,
    24,
    first.nextCursor ?? undefined,
    '2',
    '0123456789abcdef',
  );

  assert.equal(first.items.length, 100);
  assert.equal(second.items.length, 8);
  assert.equal(second.nextCursor, '2');
  assert.equal(
    new Set([...first.items, ...second.items].map((a) => a.tokenId)).size,
    108,
    'the changed limit neither repeats nor skips a card',
  );
});

test('a changed upstream window expires its local cursor instead of skipping cards', () => {
  const raw = classified(100);
  const first = pageRegistryWindow(raw, 24, undefined, '2', '0123456789abcdef');
  assert.throws(
    () => pageRegistryWindow(raw.slice(1), 24, first.nextCursor ?? undefined, '2', 'fedcba9876543210'),
    RegistryCursorExpiredError,
  );
});

test('a forged local offset cannot skip the unread remainder of its window', () => {
  const raw = classified(50);
  assert.throws(
    () => pageRegistryWindow(raw, 24, 'w:0:96:0123456789abcdef', '2', '0123456789abcdef'),
    RegistryCursorInvalidError,
  );
});

test('search applies an owner claim before filtering its resulting category', () => {
  const unclassified = agent({ tokenId: '888', category: null });
  const claim: ClaimRecord = {
    fields: {
      chainId: 56,
      tokenId: '888',
      description: '',
      category: 'yield',
      website: '',
      endpoint: '',
      issuedAt: '2026-08-24T00:00:00.000Z',
    },
    signature: `0x${'ab'.repeat(65)}`,
    signer: unclassified.owner as `0x${string}`,
    savedAt: '2026-08-24T00:00:00.000Z',
  };
  const results = rankClaimedSearchResults([unclassified], [claim], 'yield');
  assert.equal(results.length, 1);
  assert.equal(results[0]?.category, 'yield');
  assert.equal(results[0]?.claimed, true);
});

test('a second read extends the same listing rather than restarting it', () => {
  const pages = [classified(20), classified(20, 21)];
  const first = directoryPage(pages, 0);
  const second = directoryPage(pages, 1);
  assert.equal(first.items.length, DIRECTORY_PAGE_SIZE);
  assert.equal(second.items.length, 40 - DIRECTORY_PAGE_SIZE);
  const shown = [...first.items, ...second.items].map((a) => a.id);
  assert.equal(new Set(shown).size, 40);
});

test('a name minted across a read boundary collapses instead of opening a second card', () => {
  // Distinct owners, no category, no score: rankAndDedupe collapses these into
  // one card. Ranking the union before the slice is what makes that hold across
  // reads; ranking each read on its own left the cluster with two cards.
  const early = agent({
    tokenId: '1',
    name: 'Ave.ai',
    owner: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    registeredAt: '2026-01-01T00:00:00.000Z',
  });
  const late = agent({
    tokenId: '2',
    name: 'Ave.ai',
    owner: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    registeredAt: '2026-02-01T00:00:00.000Z',
  });
  const evaluable = agent({ tokenId: '3', name: 'Guardian', category: 'health-factor' });

  const page = directoryPage([[early], [late, evaluable]], 0);
  assert.deepEqual(
    page.items.map((a) => a.id),
    ['56-2', '56-3'],
    'one Ave.ai card, carrying the cluster, and it keeps the first read\'s place',
  );
  assert.equal(page.items[0]?.duplicateCount, 2);
  assert.equal(page.hasMore, false);
});

test('a later read appends to the listing rather than reordering the pages before it', () => {
  // The drift this rules out: ranked as one flat set, a high-signal
  // registration two reads down inserts near the top and pushes every page
  // boundary along, so the next page repeats what the last one showed.
  const first = classified(30);
  const strong = [
    agent({
      tokenId: '99',
      name: 'Sentinel',
      category: 'yield',
      trust: {
        totalScore: 900,
        averageScore: 5,
        rank: 1,
        healthScore: 100,
        totalFeedbacks: 40,
        starCount: 12,
        isVerified: true,
        source: '8004scan',
        asOf: '2026-08-24T00:00:00.000Z',
      },
    }),
  ];

  const shallow = directoryPage([first], 0).items.map((a) => a.id);
  const deeper = directoryPage([first, strong], 0).items.map((a) => a.id);
  assert.deepEqual(deeper, shallow, 'page one names the same agents either way');
  assert.deepEqual(
    directoryPage([first, strong], 1).items.map((a) => a.id),
    [...classified(30).slice(24).map((a) => a.id), '56-99'],
    'the later read lands behind everything the first read brought back',
  );
});

test('two agents that share a name but carry real signal both keep their card', () => {
  const first = agent({ tokenId: '1', name: 'Ranger', category: 'rebalancing' });
  const second = agent({
    tokenId: '2',
    name: 'Ranger',
    category: 'rebalancing',
    owner: '0xcccccccccccccccccccccccccccccccccccccccc',
  });
  assert.equal(directoryPage([[first], [second]], 0).items.length, 2);
});

test('hasMore is set only when a ranked entry sits past the slice', () => {
  assert.equal(directoryPage([classified(DIRECTORY_PAGE_SIZE)], 0).hasMore, false);
  assert.equal(directoryPage([classified(DIRECTORY_PAGE_SIZE + 1)], 0).hasMore, true);
  assert.equal(directoryPage([], 0).hasMore, false);
});

test('a cursor names the page it offsets to', () => {
  assert.equal(directoryPageIndex(undefined), 0);
  assert.equal(directoryPageIndex('0'), 0);
  assert.equal(directoryPageIndex(String(DIRECTORY_PAGE_SIZE)), 1);
  assert.equal(directoryPageIndex(String(DIRECTORY_PAGE_SIZE * 3)), 3);
});

test('a cursor no link issued lands on the page holding it, not on an error', () => {
  // Hand-written, or a bookmark from when the cursor meant something else.
  assert.equal(directoryPageIndex('25'), 1);
  assert.equal(directoryPageIndex('100'), Math.floor(100 / DIRECTORY_PAGE_SIZE));
  assert.equal(directoryPageIndex('999999999'), MAX_DIRECTORY_PAGES - 1);
});

test('the reachable depth covers what the walk is allowed to read', () => {
  // The two caps are derived from each other on purpose: a page cap picked
  // independently of the read cap would strand the tail of the last read, which
  // is the shape this task set out to remove.
  assert.ok(
    MAX_DIRECTORY_PAGES * DIRECTORY_PAGE_SIZE >= DIRECTORY_WALK_DEPTH,
    'every registration one walk reads has a page it can be reached on',
  );
});
