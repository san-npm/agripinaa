import { CATEGORIES, type Category } from "@agripinaa/agent-index";

import { listAgents } from "@/lib/data";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const rawCategory = url.searchParams.get("category") ?? undefined;
  const category = CATEGORIES.find((c) => c === rawCategory) as
    | Category
    | undefined;
  if (rawCategory && !category) {
    return Response.json(
      { error: `Unknown category "${rawCategory}"` },
      { status: 400 },
    );
  }
  // Clamp to [1,100]: a negative limit becomes slice(0,-1) in the snapshot
  // fallback (bypassing the cap) and garbage offsets upstream.
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "24", 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), 100)
    : 24;

  // cursor is an opaque numeric offset/page; reject anything else so it can't
  // mint unbounded cache entries or reach upstream as a "NaN" offset.
  const rawCursor = url.searchParams.get("cursor") ?? undefined;
  const cursor =
    rawCursor === undefined
      ? undefined
      : /^\d{1,9}$/.test(rawCursor)
        ? rawCursor
        : null;
  if (cursor === null) {
    return Response.json({ error: "invalid cursor" }, { status: 400 });
  }

  const page = await listAgents(category, limit, cursor);
  return Response.json(page);
}
