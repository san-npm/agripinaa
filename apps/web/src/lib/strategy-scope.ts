import {
  MANAGED_NATIVE_CAP,
  MANAGED_STABLE_CAP,
  buildSessionScope,
  describeScope,
} from '@agripinaa/session-kit/scope';
import {
  managedStrategyFor,
  type ManagedStrategySlug,
} from '@agripinaa/shared/managed-strategies';
import { TOKENS_BSC, toBaseUnits } from '@agripinaa/shared/tokens';

export { describeScope };

/** Pure canonical scope builder shared by the browser flow and unit tests. */
export function buildStrategyScope(slug: ManagedStrategySlug, hours: number) {
  const strategy = managedStrategyFor(slug);
  if (!strategy) throw new Error(`no managed strategy policy for ${slug}`);
  const scope = buildSessionScope({
    callScopes: strategy.callScopes,
    spendCap: { token: 'USDT', amount: MANAGED_STABLE_CAP, period: 'day' },
    nativeGasCap: { amount: MANAGED_NATIVE_CAP, period: 'day' },
    expiresInSeconds: hours * 3600,
  });
  const [stableCap, ...rest] = scope.permissions.spend;
  if (!stableCap) throw new Error('canonical strategy scope is missing its USDT spend cap');
  return {
    ...scope,
    permissions: {
      ...scope.permissions,
      spend: [
        stableCap,
        ...strategy.additionalSpendCaps.map(({ token, amount }) => ({
          token: TOKENS_BSC[token]!.address,
          limit: toBaseUnits(amount, TOKENS_BSC[token]!.decimals),
          period: 'day' as const,
        })),
        ...rest,
      ],
    },
  };
}
