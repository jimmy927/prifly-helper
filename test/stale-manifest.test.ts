import { expect, test } from "bun:test";
import { manifestChanged, reloadIfManifestStale } from "../src/stale-manifest";
import { FakeStorage } from "./fakes";

const before = { name: "prifly Helper", action: { default_popup: "popup.html" } };
const after = { ...before, action: { default_popup: "popup.html", default_icon: { "16": "icons/icon-16.png" } } };

test("a key the loaded manifest lacks or holds differently is a change", () => {
  expect(manifestChanged(after, before)).toBe(true);
  expect(manifestChanged(before, { ...before, current_locale: "en" })).toBe(false);
});

test("reloads once for a changed manifest on disk, and not again for the same one", async () => {
  const local = new FakeStorage();
  let reloads = 0;
  const deps = {
    readOnDisk: async () => JSON.stringify(after),
    loaded: before,
    local,
    reload: () => {
      reloads++;
    },
  };
  expect(await reloadIfManifestStale(deps)).toBe(true);
  expect(await reloadIfManifestStale(deps)).toBe(false);
  expect(reloads).toBe(1);
});

test("an up-to-date manifest never reloads", async () => {
  let reloads = 0;
  await reloadIfManifestStale({
    readOnDisk: async () => JSON.stringify(after),
    loaded: after,
    local: new FakeStorage(),
    reload: () => {
      reloads++;
    },
  });
  expect(reloads).toBe(0);
});
