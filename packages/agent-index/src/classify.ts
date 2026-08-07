import { CATEGORIES, type Category } from './types';

/**
 * ERC-8004 has no category field, so categorization is best-effort:
 *
 * 1. An explicit `category` in the agent's metadata document wins (our
 *    reference agents declare it in their agentURI JSON).
 * 2. Otherwise keyword matching on name + description + service text.
 * 3. Otherwise null: the agent appears in the full directory but not in a
 *    category hub. Hubs never show guessed-wrong agents as if curated.
 */
const KEYWORDS: Record<Category, RegExp> = {
  rebalancing:
    /\b(rebalanc|lp.?range|liquidity.?(position|range|manag)|concentrated.?liquidity|position.?manag|range.?order|v3.?(lp|position))/i,
  grid: /\b(grid.?(trad|bot|strateg)|mean.?reversion|ladder(ed)?.?order)/i,
  yield:
    /\b(yield|apy|apr.?(optimiz|hunt|farm)|lending.?(rate|venue)|auto.?compound|vault.?strateg|farm(ing)?)/i,
  'health-factor':
    /\b(health.?factor|liquidat(ion|e)|collateral.?(monitor|protect|ratio)|loan.?to.?value|ltv.?(monitor|alert)|debt.?(monitor|protect))/i,
};

export function classify(input: {
  metadata?: Record<string, unknown> | null;
  name: string;
  description: string;
  extraText?: string;
}): Category | null {
  const explicit = input.metadata?.['category'];
  if (typeof explicit === 'string') {
    const normalized = explicit.trim().toLowerCase();
    const match = CATEGORIES.find((c) => c === normalized);
    if (match) return match;
  }

  const haystack = [input.name, input.description, input.extraText ?? '']
    .join(' ')
    .slice(0, 4000);

  for (const category of CATEGORIES) {
    if (KEYWORDS[category].test(haystack)) return category;
  }
  return null;
}
