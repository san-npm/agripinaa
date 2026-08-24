import type { MetadataRoute } from "next";

import { siteUrl } from "@/lib/site";

/**
 * Crawlers were getting no guidance at all. Everything public is open; the
 * API surface and the per-account session dashboard are not pages a search
 * result should ever land on.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/dashboard"],
    },
    sitemap: siteUrl("/sitemap.xml"),
  };
}
