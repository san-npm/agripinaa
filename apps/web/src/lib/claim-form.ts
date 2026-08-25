import { CATEGORIES } from '@agripinaa/agent-index/types';

import { CATEGORY_INFO } from './categories';
import { sanitizeFields, type ClaimFields } from './claim-message';

/**
 * The form half of the claim flow: what the four inputs are called, and how the
 * values in them become the exact fields the browser signs.
 *
 * Isomorphic on purpose (no `server-only`, no KV, no RPC), because the claim
 * form is a client component. It sits on top of `claim-message.ts` rather than
 * beside it: `sanitizeFields` is the one rule for what a claim may carry, and a
 * second copy of it here would eventually disagree with the server's.
 */

export type ClaimCategory = ClaimFields['category'];

/**
 * The categories a claim may pick, in hub order, with 'other' last. Derived
 * from `CATEGORIES` so a new hub reaches the form without an edit here, and so
 * the form can never offer a value `sanitizeFields` would silently rewrite.
 */
export const CLAIM_CATEGORY_OPTIONS: { value: ClaimCategory; label: string }[] = [
  ...CATEGORIES.map((value) => ({ value, label: CATEGORY_INFO[value].label })),
  { value: 'other', label: 'Other' },
];

export interface ClaimFormValues {
  description: string;
  category: ClaimCategory;
  website: string;
  endpoint: string;
}

/** A link the owner typed that the sanitiser refused to carry. */
export type DroppedLink = 'website' | 'endpoint';

export interface PreparedClaim {
  /** Exactly what gets signed and posted. */
  fields: ClaimFields;
  /**
   * Links the owner filled in that came back empty. `sanitizeFields` drops an
   * unusable link silently so a claim with a bad URL still lands with its
   * description intact, which is the right call for the record and the wrong
   * one for the person typing: without this the field just vanishes.
   */
  dropped: DroppedLink[];
}

/** The form values as the signed, sanitised fields, plus what got dropped. */
export function prepareClaim(input: {
  chainId: number;
  tokenId: string;
  values: ClaimFormValues;
  /** ISO instant, taken at submit time: the server allows a ten minute window. */
  issuedAt: string;
}): PreparedClaim {
  const fields = sanitizeFields({
    chainId: input.chainId,
    tokenId: input.tokenId,
    description: input.values.description,
    category: input.values.category,
    website: input.values.website,
    endpoint: input.values.endpoint,
    issuedAt: input.issuedAt,
  });
  const dropped = (['website', 'endpoint'] as const).filter(
    (key) => input.values[key].trim() !== '' && fields[key] === '',
  );
  return { fields, dropped };
}
