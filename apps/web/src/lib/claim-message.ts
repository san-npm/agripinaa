import { CATEGORIES, type Category } from '@agripinaa/agent-index';
import { assertSafeUrl } from '@agripinaa/shared/ssrf';
import { recoverTypedDataAddress, type Hex, type TypedDataDefinition } from 'viem';

/**
 * The claim message an agent's on-chain owner signs, plus the sanitiser that
 * decides what a claim may contain. Deliberately free of `server-only`, KV,
 * and RPC: the browser has to build and sign the exact same message the server
 * verifies, so the definition lives in one isomorphic module and the server
 * side (storage, ownership, rate limits) sits in `claims.ts` on top of it.
 *
 * Client components import `buildClaimMessage` and `sanitizeFields` from here,
 * never from `@/lib/claims`: that module is `server-only` and pulls the KV
 * client with it, so importing it from a `'use client'` file fails the build.
 * The browser must sanitise the form values and sign the sanitised result,
 * because the server verifies the signature over the sanitised fields.
 */

export const CLAIM_DOMAIN_NAME = 'Agripinaa';
export const CLAIM_DOMAIN_VERSION = '1';

/**
 * No `verifyingContract`: nothing on-chain consumes this signature, so binding
 * it to an address would only invite the impression that a contract checks it.
 * `chainId` in the domain still keeps a mainnet claim from being replayed as a
 * testnet one.
 */
export const CLAIM_TYPES = {
  AgentClaim: [
    { name: 'chainId', type: 'uint256' },
    { name: 'tokenId', type: 'string' },
    { name: 'description', type: 'string' },
    { name: 'category', type: 'string' },
    { name: 'website', type: 'string' },
    { name: 'endpoint', type: 'string' },
    { name: 'issuedAt', type: 'string' },
  ],
} as const;

export interface ClaimFields {
  chainId: number;
  tokenId: string;
  description: string;
  category: Category | 'other';
  website: string;
  endpoint: string;
  /** ISO 8601 instant, checked against CLAIM_REPLAY_WINDOW_MS by the server. */
  issuedAt: string;
}

/** A claim is roughly 1 KB of text; these caps are what gets stored and rendered. */
export const MAX_DESCRIPTION_CHARS = 600;
export const MAX_URL_CHARS = 300;

/**
 * How far `issuedAt` may sit from the server's clock, in either direction. A
 * captured claim body stays replayable only for this long, and a wallet whose
 * clock is a few minutes out still works.
 */
export const CLAIM_REPLAY_WINDOW_MS = 10 * 60 * 1_000;

/** uint256 in decimal is at most 78 digits. */
const AGENT_ID = /^\d{1,78}$/;

/**
 * The one agent-id rule in the claim flow: a decimal uint256, normalised so
 * `000297380` and `297380` are the same id and land on the same KV key. Anything
 * else answers '', which every caller reads as "not an agent id".
 *
 * Exported because the query parser, the KV key, and the field sanitiser all
 * need it and a second copy of the pattern would eventually disagree with this
 * one. Trimmed input longer than 78 digits is refused rather than truncated: a
 * cut-down id is a different id.
 */
export function normalizeAgentId(value: unknown): string {
  const raw = cleanText(value, 79);
  return AGENT_ID.test(raw) ? BigInt(raw).toString() : '';
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // Control characters are stripped rather than kept: this text is rendered in
  // a page and read back out of KV, and neither wants a stray escape sequence.
  const collapsed = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return collapsed.slice(0, max).trim();
}

/**
 * Keep the owner's own string when it is an https URL the SSRF guard accepts,
 * and drop it otherwise. The string is kept verbatim rather than normalised
 * through `URL`, so what the owner signed is what gets stored: `https://x.com`
 * would come back from the parser as `https://x.com/` and no longer match the
 * signature. Task 22 re-validates before it ever fetches one of these.
 */
function cleanUrl(value: unknown): string {
  const raw = cleanText(value, MAX_URL_CHARS);
  if (!raw || !/^https:\/\//i.test(raw)) return '';
  try {
    assertSafeUrl(raw);
  } catch {
    return '';
  }
  return raw;
}

/**
 * Reduce arbitrary input to the exact shape a claim may carry. Idempotent by
 * construction: `sanitizeFields(sanitizeFields(x))` equals `sanitizeFields(x)`,
 * which is what lets the server verify the signature over the sanitised fields
 * while the browser signs the same sanitised fields.
 *
 * Anything unusable becomes an empty string (or `0` for the chain, `'other'`
 * for the category) rather than throwing; the caller decides which of those are
 * fatal. A rejected website or endpoint is dropped silently, so a claim with a
 * bad link still lands with its description intact.
 */
export function sanitizeFields(input: unknown): ClaimFields {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const chainId = Number(raw.chainId);
  const category = CATEGORIES.find((c) => c === raw.category);
  return {
    chainId: Number.isSafeInteger(chainId) && chainId > 0 ? chainId : 0,
    tokenId: normalizeAgentId(raw.tokenId),
    description: cleanText(raw.description, MAX_DESCRIPTION_CHARS),
    category: category ?? 'other',
    website: cleanUrl(raw.website),
    endpoint: cleanUrl(raw.endpoint),
    issuedAt: cleanText(raw.issuedAt, 40),
  };
}

/** The EIP-712 payload for these fields, ready for `signTypedData`. */
export function buildClaimMessage(
  fields: ClaimFields,
): TypedDataDefinition<typeof CLAIM_TYPES, 'AgentClaim'> {
  return {
    domain: {
      name: CLAIM_DOMAIN_NAME,
      version: CLAIM_DOMAIN_VERSION,
      chainId: fields.chainId,
    },
    types: CLAIM_TYPES,
    primaryType: 'AgentClaim',
    message: {
      chainId: BigInt(fields.chainId),
      tokenId: fields.tokenId,
      description: fields.description,
      category: fields.category,
      website: fields.website,
      endpoint: fields.endpoint,
      issuedAt: fields.issuedAt,
    },
  };
}

/** Case-insensitive address comparison, for values from different sources. */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

/**
 * The address whose key produced this signature over these fields. Throws when
 * the signature is not recoverable at all. A smart-contract wallet recovers to
 * the key that signed for it, not to the wallet, which is why the route treats
 * a recovered address that is not the owner as a possible contract wallet
 * before it calls it a mismatch.
 */
export async function recoverClaimSigner(fields: ClaimFields, signature: Hex): Promise<Hex> {
  return recoverTypedDataAddress({ ...buildClaimMessage(fields), signature });
}

/** Whether `signature` over `fields` was produced by `owner`'s key. */
export async function verifyClaimSignature(input: {
  fields: ClaimFields;
  signature: Hex;
  owner: Hex;
}): Promise<boolean> {
  try {
    return sameAddress(await recoverClaimSigner(input.fields, input.signature), input.owner);
  } catch {
    return false;
  }
}
