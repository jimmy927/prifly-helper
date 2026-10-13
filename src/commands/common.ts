/** What every command shares: its typed failure, the site check and finding or opening a tab. */

import { allowedUrl } from "../match-pattern";
import { type Platform, sleep, type TabInfo } from "../platform";
import type { HelperErrorKind } from "../protocol";

/** A command's failure, as the result frame reports it. */
export class CommandError extends Error {
  readonly kind: HelperErrorKind;

  constructor(kind: HelperErrorKind, message: string) {
    super(message);
    this.name = "CommandError";
    this.kind = kind;
  }
}

/** The moment a command must have answered by, on the platform's clock. */
export type Deadline = number;

/** Refuse a URL outside the sending plugin's declared sites. */
export function mustBeAllowed(sites: readonly string[], url: string): void {
  if (!allowedUrl(sites, url)) {
    throw new CommandError("refused", `${url || "this tab"} is outside the plugin's declared sites.`);
  }
}

/** The tab as it is now; a tab that is gone is a "tab" failure. */
export async function currentTab(platform: Platform, tabId: number): Promise<TabInfo> {
  try {
    return await platform.chrome.tabsGet(tabId);
  } catch (error) {
    throw new CommandError("tab", `Tab ${tabId} is gone: ${messageOf(error)}`);
  }
}

/** A tab the plugin named by id, re-read and checked against its sites right before acting on it. */
export async function allowedTab(
  platform: Platform,
  tabId: number,
  sites: readonly string[],
): Promise<TabInfo> {
  const tab = await currentTab(platform, tabId);
  mustBeAllowed(sites, tab.url);
  return tab;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export type Match = "origin" | "prefix" | "exact";

export function urlMatches(match: Match, wanted: string, actual: string): boolean {
  if (match === "exact") return actual === wanted;
  if (match === "prefix") return actual.startsWith(wanted);
  const origin = originOf(wanted);
  return origin !== null && originOf(actual) === origin;
}

export type FoundTab = { tab: TabInfo; created: boolean };

/** An open tab whose URL matches (and is inside the sites), or a new one opened on `url`. */
export async function findOrOpenTab(
  platform: Platform,
  want: { url: string; match: Match; active: boolean; reuse: boolean; sites: readonly string[] },
): Promise<FoundTab> {
  mustBeAllowed(want.sites, want.url);
  if (want.reuse) {
    const tabs = await platform.chrome.tabsQuery();
    const found = tabs.find(
      (tab) => urlMatches(want.match, want.url, tab.url) && allowedUrl(want.sites, tab.url),
    );
    if (found !== undefined) {
      if (want.active && !found.active) await platform.chrome.tabsActivate(found.id);
      return { tab: found, created: false };
    }
  }
  try {
    const tab = await platform.chrome.tabsCreate({ url: want.url, active: want.active });
    return { tab: { ...tab, url: tab.url || want.url }, created: true };
  } catch (error) {
    throw new CommandError("tab", `Could not open ${want.url}: ${messageOf(error)}`);
  }
}

const POLL_MS = 100;

/** Until the tab has loaded, or the deadline passes ("timeout"). */
export async function waitForLoad(platform: Platform, tabId: number, deadline: Deadline): Promise<void> {
  for (;;) {
    const tab = await currentTab(platform, tabId);
    if (tab.status === "complete") return;
    if (platform.clock.now() >= deadline) {
      throw new CommandError("timeout", `Tab ${tabId} did not finish loading in time.`);
    }
    await sleep(platform.clock, POLL_MS);
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
