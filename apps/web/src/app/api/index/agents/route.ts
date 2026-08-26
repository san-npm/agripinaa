import { CATEGORIES, type Category } from "@agripinaa/agent-index";

import {
  listAgents,
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
    return Response.json(page);
  } catch (error) {
    if (error instanceof RegistryCursorInvalidError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof RegistryCursorExpiredError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
