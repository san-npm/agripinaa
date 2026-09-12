import assert from 'node:assert/strict';
import { test } from 'node:test';

/** The module reads its configuration once at import. */
process.env.GRAPH_API_KEY = 'not-a-real-key';
process.env.GRAPH_GATEWAY_BASE = 'https://gateway.test/api/subgraphs/id';
process.env.GRAPH_TIMEOUT_MS = '30';

const { TheGraphSource, AGENT0_SUBGRAPHS } = await import('../src/sources/thegraph');
const { MergedSource } = await import('../src/sources/merged');

const BSC = 56;

interface Captured {
  url: string;
  auth: string | undefined;
  query: string;
  variables: Record<string, unknown>;
}

/** Answer every gateway call with `data`, recording what was asked. */
function gateway(data: unknown, log: Captured[]): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    const headers = new Headers(init?.headers);
    log.push({ url: String(input), auth: headers.get('authorization') ?? undefined, ...body });
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function gqlAgent(agentId: number, name: string | null, description = '') {
  return {
    id: `${BSC}:${agentId}`,
    agentId: String(agentId),
    agentURI: `ipfs://agent-${agentId}`,
    owner: '0x1111111111111111111111111111111111111111',
    agentWallet: null,
    createdAt: '1757000000',
    totalFeedback: '2',
    registrationFile: name
      ? {
          name,
          description,
          image: null,
          active: true,
          x402Support: true,
          mcpEndpoint: 'https://mcp.example',
          a2aEndpoint: null,
          webEndpoint: 'https://web.example',
          emailEndpoint: null,
          hasOASF: false,
          oasfSkills: [],
          oasfDomains: [],
          ens: null,
          did: null,
        }
      : null,
  };
}

async function withFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('a page is asked from the chain-pinned subgraph with the bearer key, newest agentId first', async () => {
  const log: Captured[] = [];
  const agents = [gqlAgent(300, 'Grid trading bot'), gqlAgent(200, null), gqlAgent(100, 'Yield optimizer', 'apy')];
  await withFetch(gateway({ agents }, log), async () => {
    const page = await new TheGraphSource().listAgents({ chainId: BSC, limit: 3 });
    assert.equal(log.length, 1);
    assert.equal(log[0]!.url, `https://gateway.test/api/subgraphs/id/${AGENT0_SUBGRAPHS[BSC]}`);
    assert.equal(log[0]!.auth, 'Bearer not-a-real-key');
    assert.match(log[0]!.query, /orderBy: agentId, orderDirection: desc/);
    assert.equal(page.source, 'the-graph');
    assert.deepEqual(
      page.items.map((a) => [a.id, a.name, a.category, a.supportedProtocols, a.x402Supported]),
      [
        ['56-300', 'Grid trading bot', 'grid', ['MCP', 'Web'], true],
        ['56-200', 'Agent #200', null, [], false],
        ['56-100', 'Yield optimizer', 'yield', ['MCP', 'Web'], true],
      ],
    );
    assert.equal(page.items[0]!.agentId, '56:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432:300');
    assert.equal(page.items[0]!.registeredAt, '2025-09-04T15:33:20.000Z');
    assert.equal(page.items[0]!.trust.source, 'the-graph');
    assert.equal(page.items[0]!.trust.totalFeedbacks, 2);
    // Three asked, three answered: the page may continue after the last one.
    assert.equal(page.nextCursor, '100');
  });
});

test('a category page over-fetches, filters locally, and advances past what it scanned', async () => {
  const log: Captured[] = [];
  const agents = [gqlAgent(300, 'Grid trading bot'), gqlAgent(200, 'Nothing in particular')];
  await withFetch(gateway({ agents }, log), async () => {
    const page = await new TheGraphSource().listAgents({ chainId: BSC, category: 'grid', limit: 24, cursor: '301' });
    assert.equal(log[0]!.variables['first'], 100);
    assert.deepEqual(log[0]!.variables['where'], { agentId_lt: '301' });
    assert.deepEqual(page.items.map((a) => a.tokenId), ['300']);
    // Fewer than 100 came back: the registry is exhausted below the cursor.
    assert.equal(page.nextCursor, null);
  });
});

test('a detail carries the registration file as metadata and services; a miss is null', async () => {
  const log: Captured[] = [];
  await withFetch(gateway({ agent: gqlAgent(269703, 'Agripinaa Grid', 'mean-reversion grid') }, log), async () => {
    const detail = await new TheGraphSource().getAgent(BSC, '269703');
    assert.equal(log[0]!.variables['id'], '56:269703');
    assert.equal(detail?.agentURI, 'ipfs://agent-269703');
    assert.equal(detail?.category, 'grid');
    assert.deepEqual(detail?.services, [
      { name: 'MCP', endpoint: 'https://mcp.example' },
      { name: 'Web', endpoint: 'https://web.example' },
    ]);
  });
  await withFetch(gateway({ agent: null }, []), async () => {
    assert.equal(await new TheGraphSource().getAgent(BSC, '1'), null);
  });
});

test('feedback rows keep the on-chain value, tags, revocation and time', async () => {
  const feedbacks = [
    {
      id: '56:269703:0xabc:0',
      clientAddress: '0xabc',
      value: '88',
      tag1: 'execution',
      tag2: null,
      feedbackURI: 'ipfs://fb',
      isRevoked: false,
      createdAt: '1757000000',
    },
  ];
  await withFetch(gateway({ feedbacks }, []), async () => {
    const rows = await new TheGraphSource().getFeedback(BSC, '269703');
    assert.deepEqual(rows, [
      {
        agentRef: '56-269703',
        client: '0xabc',
        score: 88,
        value: '88',
        tags: ['execution'],
        uri: 'ipfs://fb',
        txHash: null,
        blockNumber: null,
        revoked: false,
        timestamp: '2025-09-04T15:33:20.000Z',
      },
    ]);
  });
});

test('stats read the cumulative rollups and are chain-scoped by construction', async () => {
  const data = {
    protocolAgentStats_collection: [{ agentRegistrations: '257873' }],
    protocolFeedbackStats_collection: [{ feedbackCreated: '412' }],
  };
  await withFetch(gateway(data, []), async () => {
    const stats = await new TheGraphSource().stats(BSC);
    assert.equal(stats.totalAgents, 257873);
    assert.equal(stats.totalFeedbacks, 412);
    assert.equal(stats.chainScoped, true);
    assert.equal(stats.source, 'the-graph');
  });
});

test('a gateway error or an unpinned chain is thrown, not swallowed', async () => {
  const errors: typeof fetch = async () =>
    new Response(JSON.stringify({ errors: [{ message: 'auth error: malformed API key' }] }), { status: 200 });
  await withFetch(errors, async () => {
    await assert.rejects(() => new TheGraphSource().stats(BSC), /malformed API key/);
  });
  await assert.rejects(() => new TheGraphSource().stats(999999), /no Agent0 subgraph/);
});

test('the merged source asks The Graph first and falls through to 8004scan when it fails', async () => {
  const asked: string[] = [];
  const stub: typeof fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    asked.push(url);
    if (url.startsWith('https://gateway.test/')) return new Response('down', { status: 503 });
    // 8004scan keyed surface is not configured in this test, so the public
    // envelope answers.
    const body = { success: true, data: [], meta: { pagination: { hasMore: false } } };
    void init;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  await withFetch(stub, async () => {
    const page = await new MergedSource().listAgents({ chainId: BSC, limit: 5 });
    assert.ok(asked[0]!.startsWith('https://gateway.test/'), 'The Graph lane goes first');
    assert.ok(asked.some((u) => u.includes('8004scan')), '8004scan is the next lane');
    assert.equal(page.source, '8004scan');
  });
});
