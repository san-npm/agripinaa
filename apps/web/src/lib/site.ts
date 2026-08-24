/**
 * Canonical public origin for this deployment.
 *
 * The agent manifests, `apps/agents/src/register.ts`, and the ERC-8004
 * attestations already write this origin into on-chain and crawler-visible
 * records, so metadata, robots, and the sitemap read the same constant rather
 * than guessing from a request header. Changing it means re-registering
 * manifests, which is why it is not env-driven.
 */
export const SITE_URL = "https://agripinaa.vercel.app";

/** Absolute URL for a path on this site, for sitemap and metadata fields. */
export function siteUrl(path: string): string {
  return new URL(path, SITE_URL).toString();
}

/**
 * Clamp a description to what a search result or a link preview actually
 * shows. Cuts on a word boundary so the snippet does not end mid-token.
 */
export function clampDescription(text: string, max = 155): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:]$/, "")}…`;
}
