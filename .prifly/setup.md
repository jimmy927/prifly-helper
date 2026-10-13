---
setup:
  - bun install --frozen-lockfile
---

One install of the extension's dependencies (zod, and the TypeScript, Bun and Chrome types the
tests and the typecheck use), pinned by `bun.lock`. `bun test` and `bun run typecheck` run from
source; `bun run build` writes `dist/`, which only loading the extension needs.

What it relies on outside the worktree:
- `bun` on PATH, 1.4.2 (the version that wrote `bun.lock`). `--frozen-lockfile` fails if the Bun
  minor version is different.
- Network access to the npm registry, or Bun's global cache (`~/.bun/install/cache`).
