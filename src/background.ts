/**
 * The service worker: the real `chrome.*` behind `Platform`, the client, the
 * 30 s alarm that wakes a suspended worker, and the popup's requests.
 *
 * Chrome may stop this worker whenever it is idle; nothing here lives only in
 * memory across that. Every start (install, browser start, alarm, popup)
 * runs this file top to bottom: the client loads its pairing and outbox from
 * storage and connects again.
 */

import { z } from "zod";
import { HelperClient } from "./client";
import { messageOf } from "./commands/common";
import type { PopupReply, PopupRequest } from "./messages";
import { type ChromeApi, type Platform, realClock, type TabInfo } from "./platform";
import { reloadIfManifestStale } from "./stale-manifest";

const KEEPALIVE = "prifly-helper-keepalive";

// MV3 forbids eval: without this zod probes `new Function` on its first parse, and the CSP
// refusal lands as an error on the extension's card in chrome://extensions.
z.config({ jitless: true });

function tabInfo(tab: chrome.tabs.Tab): TabInfo {
  if (tab.id === undefined) throw new Error("a tab without an id");
  return {
    id: tab.id,
    url: tab.url ?? tab.pendingUrl ?? "",
    status: tab.status ?? "loading",
    windowId: tab.windowId,
    active: tab.active,
  };
}

/** "Chrome 141" or "Edge 141", from the user agent's brands (or its string, where there are none). */
function browserName(): string {
  const data = (navigator as Navigator & { userAgentData?: { brands: { brand: string; version: string }[] } })
    .userAgentData;
  const brands = data?.brands ?? [];
  const pick = (name: string) => brands.find((brand) => brand.brand === name);
  const edge = pick("Microsoft Edge");
  if (edge !== undefined) return `Edge ${edge.version}`;
  const chrome = pick("Google Chrome");
  if (chrome !== undefined) return `Chrome ${chrome.version}`;
  const ua = navigator.userAgent;
  const edgeUa = /Edg\/(\d+)/.exec(ua);
  if (edgeUa !== null) return `Edge ${edgeUa[1]}`;
  const chromeUa = /Chrome\/(\d+)/.exec(ua);
  if (chromeUa !== null) return `Chrome ${chromeUa[1]}`;
  return "Chromium";
}

const OS_NAMES: Record<string, string> = {
  win: "Windows",
  mac: "macOS",
  linux: "Linux",
  cros: "ChromeOS",
  android: "Android",
  openbsd: "OpenBSD",
  fuchsia: "Fuchsia",
};

const realChrome: ChromeApi = {
  local: chrome.storage.local,
  session: chrome.storage.session,
  extensionVersion: () => chrome.runtime.getManifest().version,
  browser: browserName,
  os: async () => {
    const info = await chrome.runtime.getPlatformInfo();
    return OS_NAMES[info.os] ?? info.os;
  },
  userScriptsAllowed: () => {
    // Chrome's documented check: the API is missing, or throws, until the reader allows user scripts.
    try {
      void chrome.userScripts.getScripts();
      return true;
    } catch {
      return false;
    }
  },
  userScriptsExecute: ({ tabId, code, world }) =>
    chrome.userScripts.execute({ target: { tabId }, js: [{ code }], world }),
  tabsQuery: async () =>
    (await chrome.tabs.query({})).filter((tab) => tab.id !== undefined).map(tabInfo),
  tabsGet: async (tabId) => tabInfo(await chrome.tabs.get(tabId)),
  tabsCreate: async (props) => tabInfo(await chrome.tabs.create(props)),
  tabsActivate: async (tabId) => {
    await chrome.tabs.update(tabId, { active: true });
  },
  captureVisibleTab: (windowId) => chrome.tabs.captureVisibleTab(windowId, { format: "png" }),
  sessionRules: () => chrome.declarativeNetRequest.getSessionRules(),
  updateSessionRules: (change) =>
    chrome.declarativeNetRequest.updateSessionRules(
      change as chrome.declarativeNetRequest.UpdateRuleOptions,
    ),
  cookies: (url, name) => chrome.cookies.getAll({ url, name }),
};

const platform: Platform = {
  chrome: realChrome,
  openSocket: (url) => new WebSocket(url),
  fetch: (url, init) => fetch(url, init),
  clock: realClock,
};

const client = new HelperClient(platform);

/** Rules a worker that died mid-fetch left behind: each only ever matched one URL. */
async function clearStaleRules(): Promise<void> {
  const rules = await realChrome.sessionRules();
  if (rules.length > 0) {
    await realChrome.updateSessionRules({ removeRuleIds: rules.map((rule) => rule.id) });
  }
}

async function ensureAlarm(): Promise<void> {
  if ((await chrome.alarms.get(KEEPALIVE)) === undefined) {
    await chrome.alarms.create(KEEPALIVE, { periodInMinutes: 0.5 });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE) void client.tick();
});

chrome.runtime.onStartup.addListener(() => void client.tick());
chrome.runtime.onInstalled.addListener(() => void ensureAlarm());

async function answer(request: PopupRequest): Promise<void> {
  switch (request.type) {
    case "refresh":
      return client.tick();
    case "pair":
      return client.pair(request.code, request.profile);
    case "retry":
      return client.retry();
    case "setPort":
      return client.setPort(request.port);
    case "pause":
      return client.setPause(Date.now() + request.minutes * 60_000);
    case "resume":
      return client.setPause(null);
  }
}

chrome.runtime.onMessage.addListener((request: PopupRequest, sender, reply: (r: PopupReply) => void) => {
  if (sender.id !== chrome.runtime.id) return false;
  answer(request).then(
    () => reply({ ok: true }),
    (error: unknown) => reply({ ok: false, error: messageOf(error) }),
  );
  return true;
});

void (async () => {
  const reloading = await reloadIfManifestStale({
    readOnDisk: async () => (await fetch(chrome.runtime.getURL("manifest.json"))).text(),
    loaded: chrome.runtime.getManifest() as unknown as Record<string, unknown>,
    local: chrome.storage.local,
    reload: () => chrome.runtime.reload(),
  }).catch((error: unknown) => {
    console.warn("prifly Helper: could not compare the manifest on disk", messageOf(error));
    return false;
  });
  if (reloading) return;
  await clearStaleRules().catch((error: unknown) =>
    console.warn("prifly Helper: could not clear old session rules", messageOf(error)),
  );
  await ensureAlarm();
  await client.start();
})();
