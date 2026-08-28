import type { SessionScope } from '@agripinaa/session-kit/scope';
import {
  findAccountSessionExpiry,
  isAccountSessionDescriptorValid,
  isSessionKeyValid,
  wasSessionKeyRegistered,
  type ExpectedAccountSessionPermissions,
} from '@agripinaa/session-kit/verify';
import { ALTANA_ORCHESTRATOR_BSC } from '@agripinaa/shared/funding';
import type { Hex } from 'viem';

export interface RecoveryDependencies {
  findExpiry: typeof findAccountSessionExpiry;
  isKeyValid: typeof isSessionKeyValid;
  wasKeyRegistered: typeof wasSessionKeyRegistered;
  isDescriptorValid: typeof isAccountSessionDescriptorValid;
  waitBeforeRetry: (milliseconds: number) => Promise<void>;
}

const DEFAULT_DEPENDENCIES: RecoveryDependencies = {
  findExpiry: findAccountSessionExpiry,
  isKeyValid: isSessionKeyValid,
  wasKeyRegistered: wasSessionKeyRegistered,
  isDescriptorValid: isAccountSessionDescriptorValid,
  waitBeforeRetry: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

const ABSENCE_CONFIRMATION_ATTEMPTS = 4;
const ABSENCE_CONFIRMATION_DELAY_MS = 1_500;

export interface RecoveredExistingSession<TSigner> {
  session: {
    walletAddress: Hex;
    signer: TSigner;
    publicKey: Hex;
    permissions: SessionScope['permissions'];
    expiry: number;
  };
  approvedSignatureCheckers: readonly Hex[];
}

const SESSION_LIFETIME_OPTIONS_HOURS = [24, 168, 720] as const;

/** Smallest UI lifetime option that still contains an existing grant. */
export function lifetimeOptionForExistingSession(
  expiry: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): (typeof SESSION_LIFETIME_OPTIONS_HOURS)[number] {
  const remainingHours = Math.max(1, Math.ceil((expiry - nowSeconds) / 3600));
  const option = SESSION_LIFETIME_OPTIONS_HOURS.find((hours) => hours >= remainingHours);
  if (option === undefined) {
    throw new Error('The existing manager session exceeds the supported 30-day lifetime.');
  }
  return option;
}

/** Enumerate exact checker subsets, preferring the fully approved policy. */
function checkerSubsets(checkers: readonly Hex[]): readonly (readonly Hex[])[] {
  if (checkers.length > 8) throw new Error('too many signature checkers to recover safely');
  const subsets: Hex[][] = [];
  for (let mask = (1 << checkers.length) - 1; mask >= 0; mask -= 1) {
    const subset = checkers.filter((_, index) => (mask & (1 << index)) !== 0);
    subsets.push(subset);
  }
  return subsets.sort((left, right) => right.length - left.length);
}

/**
 * Recover a session grant that confirmed on-chain before the browser could
 * persist it. Identity, expiry, calls, spend caps, relay permission, checker
 * state, and KeyStore liveness are all re-read before any bytes are rebuilt.
 * A non-canonical existing grant fails closed instead of triggering the
 * KeyStore's irreversible "already registered" retry path.
 */
export async function recoverExistingSession<TSigner>(args: {
  account: Hex;
  manager: { address: Hex; publicKey: Hex };
  scope: SessionScope;
  signatureCheckers: readonly Hex[];
  signer: TSigner;
  /**
   * Upper bound selected by the user. `null` is reserved for the preliminary
   * manual-recovery read that discovers which supported option to select; the
   * activation path always performs the bounded check again.
   */
  maximumExpiry?: number | null;
  nowSeconds?: number;
  dependencies?: RecoveryDependencies;
}): Promise<RecoveredExistingSession<TSigner> | null> {
  const dependencies = args.dependencies ?? DEFAULT_DEPENDENCIES;
  const authority = {
    chainId: 56,
    account: args.account,
    sessionPublicKey: args.manager.publicKey,
  } as const;
  let expiry: number | null = null;
  let sawLive = false;
  let sawRegistered = false;
  const observedExpiries = new Set<number>();
  // A relay response can be lost while the grant is still pending, and even a
  // confirmed BSC transaction can take a few seconds to become visible across
  // independent public-RPC caches. Never treat a single all-negative snapshot
  // as permission to resubmit this irreversible manager key.
  for (let attempt = 0; attempt < ABSENCE_CONFIRMATION_ATTEMPTS; attempt += 1) {
    const [observedExpiry, observedLive, observedRegistered] = await Promise.all([
      dependencies.findExpiry({
        chainId: 56,
        account: args.account,
        sessionAddress: args.manager.address,
      }),
      dependencies.isKeyValid(authority),
      dependencies.wasKeyRegistered(authority),
    ]);
    if (observedExpiry !== null) observedExpiries.add(observedExpiry);
    sawLive ||= observedLive;
    sawRegistered ||= observedRegistered;
    if (observedExpiry !== null && observedLive && observedRegistered) {
      expiry = observedExpiry;
      break;
    }
    if (observedExpiry !== null
      && observedExpiry <= (args.nowSeconds ?? Math.floor(Date.now() / 1000))) break;
    if (attempt < ABSENCE_CONFIRMATION_ATTEMPTS - 1) {
      await dependencies.waitBeforeRetry(ABSENCE_CONFIRMATION_DELAY_MS);
    }
  }

  // Registration and account-descriptor evidence is monotonic for this
  // decision. A later stale negative must never erase an earlier positive
  // and reopen the irreversible grant path, while two positive but conflicting
  // descriptors are never safe to choose between.
  if (observedExpiries.size > 1) {
    throw new Error('RPC backends returned conflicting manager-session expiries. Activation stopped without submitting a duplicate grant.');
  }
  if (expiry === null) {
    const observedExpiry = observedExpiries.values().next().value as number | undefined;
    const nowSeconds = args.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (observedExpiry !== undefined
      && (observedExpiry <= nowSeconds || (sawRegistered && !sawLive))) {
      throw new Error('The existing manager session is expired or revoked and cannot be registered twice. The agent manager key must be rotated before activation.');
    }
    if (observedExpiry !== undefined || sawLive || sawRegistered) {
      throw new Error('The manager key is registered or partially visible on-chain, but its current smart-account authority could not be confirmed. Activation stopped without submitting a duplicate grant.');
    }
    return null;
  }
  const nowSeconds = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (expiry <= nowSeconds) {
    throw new Error('The existing manager session is expired or revoked and cannot be registered twice. The agent manager key must be rotated before activation.');
  }
  const maximumExpiry = args.maximumExpiry === undefined
    ? args.scope.expiry
    : args.maximumExpiry;
  if (maximumExpiry !== null && expiry > maximumExpiry) {
    throw new Error(
      'The existing manager session lasts longer than the lifetime selected here. Choose a lifetime that covers the existing grant; changing an already registered manager key requires operator rotation.',
    );
  }

  const calls: ExpectedAccountSessionPermissions['calls'] = args.scope.permissions.calls.map((call) => {
    if (!call.signature) throw new Error('Existing-session recovery requires selector-scoped calls.');
    return { to: call.to, signature: call.signature };
  });
  const expectedBase = {
    calls,
    spend: args.scope.permissions.spend,
    relayOrchestrator: ALTANA_ORCHESTRATOR_BSC,
  } satisfies ExpectedAccountSessionPermissions;
  const variants = checkerSubsets(args.signatureCheckers);
  const checks = await Promise.allSettled(variants.map((signatureCheckers) =>
    dependencies.isDescriptorValid({
      ...authority,
      sessionAddress: args.manager.address,
      expiry,
      permissions: { ...expectedBase, signatureCheckers },
    }),
  ));
  const validIndex = checks.findIndex((result) => result.status === 'fulfilled' && result.value);
  if (validIndex < 0) {
    const firstError = checks.find((result) => result.status === 'rejected');
    if (firstError?.status === 'rejected' && checks.every((result) => result.status === 'rejected')) {
      throw firstError.reason;
    }
    throw new Error('The existing manager session does not match this agent\'s exact on-chain policy. Activation stopped without submitting a duplicate grant.');
  }

  return {
    session: {
      walletAddress: args.account,
      signer: args.signer,
      publicKey: args.manager.publicKey,
      permissions: args.scope.permissions,
      expiry,
    },
    approvedSignatureCheckers: variants[validIndex]!,
  };
}
