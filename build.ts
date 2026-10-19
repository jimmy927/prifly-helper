/**
 * `bun run build`: the loadable extension in `dist/`, from nothing but this
 * repo. prifly's installer runs exactly this and copies `dist/` as the folder
 * the reader picks under "Load unpacked".
 *
 * - `src/background.ts` and `src/popup.ts` bundled to one file each.
 * - `static/` copied as is, with the manifest's version set from package.json.
 * - Every file the manifest and popup.html name is checked to exist.
 */

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const built = await Bun.build({
  entrypoints: [join(root, "src/background.ts"), join(root, "src/popup.ts")],
  outdir: dist,
  target: "browser",
  format: "esm",
  naming: "[name].[ext]",
  minify: false,
  sourcemap: "none",
});
if (!built.success) {
  for (const message of built.logs) console.error(message);
  throw new Error("bun build failed");
}

await cp(join(root, "static"), dist, { recursive: true });

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
const manifestPath = join(dist, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown> & {
  background: { service_worker: string };
  action: { default_popup: string; default_icon?: Record<string, string> };
  icons?: Record<string, string>;
};
manifest.version = pkg.version;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const popupHtml = await readFile(join(dist, manifest.action.default_popup), "utf8");
const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action.default_icon ?? {}),
  ...[...popupHtml.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1] ?? ""),
];
const missing = referenced.filter((file) => !existsSync(join(dist, file)));
if (missing.length > 0) throw new Error(`dist/ is missing ${missing.join(", ")}`);

console.log(`built dist/ (version ${pkg.version}): ${referenced.join(", ")}`);
