import { CATEGORIES, type Category } from './types';

/**
 * ERC-8004 has no category field, so categorization is best-effort:
 *
 * 1. An explicit `category` in the agent's metadata document wins (our
 *    reference agents declare it in their agentURI JSON).
 * 2. Otherwise keyword matching on name + description + service text.
 * 3. Otherwise null: the agent appears in the full directory but not in a
 *    category hub. Hubs never show guessed-wrong agents as if curated.
 *
 * The keywords are phrases a strategy uses about itself, not the topic words
 * around it. A bare "grid", "farming", "liquidity", or "portfolio" is left
 * unmatched on purpose: the BSC registry is mostly airdrop-farming
 * registrations whose text carries such a word without describing a strategy,
 * and a hub that collects them is worth less than an empty one. Each phrase
 * here answers a case in tests/classify.test.ts; nothing was added on a hunch
 * about what an agent might say, so coverage on the long tail stays a fraction
 * of a percent, which is what its text supports.
 */
const KEYWORDS: Record<Category, RegExp> = {
  rebalancing:
    /\b(re.?balanc|lp.?(range|manag)|liquidity.?(position|range|manag)|concentrated.?liquidity|position.?manag|range.?order|v3.?(lp|position))/i,
  grid: /\b(grid.?(trad|bot|strateg)|(spot|futures|dca).?grid|mean.?reversion|ladder(ed)?.?order)/i,
  yield:
    /\b(yield|apy|apr.?(optimiz|hunt|farm)|lending.?(rate|venue|market)|auto.?compound|vault.?strateg|stak(e|ing)s?.?(reward|yield))/i,
  'health-factor':
    /\b(health.?factor|liquidat(ion|e|es|ing)|collateral.?(monitor|protect|ratio|top.?up)|loan.?to.?value|ltv\b|debt.?(monitor|protect)|deleverag)/i,
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
