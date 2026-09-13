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
 * Deliberately one-directional and bounded: The Graph can veto a rotation
 * the chain justified, never trigger one, and it can say no at most
 * MAX_GRAPH_VETOES ticks in a row before the chain decides alone. A stale,
 * unreachable, or implausible subgraph is reported as unavailable and the
 * chain's decision stands, so the worst this lane can do is delay a rotation
 * by a few ticks.
 */
import { graphQuery } from '@agripinaa/shared';

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

const API_KEY = process.env.GRAPH_API_KEY;
const GATEWAY_BASE = process.env.GRAPH_GATEWAY_BASE;
/**
 * How far behind the chain a subgraph may be before its rates stop counting.
 * ponytail: fixed six hours; make it per-venue if one lane proves slower.
 */
const MAX_INDEX_AGE_S = 6 * 3600;
/**
 * How far the subgraph's number may sit from the chain's before the lane is
 * treated as broken rather than as a second opinion. Index lag moves a rate
 * by a few percent; a units mismatch (a changed annualization constant, the
 * wrong market) moves it by multiples, and a veto built on that would hold a
 * rotation forever.
 */
export const MAX_CHAIN_DISAGREEMENT = 0.5;
/**
 * Consecutive vetoes the lane may cast before it is overruled. A subgraph
 * that sits inside the plausibility bound but keeps disagreeing on direction
 * (a biased market, a lagging rate) would otherwise hold a rotation forever.
 */
export const MAX_GRAPH_VETOES = 3;

/**
 * Messari's compound-forks subgraph (which Venus is) annualizes the per-block
 * rate with a fixed BSC_BLOCKS_PER_YEAR = SECONDS_PER_YEAR / 3
 * (subgraphs/compound-forks/src/constants.ts, read 2026-09-12). BSC has not
 * produced 3-second blocks since the Lorentz/Maxwell upgrades; the runner
 * measures the real cadence in readRates. The subgraph's Venus figure is
 * therefore rescaled by measured / assumed before it is compared to anything,
 * and the plausibility check below is what catches this premise going stale.
 * Aave quotes a per-second rate, so its number needs no such correction.
 */
export const MESSARI_BSC_BLOCKS_PER_YEAR = (365 * 24 * 3600) / 3;

export function rescaleVenusBps(subgraphBps: number, measuredBlocksPerYear: number): number {
  return (subgraphBps * measuredBlocksPerYear) / MESSARI_BSC_BLOCKS_PER_YEAR;
}

export interface GraphRates {
  venusBps: number;
  aaveBps: number;
  /** When each subgraph's indexing head was, ISO. */
  indexedAt: { venus: string; aave: string };
  asOf: string;
}

/** The lane was asked and could not answer; the reason is what gets logged. */
export type GraphRatesRead = GraphRates | { unavailable: string };

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
  const data = await graphQuery<SupplyAnswer>(
    MESSARI_LENDING_SUBGRAPHS[venue],
    QUERY,
    { token: token.toLowerCase() },
    { apiKey: API_KEY!, gatewayBase: GATEWAY_BASE, timeoutMs: 10_000 },
  ).catch((err: unknown) => {
    throw new Error(`${venue}: ${err instanceof Error ? err.message : String(err)}`);
  });
  const headS = Number(data._meta?.block?.timestamp);
  if (!Number.isFinite(headS)) throw new Error(`${venue}: no indexing head`);
  const ageS = nowS - headS;
  if (ageS > MAX_INDEX_AGE_S) throw new Error(`${venue}: indexed head is ${Math.round(ageS / 3600)}h old`);
  const bps = supplyBpsFromMarkets(data.markets ?? []);
  if (bps == null) throw new Error(`${venue}: no lender rate for ${token}`);
  return { bps, indexedAt: new Date(headS * 1000).toISOString() };
}

/**
 * Both venues' supply rates for one token, or why they could not be read.
 * `measuredBlocksPerYear` is the chain cadence readRates derived, needed to
 * put the subgraph's Venus figure on the same footing as the chain's. Without
 * a gateway key the lane is simply not configured, which the caller logs the
 * same way as any other reason.
 */
export async function readGraphRates(
  token: `0x${string}`,
  measuredBlocksPerYear: number,
): Promise<GraphRatesRead> {
  if (!API_KEY) return { unavailable: 'GRAPH_API_KEY not set' };
  if (!Number.isFinite(measuredBlocksPerYear) || measuredBlocksPerYear <= 0) {
    return { unavailable: `no block cadence to rescale Venus with (${measuredBlocksPerYear})` };
  }
  const nowS = Math.floor(Date.now() / 1000);
  try {
    const [venus, aave] = await Promise.all([
      readVenue('venus', token, nowS),
      readVenue('aave', token, nowS),
    ]);
    return {
      venusBps: rescaleVenusBps(venus.bps, measuredBlocksPerYear),
      aaveBps: aave.bps,
      indexedAt: { venus: venus.indexedAt, aave: aave.indexedAt },
      asOf: new Date(nowS * 1000).toISOString(),
    };
  } catch (err) {
    return { unavailable: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A second opinion is only worth listening to when it measures the same
 * thing. Each Graph rate must sit within MAX_CHAIN_DISAGREEMENT of the chain's
 * own reading of that venue; otherwise the lane is reported unavailable with
 * the two numbers, and the chain decides alone.
 */
export function plausibleAgainstChain(
  graph: GraphRatesRead,
  chain: { venusBps: number; aaveBps: number },
): GraphRatesRead {
  if ('unavailable' in graph) return graph;
  for (const venue of ['venus', 'aave'] as const) {
    const g = graph[`${venue}Bps`];
    const c = chain[`${venue}Bps`];
    const scale = Math.max(Math.abs(c), 1);
    if (!Number.isFinite(g) || Math.abs(g - c) / scale > MAX_CHAIN_DISAGREEMENT) {
      return { unavailable: `${venue}: subgraph says ${g.toFixed(2)} bps, chain says ${c.toFixed(2)} bps; not the same measurement` };
    }
  }
  return graph;
}

/**
 * The confirmation: a rotation the chain justified goes ahead only if The
 * Graph also sees the target paying more than the current venue. Sign
 * agreement is all that is asked, since the chain's gate already applied the
 * hysteresis and the confirmation streak; a disagreement holds and freezes
 * the streak where it was, so the next agreeing tick can still rotate.
 * `graphVetoes` is how many ticks in a row the lane has already said no; at
 * MAX_GRAPH_VETOES it is overruled and the chain's decision goes ahead. The
 * caller keeps that count: up on a veto, back to zero on anything else.
 * A hold, or an unavailable lane, passes through untouched.
 */
export function graphConfirms<
  D extends { action: 'hold' | 'rotate'; target: 'venus' | 'aave'; edgeBps: number; nextStreak: number },
>(
  decision: D,
  input: { venue: 'venus' | 'aave'; betterStreak: number; graphVetoes?: number },
  graph: GraphRatesRead | null | undefined,
): D & { graphVeto?: true; graphOverruled?: true } {
  if (decision.action !== 'rotate' || !graph || 'unavailable' in graph) return decision;
  const targetBps = decision.target === 'venus' ? graph.venusBps : graph.aaveBps;
  const currentBps = input.venue === 'venus' ? graph.venusBps : graph.aaveBps;
  if (targetBps > currentBps) return decision;
  if ((input.graphVetoes ?? 0) >= MAX_GRAPH_VETOES) return { ...decision, graphOverruled: true };
  return {
    ...decision,
    action: 'hold',
    target: input.venue,
    nextStreak: input.betterStreak,
    graphVeto: true,
  };
}
