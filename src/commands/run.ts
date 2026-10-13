/**
 * `run`: a plugin's code in a tab, through `chrome.userScripts.execute`. The
 * last expression may be a promise: Chrome waits for it. The value must be
 * JSON-serialisable. A tab named by URL is found or opened (in the
 * background) and waited for; `waitFor` waits for the load or a selector
 * first. The tab's URL is checked against the plugin's sites right before the
 * code runs.
 */

import type { Platform } from "../platform";
import type { HelperRunSpec, HelperRunValue, HelperWaitFor } from "../protocol";
import {
  allowedTab,
  CommandError,
  type Deadline,
  findOrOpenTab,
  messageOf,
  waitForLoad,
} from "./common";

const SELECTOR_WAIT_MS = 10_000;

/** A user script that answers true once `selector` matches, false after `timeoutMs`. */
export function selectorWaitCode(selector: string, timeoutMs: number): string {
  return `new Promise((resolve) => {
  const started = Date.now();
  const tick = () => {
    if (document.querySelector(${JSON.stringify(selector)}) !== null) return resolve(true);
    if (Date.now() - started > ${Math.max(0, Math.floor(timeoutMs))}) return resolve(false);
    setTimeout(tick, 100);
  };
  tick();
})`;
}

async function execute(
  platform: Platform,
  tabId: number,
  code: string,
  world: "USER_SCRIPT" | "MAIN",
): Promise<unknown> {
  let results: Awaited<ReturnType<Platform["chrome"]["userScriptsExecute"]>>;
  try {
    results = await platform.chrome.userScriptsExecute({ tabId, code, world });
  } catch (error) {
    const message = messageOf(error);
    if (/no tab with id/i.test(message)) throw new CommandError("tab", message);
    throw new CommandError("script", message);
  }
  const first = results[0];
  if (first === undefined) throw new CommandError("script", "The script gave no result.");
  if (first.error !== undefined) throw new CommandError("script", first.error);
  return first.result ?? null;
}

async function waitFirst(
  platform: Platform,
  tabId: number,
  waitFor: HelperWaitFor,
  deadline: Deadline,
): Promise<void> {
  if (waitFor === "load") {
    await waitForLoad(platform, tabId, deadline);
    return;
  }
  const left = Math.max(0, deadline - platform.clock.now());
  const timeoutMs = Math.min(waitFor.timeoutMs ?? SELECTOR_WAIT_MS, left);
  const found = await execute(platform, tabId, selectorWaitCode(waitFor.selector, timeoutMs), "USER_SCRIPT");
  if (found !== true) {
    throw new CommandError("timeout", `No ${waitFor.selector} appeared in ${timeoutMs} ms.`);
  }
}

export async function runRun(
  platform: Platform,
  spec: HelperRunSpec,
  deadline: Deadline,
): Promise<HelperRunValue> {
  if (!platform.chrome.userScriptsAllowed()) {
    throw new CommandError(
      "no-user-scripts",
      "Allow User Scripts is off for the prifly Helper: turn it on on its Details page.",
    );
  }
  let tabId: number;
  if (spec.url !== undefined) {
    const { tab, created } = await findOrOpenTab(platform, {
      url: spec.url,
      match: "origin",
      active: false,
      reuse: true,
      sites: spec.sites,
    });
    tabId = tab.id;
    // A tab just opened has nothing to run in until it has loaded.
    if (created && spec.waitFor !== "load") await waitForLoad(platform, tabId, deadline);
  } else if (spec.tabId !== undefined) {
    tabId = spec.tabId;
    await allowedTab(platform, tabId, spec.sites);
  } else {
    throw new CommandError("other", "A run names a tab or a url.");
  }
  if (spec.waitFor !== undefined) await waitFirst(platform, tabId, spec.waitFor, deadline);
  // Right before acting: the tab may have navigated off the plugin's sites meanwhile.
  await allowedTab(platform, tabId, spec.sites);
  return { value: await execute(platform, tabId, spec.code, spec.world) };
}
