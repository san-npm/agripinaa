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
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "24", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(limitRaw, 100) : 24;
  const cursor = url.searchParams.get("cursor") ?? undefined;

  const page = await listAgents(category, limit, cursor);
  return Response.json(page);
}
