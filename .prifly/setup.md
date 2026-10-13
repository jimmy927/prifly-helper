---
setup: []
---

The repository holds only `README.md` so far: no package manifest, lockfile, toolchain pin or
CI workflow, so a fresh worktree needs no install. Nothing outside the worktree is relied on.

When the extension gets a `package.json` and lockfile, replace `[]` with `seed: npm` (or the
matching frozen install for whichever package manager it adopts).
