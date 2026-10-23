/**
 * Chrome reads an unpacked extension's manifest only when it loads the
 * extension, but serves every other file straight from disk. prifly's
 * installer updates `dist/` in place, so after an update that changed the
 * manifest the popup is new while the toolbar icon, permissions and the rest
 * stay what was loaded (on 2026-10-19 the icons arrived and the toolbar kept
 * Chrome's grey letter). The worker compares the manifest on disk with the
 * loaded one at each start and reloads itself when they differ — once per
 * manifest on disk, so a difference Chrome itself introduces cannot loop.
 */

import type { StorageArea } from "./platform";

const RELOADED_FOR = "reloadedForManifest";

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (!sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

/** True when a key the manifest on disk declares has another value in the loaded one. */
export function manifestChanged(onDisk: Record<string, unknown>, loaded: Record<string, unknown>): boolean {
  return Object.keys(onDisk).some((key) => !sameJson(onDisk[key], loaded[key]));
}

export async function reloadIfManifestStale(deps: {
  readOnDisk(): Promise<string>;
  loaded: Record<string, unknown>;
  local: StorageArea;
  reload(): void;
}): Promise<boolean> {
  const text = await deps.readOnDisk();
  const onDisk = JSON.parse(text) as Record<string, unknown>;
  if (!manifestChanged(onDisk, deps.loaded)) return false;
  const stored = await deps.local.get([RELOADED_FOR]);
  if (stored[RELOADED_FOR] === text) return false;
  await deps.local.set({ [RELOADED_FOR]: text });
  deps.reload();
  return true;
}
