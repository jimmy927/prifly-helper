import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import manifest from "../static/manifest.json";

/** The id prifly's host lets open `/helper` (`apps/desktop-host/src/helper/extension-id.ts`). */
const HELPER_ID = "dmkobenilcamkhdpaccnpdpmonajocmh";

/** Chrome's id for an extension: sha256 of the key's DER, first 32 hex digits mapped 0-f to a-p. */
function extensionIdOf(key: string): string {
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
}

test("the manifest's key gives the id prifly expects", () => {
  expect(extensionIdOf(manifest.key)).toBe(HELPER_ID);
});
