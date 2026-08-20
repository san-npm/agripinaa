import { TOKENS_BSC, fromBaseUnits, toBaseUnits } from '@agripinaa/shared/tokens';

export type Address = `0x${string}`;

export const MAX_SESSION_SECONDS = 30 * 24 * 60 * 60;

export type SpendCapToken = 'USDT' | 'USDC';

/**
 * A per-selector call scope: the session may call ONLY the listed function
 * signatures on `to`. This is stronger than a target-only allowlist entry,
 * which permits any selector on the target. Used to lock a managed-yield
 * session to exactly the router's toAave()/toVenus()/toIdle().
 */
export interface CallScope {
  to: Address;
  signatures: readonly string[];
}

export interface SessionScopeInput {
  /** Target-only allowlist (any selector on each target). Legacy demo path. */
  allowlist?: readonly Address[];
  /** Per-selector scopes (only these signatures on each target). Preferred for managed sessions. */
  callScopes?: readonly CallScope[];
  spendCap: { token: SpendCapToken; amount: string; period: 'day' };
  /**
   * A native (gas-token) daily cap. Managed sessions REQUIRE this: the
   * account pays its own gas in BNB, and without a native spend permission
   * the relay rejects execute with NoSpendPermissions.
   */
  nativeGasCap?: { amount: string; period: 'day' };
  expiresInSeconds: number;
}

/**
 * Structurally compatible with the Altana SDK's GrantSessionOptions
 * (permissions + expiry), kept SDK-free so the web app can build and
 * render scopes without the SDK loaded.
 *
 * A `calls` entry with a `signature` restricts to that selector; without one
 * it is target-only. A `spend` entry without a `token` caps the NATIVE token.
 */
export interface SessionScope {
  permissions: {
    calls: { to: Address; signature?: string }[];
    spend: { limit: bigint; period: 'day'; token?: Address }[];
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
  const { allowlist, callScopes, spendCap, nativeGasCap, expiresInSeconds } = input;

  const hasAllowlist = Array.isArray(allowlist) && allowlist.length > 0;
  const hasCallScopes = Array.isArray(callScopes) && callScopes.length > 0;
  if (hasAllowlist && hasCallScopes) {
    throw new Error(
      'buildSessionScope rule "one-call-shape": provide either allowlist OR callScopes, not both',
    );
  }
  if (!hasAllowlist && !hasCallScopes) {
    throw new Error(
      'buildSessionScope rule "allowlist-required": no allowlist or callScopes given; ' +
        'an empty calls list would fall through to the upstream fail-open default (unrestricted contract access)',
    );
  }

  // Every target address (from either shape) must be a real 20-byte address;
  // a malformed entry cannot be trusted to restrict anything.
  const targets: Address[] = hasCallScopes
    ? callScopes!.map((cs) => cs.to)
    : [...allowlist!];
  for (const to of targets) {
    if (typeof to !== 'string' || !ADDRESS_RE.test(to)) {
      throw new Error(
        `buildSessionScope rule "allowlist-address-shape": "${String(to)}" is not a 20-byte 0x address; ` +
          'a malformed entry cannot be trusted to restrict anything',
      );
    }
  }
  if (hasCallScopes) {
    for (const cs of callScopes!) {
      if (!Array.isArray(cs.signatures) || cs.signatures.length === 0) {
        throw new Error(
          `buildSessionScope rule "call-scope-nonempty": callScope for ${cs.to} has no signatures; ` +
            'an empty signature list would widen the scope to every selector on that target',
        );
      }
      for (const sig of cs.signatures) {
        // A function signature, not a bare name and not a 4-byte hex selector:
        // the SDK hashes the signature text, so "toAave" or "0xdb1a4d6d" would
        // silently scope to the wrong (or every) selector.
        if (typeof sig !== 'string' || !/^[a-zA-Z_$][\w$]*\((.*)\)$/.test(sig)) {
          throw new Error(
            `buildSessionScope rule "call-scope-signature-shape": "${String(sig)}" is not a function signature like "toAave()"`,
          );
        }
      }
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

  const calls = hasCallScopes
    ? callScopes!.flatMap((cs) => cs.signatures.map((signature: string) => ({ signature, to: cs.to })))
    : allowlist!.map((to) => ({ to }));

  const spend: SessionScope['permissions']['spend'] = [
    { limit, period: 'day', token: token.address },
  ];
  if (nativeGasCap) {
    if (nativeGasCap.period !== 'day') {
      throw new Error(
        `buildSessionScope rule "day-period-only": native gas cap period "${String(nativeGasCap.period)}" is not supported; only 'day' is`,
      );
    }
    // Native token (BNB) is 18 decimals; a spend entry with no token caps it.
    spend.push({ limit: toBaseUnits(nativeGasCap.amount, 18), period: 'day' });
  }

  return {
    permissions: { calls, spend },
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
  // Summarize the token cap: describeScope surfaces the stablecoin cap, which
  // is always spend[0]; a token-less entry (native gas cap) is not the headline.
  const spend = scope.permissions.spend.find((s) => s.token) ?? scope.permissions.spend[0];
  let capFormatted = 'no spend cap';
  if (spend && spend.token) {
    const tokenAddr = spend.token;
    const known = Object.values(TOKENS_BSC).find(
      (t) => t.address.toLowerCase() === tokenAddr.toLowerCase(),
    );
    capFormatted = known
      ? `${fromBaseUnits(spend.limit, known.decimals)} ${known.symbol} per ${spend.period}`
      : `${spend.limit.toString()} base units of ${tokenAddr} per ${spend.period}`;
  } else if (spend) {
    capFormatted = `${fromBaseUnits(spend.limit, 18)} BNB per ${spend.period}`;
  }
  // Count DISTINCT target contracts, not call entries: a managed session scopes
  // three selectors onto one router, which is one allowlisted contract, not three.
  const distinctTargets = new Set(
    scope.permissions.calls.map((c) => c.to.toLowerCase()),
  ).size;
  return {
    allowlistCount: distinctTargets,
    capFormatted,
    expiresAt: new Date(scope.expiry * 1000).toISOString(),
  };
}
