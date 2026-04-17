# P5.05 — @swarm/web scaffold (Vite + React + Tailwind)

## Goal
Create a new `@swarm/web` package with a Vite-built React app, Tailwind CSS
for styling, and shadcn/ui primitives. The initial page just fetches `/health`
from the server and shows "connected" or an error — proves the full stack is
wired.

## Depends on
- P5.01 (`@swarm/server` — need something to fetch)

## Scope

- Files to create:
  - `packages/web/package.json`
  - `packages/web/tsconfig.json` (extends root, emits nothing — Vite handles build)
  - `packages/web/vite.config.ts` — dev server proxies `/api/*` to `http://localhost:3000`
  - `packages/web/tailwind.config.ts`
  - `packages/web/postcss.config.js`
  - `packages/web/index.html`
  - `packages/web/src/main.tsx` — React entry
  - `packages/web/src/App.tsx` — layout shell with a health-check badge
  - `packages/web/src/lib/api.ts` — thin fetch client (`fetch('/api/health')`)
  - `packages/web/src/styles/globals.css`
  - `packages/web/test/App.test.tsx`
- Files to modify:
  - root `package.json` if needed (workspace detection)
- Dependencies (all pinned):
  - `react`, `react-dom`, `vite`, `@vitejs/plugin-react`
  - `tailwindcss`, `postcss`, `autoprefixer`
  - shadcn/ui primitives via `@radix-ui/react-*` + `class-variance-authority`
  - `@testing-library/react`, `@testing-library/jest-dom`, `happy-dom` for tests

## Tests

- `App.test.tsx`: renders the health badge, mocks fetch to return `{ok:true}`, asserts "connected"
- Vite build completes without errors (`bun run --filter='@swarm/web' build`)

## Verification

- `bun run ci` passes (including the new web test)
- Smoke:
  - Terminal A: `bun run packages/cli/bin/swarm.ts serve --port 3000`
  - Terminal B: `cd packages/web && bun run dev` (Vite on port 5173 proxies /api → 3000)
  - Open `http://localhost:5173` → see "connected" badge

## Out of scope

- Graph view (task 06)
- Event timeline (task 07)
- Step drilldown (task 08)
- Routing — stay on a single page for now

## Reusable patterns

- None yet on the web side — this is the scaffold
- Follow the existing `packages/*/package.json` structure for the workspace
- Tailwind with shadcn: `npx shadcn@latest init` generates the baseline; don't
  over-customize theme for now
