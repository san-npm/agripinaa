import { TOKENS_BSC, fromBaseUnits, toBaseUnits } from '@agripinaa/shared/tokens';

export type Address = `0x${string}`;

export const MAX_SESSION_SECONDS = 30 * 24 * 60 * 60;

export type SpendCapToken = 'USDT' | 'USDC';

export interface SessionScopeInput {
  allowlist: readonly Address[];
  spendCap: { token: SpendCapToken; amount: string; period: 'day' };
  expiresInSeconds: number;
}

/**
 * Structurally compatible with the Altana SDK's GrantSessionOptions
 * (permissions + expiry), kept SDK-free so the web app can build and
 * render scopes without the SDK loaded.
 */
export interface SessionScope {
  permissions: {
    calls: { to: Address }[];
    spend: { limit: bigint; period: 'day'; token: Address }[];
  };
  expiry: number;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Builds {permissions, expiry} ready to spread into grantSession.
 *
 * Fail-closed by construction: upstream, omitting permissions.calls means
 * UNRESTRICTED contract access, and a spend entry without a token address
 * caps the NATIVE token instead of the stablecoin. Every rule here exists
 * to make those upstream defaults unreachable.
 */
export function buildSessionScope(input: SessionScopeInput): SessionScope {
  const { allowlist, spendCap, expiresInSeconds } = input;

  if (!allowlist || allowlist.length === 0) {
    throw new Error(
      'buildSessionScope rule "allowlist-required": allowlist is empty or missing; ' +
        'an empty calls allowlist would fall through to the upstream fail-open default (unrestricted contract access)',
    );
  }
  for (const to of allowlist) {
    if (typeof to !== 'string' || !ADDRESS_RE.test(to)) {
      throw new Error(
        `buildSessionScope rule "allowlist-address-shape": "${String(to)}" is not a 20-byte 0x address; ` +
          'a malformed entry cannot be trusted to restrict anything',
      );
    }
  }

  const token = TOKENS_BSC[spendCap.token];
  if (!token) {
    throw new Error(
      `buildSessionScope rule "known-token": "${spendCap.token}" is not in TOKENS_BSC; ` +
        'spend caps are only built for tokens whose decimals are pinned there',
    );
  }
  if (spendCap.period !== 'day') {
    throw new Error(
      `buildSessionScope rule "day-period-only": period "${String(spendCap.period)}" is not supported; only 'day' is`,
    );
  }
  // toBaseUnits throws on malformed amounts; decimals always come from
  // TOKENS_BSC (USDT/USDC are 18 decimals on BNB, not the 6 of Ethereum USDT).
  const limit = toBaseUnits(spendCap.amount, token.decimals);

  if (
    typeof expiresInSeconds !== 'number' ||
    !Number.isInteger(expiresInSeconds) ||
    expiresInSeconds <= 0
  ) {
    throw new Error(
      `buildSessionScope rule "positive-integer-expiry": expiresInSeconds must be an integer > 0, got ${String(expiresInSeconds)}`,
    );
  }
  if (expiresInSeconds > MAX_SESSION_SECONDS) {
    throw new Error(
      `buildSessionScope rule "max-expiry-30-days": expiresInSeconds ${expiresInSeconds} exceeds ${MAX_SESSION_SECONDS} (30 days)`,
    );
  }

  return {
    permissions: {
      calls: allowlist.map((to) => ({ to })),
      spend: [{ limit, period: 'day', token: token.address }],
    },
    expiry: Math.floor(Date.now() / 1000) + expiresInSeconds,
  };
}

export interface ScopeSummary {
  allowlistCount: number;
  capFormatted: string;
  expiresAt: string;
}

/** Plain-English summary of a scope for UI rendering. */
export function describeScope(scope: SessionScope): ScopeSummary {
  const spend = scope.permissions.spend[0];
  let capFormatted = 'no spend cap';
  if (spend) {
    const known = Object.values(TOKENS_BSC).find(
      (t) => t.address.toLowerCase() === spend.token.toLowerCase(),
    );
    capFormatted = known
      ? `${fromBaseUnits(spend.limit, known.decimals)} ${known.symbol} per ${spend.period}`
      : `${spend.limit.toString()} base units of ${spend.token} per ${spend.period}`;
  }
  return {
    allowlistCount: scope.permissions.calls.length,
    capFormatted,
    expiresAt: new Date(scope.expiry * 1000).toISOString(),
  };
}
