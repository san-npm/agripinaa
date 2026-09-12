import { CATEGORIES, IndexCursorLaneError, type Category } from "@agripinaa/agent-index";

import {
  listAgents,
  listFirstParty,
  RegistryCursorExpiredError,
  RegistryCursorInvalidError,
  validRegistryCursor,
} from "@/lib/data";

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

  // The cursor is either an upstream numeric offset/page or our bounded
  // position inside one 100-row upstream window. Reject anything else so it
  // cannot mint unbounded cache entries or reach upstream as a NaN offset.
  const rawCursor = url.searchParams.get("cursor") ?? undefined;
  const cursor =
    rawCursor === undefined
      ? undefined
      : validRegistryCursor(rawCursor)
        ? rawCursor
        : null;
  if (cursor === null) {
    return Response.json({ error: "invalid cursor" }, { status: 400 });
  }

  try {
    const page = await listAgents(category, limit, cursor);
    if (cursor !== undefined) return Response.json(page);
    // The first page leads with our own agents in the category, as the hub
    // pages do. The registry window is a sample of the newest registrations,
    // and a client reading this API rather than the page would otherwise
    // never see the agents that actually have a track record here.
    const firstParty = await listFirstParty(category);
    const pinned = new Set(firstParty.map((a) => a.tokenId));
    return Response.json({
      ...page,
      items: [...firstParty, ...page.items.filter((a) => !pinned.has(a.tokenId))],
    });
  } catch (error) {
    if (error instanceof RegistryCursorInvalidError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof RegistryCursorExpiredError || error instanceof IndexCursorLaneError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
