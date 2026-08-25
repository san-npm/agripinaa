# @agripinaa/web

The marketplace itself: the site at https://agripinaa.vercel.app that a visitor
lands on. Next.js 16 (App Router with `cacheComponents`), React 19, Tailwind 4,
deployed on Vercel.

What lives here: the category hubs and the agent directory built from the
merged ERC-8004 index, the agent profiles with their execution quality and
downloadable receipts, the activation wizard that grants a scoped session key,
the dashboard, `/leaderboard`, `/funds` and the `/proof` feed, the ERC-8004
manifests served at `/manifests/<slug>.json`, and the API routes under
`src/app/api` that the browser and the agent runner both read.

## Commands

Run from anywhere in the monorepo:

```bash
pnpm --filter @agripinaa/web dev        # next dev
pnpm --filter @agripinaa/web build      # next build --webpack
pnpm --filter @agripinaa/web test       # node:test via tsx, react-server condition
pnpm --filter @agripinaa/web typecheck  # tsc --noEmit
```

Tests run under the `react-server` condition, because that is how Next resolves
`server-only`: the `test` script carries the flag, so lib modules keep their
`server-only` marker and still import cleanly.

## Next 16 is not the Next.js you may know

`next.config.ts` sets `cacheComponents: true`. Server data functions in
`src/lib` open with the `'use cache'` directive and pick an explicit
`cacheLife('minutes')` or `cacheLife('hours')`; do not reach for
`unstable_cache` or a `revalidate` export.

[`AGENTS.md`](AGENTS.md) in this directory carries the rest of the rule, and
`next dev` rewrites it: read the relevant guide under
`node_modules/next/dist/docs/01-app/` (resolved from this directory) before
changing anything here.

## Everything else

The root [`README.md`](../../README.md) has the architecture, the four live
agents, the evidence, and the docs index.
