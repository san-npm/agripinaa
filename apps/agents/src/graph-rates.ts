/**
 * Second opinion on the two lending venues, from The Graph.
 *
 * Messari's standardized lending subgraphs expose the same `Market.rates`
 * shape for every protocol they cover, so one query reads Venus and Aave V3 on
 * BSC alike. The Harvester and the Steward already decide on the chain's own
 * numbers (`supplyRatePerBlock`, `currentLiquidityRate`); this is an
 * independent measurement of the same thing, indexed from the venues' events,
 * that a rotation must also agree with before it moves a depositor's funds.
 *
 * Deliberately one-directional: The Graph can veto a rotation the chain
 * justified, never trigger one. A stale or unreachable subgraph is reported
 * as unavailable and the chain's decision stands, so the worst this lane can
 * do is hold a position one tick longer.
 */

/**
 * Messari deployments on The Graph Network, read 2026-09-12 from
 * github.com/messari/subgraphs deployment/deployment.json
 * (`services.decentralized-network.query-id`). Venus is on lending schema
 * 2.0.1, Aave V3 BSC on 3.1.0; both carry `Market.rates{rate,side,type}`.
 */
export const MESSARI_LENDING_SUBGRAPHS = {
  venus: 'CwswJ7sfENafqgAYU1upn3hQgoEV2CXXRZRJ7XtgJrKG',
  aave: '43jbGkvSw55sMvYyF6MZieksmJbajMu3hNGF8PN9ucuP',
} as const;

const GATEWAY_BASE =
  process.env.GRAPH_GATEWAY_BASE ?? 'https://gateway.thegraph.com/api/subgraphs/id';
const API_KEY = process.env.GRAPH_API_KEY;
const REQUEST_TIMEOUT_MS = 10_000;
/**
 * How far behind the chain a subgraph may be before its rates stop counting.
 * ponytail: fixed six hours; make it per-venue if one lane proves slower.
 */
const MAX_INDEX_AGE_S = 6 * 3600;

export interface GraphRates {
  source: 'the-graph';
  venusBps: number;
  aaveBps: number;
  /** When each subgraph's indexing head was, ISO. */
  indexedAt: { venus: string; aave: string };
  asOf: string;
}

/** The lane was asked and could not answer; the reason is what gets logged. */
export interface GraphUnavailable {
  source: 'the-graph';
  unavailable: string;
}

export type GraphRatesRead = GraphRates | GraphUnavailable;

interface MarketRow {
  id: string;
  name: string | null;
  totalDepositBalanceUSD: string;
  rates: { rate: string; side: string; type: string }[];
}

interface SupplyAnswer {
  _meta: { block: { number: number; timestamp: number } };
  markets: MarketRow[];
}

const QUERY = `query Supply($token: String!) {
  _meta { block { number timestamp } }
  markets(where: { inputToken: $token }, first: 10) {
    id name totalDepositBalanceUSD
    rates { rate side type }
  }
}`;

/** Lender-side variable rate of the deepest market for the token, in bps. */
export function supplyBpsFromMarkets(markets: MarketRow[]): number | null {
  const deepest = [...markets].sort(
    (a, b) => Number(b.totalDepositBalanceUSD) - Number(a.totalDepositBalanceUSD),
  )[0];
  if (!deepest) return null;
  const lender =
    deepest.rates.find((r) => r.side === 'LENDER' && r.type === 'VARIABLE') ??
    deepest.rates.find((r) => r.side === 'LENDER');
  if (!lender) return null;
  // Messari publishes `rate` as a percentage (2.05 means 2.05%). Rounded to a
  // hundredth of a bp so decimal input does not come back as 204.99999.
  const bps = Math.round(Number(lender.rate) * 1e6) / 1e4;
  return Number.isFinite(bps) ? bps : null;
}

async function readVenue(
  venue: keyof typeof MESSARI_LENDING_SUBGRAPHS,
  token: string,
  nowS: number,
): Promise<{ bps: number; indexedAt: string }> {
  const res = await fetch(`${GATEWAY_BASE}/${MESSARI_LENDING_SUBGRAPHS[venue]}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ query: QUERY, variables: { token: token.toLowerCase() } }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${venue}: gateway responded ${res.status}`);
  const json = (await res.json()) as { data?: SupplyAnswer; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(`${venue}: ${json.errors.map((e) => e.message).join('; ')}`);
  if (!json.data) throw new Error(`${venue}: gateway answered without data`);
  const headS = Number(json.data._meta?.block?.timestamp);
  if (!Number.isFinite(headS)) throw new Error(`${venue}: no indexing head`);
  const ageS = nowS - headS;
  if (ageS > MAX_INDEX_AGE_S) throw new Error(`${venue}: indexed head is ${Math.round(ageS / 3600)}h old`);
  const bps = supplyBpsFromMarkets(json.data.markets ?? []);
  if (bps == null) throw new Error(`${venue}: no lender rate for ${token}`);
  return { bps, indexedAt: new Date(headS * 1000).toISOString() };
}

/**
 * Both venues' supply rates for one token, or why they could not be read.
 * Without a gateway key the lane is simply not configured, which the caller
 * logs the same way as any other reason.
 */
export async function readGraphRates(token: `0x${string}`): Promise<GraphRatesRead> {
  if (!API_KEY) return { source: 'the-graph', unavailable: 'GRAPH_API_KEY not set' };
  const nowS = Math.floor(Date.now() / 1000);
  try {
    const [venus, aave] = await Promise.all([
      readVenue('venus', token, nowS),
      readVenue('aave', token, nowS),
    ]);
    return {
      source: 'the-graph',
      venusBps: venus.bps,
      aaveBps: aave.bps,
      indexedAt: { venus: venus.indexedAt, aave: aave.indexedAt },
      asOf: new Date(nowS * 1000).toISOString(),
    };
  } catch (err) {
    return { source: 'the-graph', unavailable: err instanceof Error ? err.message : String(err) };
  }
}

export function isGraphRates(read: GraphRatesRead | null | undefined): read is GraphRates {
  return read != null && !('unavailable' in read);
}

/**
 * The confirmation: a rotation the chain justified goes ahead only if The
 * Graph also sees the target paying more than the current venue. Sign
 * agreement is all that is asked, since the chain's gate already applied the
 * hysteresis and the confirmation streak; a disagreement holds and freezes
 * the streak where it was, so the next agreeing tick can still rotate.
 * A hold, or an unavailable lane, passes through untouched.
 */
export function graphConfirms<
  D extends { action: 'hold' | 'rotate'; target: 'venus' | 'aave'; edgeBps: number; nextStreak: number },
>(
  decision: D,
  input: { venue: 'venus' | 'aave'; betterStreak: number },
  graph: GraphRatesRead | null | undefined,
): D & { graphVeto?: true } {
  if (decision.action !== 'rotate' || !isGraphRates(graph)) return decision;
  const targetBps = decision.target === 'venus' ? graph.venusBps : graph.aaveBps;
  const currentBps = input.venue === 'venus' ? graph.venusBps : graph.aaveBps;
  if (targetBps > currentBps) return decision;
  return {
    ...decision,
    action: 'hold',
    target: input.venue,
    nextStreak: input.betterStreak,
    graphVeto: true,
  };
}
