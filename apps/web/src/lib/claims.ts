import 'server-only';

import { BSC_MAINNET, ERC8004_REGISTRIES, IDENTITY_REGISTRY_ABI } from '@agripinaa/shared';
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  ExecutionRevertedError,
  createPublicClient,
  fallback,
  http,
  type Hex,
} from 'viem';

import { bsc } from './bsc-chain';

import {
  CLAIM_REPLAY_WINDOW_MS,
  normalizeAgentId,
  recoverClaimSigner,
  sameAddress,
  sanitizeFields,
  type ClaimFields,
} from './claim-message';
import { kvAvailable, kvGet, kvMGet, kvSet } from './kv';
import { UNATTRIBUTED_CLIENT, takeChainRead } from './throttle';

/**
 * The server half of the claim flow: who owns an agent, whether a signature
 * came from that owner, and where the resulting claim is stored. The signed
 * message itself lives in `claim-message.ts`, which the browser also imports.
 *
 * An indexed ERC-8004 registration carries no way for its owner to say what the
 * agent does, so a claim is the one place owner-provided text enters the site.
 * Every decision that guards it is in `decideClaim`, which takes its chain and
 * KV access as arguments so each rejection is testable without a network.
 */

export {
  CLAIM_DOMAIN_NAME,
  CLAIM_DOMAIN_VERSION,
  CLAIM_REPLAY_WINDOW_MS,
  CLAIM_TYPES,
  MAX_DESCRIPTION_CHARS,
  MAX_URL_CHARS,
  buildClaimMessage,
  normalizeAgentId,
  recoverClaimSigner,
  sanitizeFields,
  verifyClaimSignature,
  type ClaimFields,
} from './claim-message';

/** Claims are only accepted for BNB Chain, the one chain this site indexes. */
export const CLAIM_CHAIN_ID = 56;

/** At most this many claims per owner address per CLAIM_RATE_WINDOW_MS. */
export const CLAIM_RATE_LIMIT = 5;
export const CLAIM_RATE_WINDOW_MS = 60 * 60 * 1_000;

/**
 * How many claim ids the index holds. Well past any plausible claim count for
 * this site, and bounded so a flood of claims cannot grow one KV value without
 * limit. Past the cap the oldest ids are dropped: their records stay readable
 * by id, they just stop appearing in `listClaims`.
 */
export const CLAIM_INDEX_LIMIT = 5_000;

/** A claim body is about 1 KB. Anything past this is not one. */
const MAX_BODY_CHARS = 16 * 1_024;

const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const CLAIM_INDEX_KEY = 'agripinaa:claims:index';

/** Index entries are `<chainId>:<tokenId>`, which is a record key minus this. */
const CLAIM_PREFIX = 'agripinaa:claim:';

/**
 * The KV key for one claim. The id is normalised here rather than by each
 * caller, so a record written from a claim body and a record read from a query
 * string land on the same key whatever leading zeros either carried.
 */
export function claimKey(chainId: number, tokenId: string): string {
  return `${CLAIM_PREFIX}${chainId}:${normalizeAgentId(tokenId)}`;
}

function claimRateKey(owner: string): string {
  return `agripinaa:claim-rate:${owner.toLowerCase()}`;
}

export interface ClaimRecord {
  fields: ClaimFields;
  signature: Hex;
  /** The recovered signer, which was the on-chain owner when the claim landed. */
  signer: Hex;
  savedAt: string;
}

/** The KV commands this module needs, injectable so tests store in memory. */
export interface ClaimKv {
  available(): boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<boolean>;
  mget(keys: string[]): Promise<(string | null)[]>;
}

export const liveClaimKv: ClaimKv = {
  available: kvAvailable,
  get: kvGet,
  set: kvSet,
  mget: kvMGet,
};

/**
 * A chain read that either produced an answer or could not be made at all.
 *
 * The distinction is the point: a node that timed out, rate limited us, or
 * answered with nonsense has told us nothing about the token, and reporting
 * that as "this agent id has no owner on chain" would tell a legitimate owner
 * their registration does not exist and tell their browser not to retry.
 */
export type ChainRead<T> = { ok: true; value: T } | { ok: false; reason: 'unavailable' };

/** The two chain reads a claim needs, injectable for the same reason. */
export interface ClaimChain {
  /** The current owner of an identity; `null` when there is no such token. */
  ownerOf(tokenId: string): Promise<ChainRead<Hex | null>>;
  /** Whether an address is a contract rather than an externally owned account. */
  hasBytecode(address: Hex): Promise<ChainRead<boolean>>;
}

const client = createPublicClient({
  chain: bsc,
  transport: fallback(BSC_MAINNET.rpcUrls.map((u) => http(u, { timeout: 4_000 }))),
});

const UNAVAILABLE = { ok: false, reason: 'unavailable' } as const;

/**
 * Whether a failed `readContract` was the contract saying no, as opposed to the
 * node failing to answer. `ownerOf` reverts for an id that was never registered,
 * which is a real answer: there is no such token. Three shapes count as that
 * revert, because which one arrives depends on the node: a decoded custom error,
 * a bare `execution reverted` with no data to decode, and an empty return.
 * Everything else (timeouts, 429s, HTML from a proxy) is the node, not the
 * chain, and must not be read as an answer.
 */
function isRevert(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  return Boolean(
    error.walk(
      (cause) =>
        cause instanceof ContractFunctionRevertedError ||
        cause instanceof ContractFunctionZeroDataError ||
        cause instanceof ExecutionRevertedError,
    ),
  );
}

/** Reads against the ERC-8004 IdentityRegistry on BNB Chain. */
export const liveClaimChain: ClaimChain = {
  async ownerOf(tokenId: string): Promise<ChainRead<Hex | null>> {
    const id = normalizeAgentId(tokenId);
    if (!id) return { ok: true, value: null };
    try {
      const owner = await client.readContract({
        address: ERC8004_REGISTRIES[CLAIM_CHAIN_ID]!.identity,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'ownerOf',
        args: [BigInt(id)],
      });
      const value = owner && owner !== '0x0000000000000000000000000000000000000000' ? owner : null;
      return { ok: true, value };
    } catch (error) {
      return isRevert(error) ? { ok: true, value: null } : UNAVAILABLE;
    }
  },
  async hasBytecode(address: Hex): Promise<ChainRead<boolean>> {
    try {
      const code = await client.getCode({ address });
      return { ok: true, value: Boolean(code && code !== '0x') };
    } catch {
      return UNAVAILABLE;
    }
  },
};

function parseClaim(raw: string | null): ClaimRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ClaimRecord>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.signature !== 'string' || !SIGNATURE.test(parsed.signature)) return null;
    if (typeof parsed.signer !== 'string' || !ADDRESS.test(parsed.signer)) return null;
    const fields = sanitizeFields(parsed.fields);
    if (!fields.tokenId) return null;
    return {
      fields,
      signature: parsed.signature as Hex,
      signer: parsed.signer as Hex,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '',
    };
  } catch {
    return null;
  }
}

async function readIndex(kv: ClaimKv): Promise<string[]> {
  const raw = await kv.get(CLAIM_INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Add an id to the claim index, newest last, capped at CLAIM_INDEX_LIMIT.
 *
 * Two saves that land together can read the same index and write back two
 * versions of it, so one of the ids can be lost. That costs a listing entry,
 * not the claim: the record itself is written under its own key and stays
 * readable by id, and the next save from that owner puts the id back. Anything
 * stronger here would mean a lock or a KV set type this client does not have.
 */
async function addToIndex(kv: ClaimKv, id: string): Promise<void> {
  const ids = await readIndex(kv);
  const next = [...ids.filter((existing) => existing !== id), id];
  await kv.set(CLAIM_INDEX_KEY, JSON.stringify(next.slice(-CLAIM_INDEX_LIMIT)));
}

/**
 * Store a claim and index it. Returns false when the record itself could not be
 * written; an index write that fails is not fatal (see `addToIndex`).
 */
export async function saveClaim(record: ClaimRecord, kv: ClaimKv = liveClaimKv): Promise<boolean> {
  const { chainId } = record.fields;
  const tokenId = normalizeAgentId(record.fields.tokenId);
  if (!tokenId) return false;
  const written = await kv.set(claimKey(chainId, tokenId), JSON.stringify(record));
  if (!written) return false;
  await addToIndex(kv, `${chainId}:${tokenId}`);
  return true;
}

/**
 * A claim is stale once the identity has moved: the signer proved ownership at
 * the time they signed, and a transfer ends that. Callers that already know the
 * current owner (the agent page reads it anyway) pass it here to drop the claim.
 * An unknown current owner is not evidence of a transfer, so it is not stale.
 */
export function claimIsStale(record: ClaimRecord, currentOwner: string | null | undefined): boolean {
  if (!currentOwner) return false;
  return !sameAddress(record.signer, currentOwner);
}

/**
 * The stored claim for an agent, or null when there is none. Pass
 * `currentOwner` where it is already known and a claim left behind by a
 * previous owner is dropped instead of returned.
 */
export async function getClaim(
  chainId: number,
  tokenId: string,
  opts: { kv?: ClaimKv; currentOwner?: string | null } = {},
): Promise<ClaimRecord | null> {
  const kv = opts.kv ?? liveClaimKv;
  const id = normalizeAgentId(tokenId);
  if (!id) return null;
  const record = parseClaim(await kv.get(claimKey(chainId, id)));
  if (!record) return null;
  return claimIsStale(record, opts.currentOwner) ? null : record;
}

/**
 * Every stored claim, newest last. Read as one index lookup plus a batched
 * MGET, so the listing and cron paths do not make one request per claim. Ids
 * whose record has since gone are skipped rather than returned as holes.
 */
export async function listClaims(kv: ClaimKv = liveClaimKv): Promise<ClaimRecord[]> {
  const ids = await readIndex(kv);
  if (ids.length === 0) return [];
  const values = await kv.mget(ids.map((id) => `${CLAIM_PREFIX}${id}`));
  return values.map(parseClaim).filter((record): record is ClaimRecord => record !== null);
}

export type ClaimDecision =
  | { ok: true; record: ClaimRecord }
  | { ok: false; status: 400 | 401 | 429 | 503; message: string };

function reject(status: 400 | 401 | 429 | 503, message: string): ClaimDecision {
  return { ok: false, status, message };
}

/** Shown whenever a chain read could not be made. The UI renders it verbatim. */
const CHAIN_UNAVAILABLE = 'the chain is not answering right now, please try again';

/**
 * Shown when this minute's budget for unauthenticated chain reads is spent.
 * Exported because it is the one refusal a caller can fix by waiting, so the
 * tests name it rather than repeating the string.
 */
export const CHAIN_READS_SPENT =
  'too many claim requests right now, please try again in a minute';

/**
 * Run a chain read so that a thrown error is the same answer as a read that
 * reported itself unavailable. `liveClaimChain` already catches its own errors;
 * this covers any other implementation, so no caller has to guess again.
 */
async function readChain<T>(read: () => Promise<ChainRead<T>>): Promise<ChainRead<T>> {
  try {
    return await read();
  } catch {
    return UNAVAILABLE;
  }
}

/**
 * Recent claim timestamps for an owner, already narrowed to the rate window.
 */
async function recentClaims(kv: ClaimKv, owner: string, now: number): Promise<number[]> {
  const raw = await kv.get(claimRateKey(owner));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((at): at is number => typeof at === 'number' && Number.isFinite(at))
      .filter((at) => now - at < CLAIM_RATE_WINDOW_MS);
  } catch {
    return [];
  }
}

/**
 * Everything POST /api/claim decides, with the chain and KV access injected so
 * every rejection is unit tested without a network. The route only unwraps the
 * request.
 *
 * Order is deliberate. The body is capped before it is parsed. The signature is
 * checked against the current on-chain owner, so a claim is only ever as good
 * as `ownerOf` at that moment. `hasBytecode` is read only once a signature has
 * recovered to some address and that address is not the owner, which is the
 * only case where the answer changes what the caller is told: a smart-contract
 * wallet signs with a key that is not the owner address, so it would otherwise
 * read as someone else's signature. The rate limit is counted after the
 * signature check, so a stranger cannot spend an owner's hourly budget for them.
 */
export async function decideClaim(input: {
  readBodyText: () => Promise<string>;
  chain: ClaimChain;
  kv?: ClaimKv;
  now?: () => number;
  /** Bucket the chain reads count against. From `clientKey(request.headers)`. */
  client?: string;
}): Promise<ClaimDecision> {
  const kv = input.kv ?? liveClaimKv;
  const now = input.now?.() ?? Date.now();

  let raw: string;
  try {
    raw = await input.readBodyText();
  } catch {
    return reject(400, 'unreadable body');
  }
  if (raw.length > MAX_BODY_CHARS) return reject(400, 'body too large');

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return reject(400, 'bad json');
  }

  const { fields: rawFields, signature: rawSignature } = (body ?? {}) as {
    fields?: unknown;
    signature?: unknown;
  };
  if (typeof rawSignature !== 'string' || !SIGNATURE.test(rawSignature)) {
    return reject(400, 'bad signature');
  }
  const signature = rawSignature as Hex;
  const fields = sanitizeFields(rawFields);

  if (fields.chainId !== CLAIM_CHAIN_ID) return reject(400, 'claims are supported on bnb chain only');
  if (!fields.tokenId) return reject(400, 'bad agent id');

  const issuedAt = Date.parse(fields.issuedAt);
  if (!Number.isFinite(issuedAt)) return reject(400, 'bad timestamp');
  if (Math.abs(now - issuedAt) > CLAIM_REPLAY_WINDOW_MS) {
    return reject(400, 'this claim was signed outside the ten minute window, please sign again');
  }

  // Storage is the point of the request, so an unconfigured KV answers before
  // any chain read rather than accepting a claim it would then drop.
  if (!kv.available()) return reject(503, 'kv not configured');

  // Everything above is decided from the body alone. The reads below are the
  // ones a stranger can aim at the shared RPC budget, so the counter runs here,
  // in front of them: the per-owner limit further down cannot do this job, it
  // is only reached once a signature has recovered to the owner.
  if (!(await takeChainRead({ client: input.client ?? UNATTRIBUTED_CLIENT, kv }))) {
    return reject(429, CHAIN_READS_SPENT);
  }

  // A node that did not answer is not evidence about the token, so it answers
  // 503 and the caller is told to try again rather than 400 and told not to.
  const ownerRead = await readChain(() => input.chain.ownerOf(fields.tokenId));
  if (!ownerRead.ok) return reject(503, CHAIN_UNAVAILABLE);
  const owner = ownerRead.value;
  if (!owner) return reject(400, 'this agent id has no owner on chain');

  let signer: Hex;
  try {
    signer = await recoverClaimSigner(fields, signature);
  } catch {
    return reject(400, 'bad signature');
  }

  if (!sameAddress(signer, owner)) {
    const codeRead = await readChain(() => input.chain.hasBytecode(owner));
    if (!codeRead.ok) return reject(503, CHAIN_UNAVAILABLE);
    if (codeRead.value) return reject(400, 'claiming from a contract wallet is not supported yet');
    return reject(401, 'connected wallet is not the owner of this agent');
  }

  const recent = await recentClaims(kv, owner, now);
  if (recent.length >= CLAIM_RATE_LIMIT) {
    return reject(429, 'too many claims from this owner in the last hour');
  }

  const record: ClaimRecord = {
    fields,
    signature,
    // The recovered signer rather than the owner as read: viem checksums it,
    // and the check above has already established that the two are the same
    // address.
    signer,
    savedAt: new Date(now).toISOString(),
  };
  if (!(await saveClaim(record, kv))) return reject(503, 'kv write failed');
  await kv.set(claimRateKey(owner), JSON.stringify([...recent, now]));

  return { ok: true, record };
}

export type ClaimLookup =
  | { ok: true; record: ClaimRecord }
  | { ok: false; status: 400 | 404 | 503; message: string };

/**
 * Everything GET /api/claim decides: what the query means and whether there is
 * a claim to serve. Pure apart from the injected KV, so the route only unwraps
 * the query string.
 *
 * There is deliberately no chain read here. This is the site's one
 * unauthenticated claim endpoint, and reading `ownerOf` per request would let
 * anyone spend the shared BNB Chain RPC budget the rest of the site depends on,
 * from behind a CDN cache that any extra query parameter walks straight past.
 * Staleness is still enforced, from the `owner` the caller passes: a caller that
 * already knows the current owner (an agent page reads it anyway) gets a claim
 * left behind by a transfer dropped, and every answer carries the `signer` the
 * claim was signed by so a caller can make the same comparison itself.
 */
export async function decideClaimLookup(input: {
  chainId: unknown;
  tokenId: unknown;
  owner?: unknown;
  kv?: ClaimKv;
}): Promise<ClaimLookup> {
  const kv = input.kv ?? liveClaimKv;

  const chainId = Number(input.chainId);
  if (chainId !== CLAIM_CHAIN_ID) {
    return { ok: false, status: 400, message: 'claims are supported on bnb chain only' };
  }
  const tokenId = normalizeAgentId(input.tokenId);
  if (!tokenId) return { ok: false, status: 400, message: 'bad agent id' };

  // An owner that cannot be read is refused rather than ignored: silently
  // dropping it would answer with a claim the caller asked to have checked.
  const owner = input.owner == null || input.owner === '' ? null : String(input.owner);
  if (owner !== null && !ADDRESS.test(owner)) {
    return { ok: false, status: 400, message: 'bad owner address' };
  }

  // Without KV there is no way to tell an unclaimed agent from an unreachable
  // store, and "no claim" is the wrong thing to say about the second.
  if (!kv.available()) return { ok: false, status: 503, message: 'kv not configured' };

  const record = await getClaim(chainId, tokenId, { kv });
  if (!record) return { ok: false, status: 404, message: 'no claim for this agent' };
  if (claimIsStale(record, owner)) {
    const message = 'this identity has changed hands since it was claimed';
    return { ok: false, status: 404, message };
  }
  return { ok: true, record };
}
