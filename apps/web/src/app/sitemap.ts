import { CATEGORIES } from "@agripinaa/agent-index";
import { BSC_MAINNET } from "@agripinaa/shared";
import type { MetadataRoute } from "next";

import { siteUrl } from "@/lib/site";
import { VERIFIED_IDS } from "@/lib/verified";

/**
 * Evaluated once when this route is generated, not per request, so the whole
 * sitemap reports one build stamp rather than "modified just now" on every
 * crawl.
 */
const BUILT_AT = new Date();

/**
 * Only routes that exist and are worth indexing. The registry long tail is
 * deliberately absent: those profiles are third-party registrations we do not
 * vouch for, and they change under us. `/dashboard` is per-account and
 * disallowed in robots.ts.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: siteUrl("/"), lastModified: BUILT_AT, changeFrequency: "daily", priority: 1 },
    { url: siteUrl("/agents"), lastModified: BUILT_AT, changeFrequency: "daily", priority: 0.9 },
    { url: siteUrl("/proof"), lastModified: BUILT_AT, changeFrequency: "hourly", priority: 0.8 },
    { url: siteUrl("/funds"), lastModified: BUILT_AT, changeFrequency: "hourly", priority: 0.8 },
    { url: siteUrl("/leaderboard"), lastModified: BUILT_AT, changeFrequency: "hourly", priority: 0.8 },
    ...CATEGORIES.map((category) => ({
      url: siteUrl(`/c/${category}`),
      lastModified: BUILT_AT,
      changeFrequency: "daily" as const,
      priority: 0.7,
    })),
    ...VERIFIED_IDS.map((tokenId) => ({
      url: siteUrl(`/agent/${BSC_MAINNET.id}/${tokenId}`),
      lastModified: BUILT_AT,
      changeFrequency: "daily" as const,
      priority: 0.6,
    })),
  ];
}
