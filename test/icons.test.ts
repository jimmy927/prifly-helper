import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import manifest from "../static/manifest.json";

const staticDir = join(import.meta.dir, "../static");
const SOURCE_DIR = "/home/jimmy/src/prifly/apps/desktop-shell/assets/generated";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const declared: [string, string][] = [
  ...Object.entries(manifest.icons),
  ...Object.entries(manifest.action.default_icon),
];

test("the manifest declares the four sizes in both places", () => {
  expect(Object.keys(manifest.icons)).toEqual(["16", "32", "48", "128"]);
  expect(Object.keys(manifest.action.default_icon)).toEqual(["16", "32", "48", "128"]);
});

for (const [size, path] of declared) {
  test(`${path} is a ${size}x${size} PNG`, () => {
    const file = join(staticDir, path);
    expect(existsSync(file)).toBe(true);
    const bytes = readFileSync(file);
    expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    // IHDR is the first chunk: length(4) "IHDR"(4) width(4) height(4).
    expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(bytes.readUInt32BE(16)).toBe(Number(size));
    expect(bytes.readUInt32BE(20)).toBe(Number(size));
  });
}

for (const size of ["16", "32", "48", "128"]) {
  const name = `icon-${size}.png`;
  test.skipIf(!existsSync(join(SOURCE_DIR, name)))(`${name} is byte-identical to prifly's source`, () => {
    const ours = readFileSync(join(staticDir, "icons", name));
    expect(ours.equals(readFileSync(join(SOURCE_DIR, name)))).toBe(true);
  });
}
