/**
 * `screenshot`: a PNG of a tab through `captureVisibleTab`, which sees only
 * the active tab of a window. A background tab is brought to the front
 * briefly when `activate` is on (the reader sees it), and the tab that was
 * active is put back afterwards. `chrome.debugger` is not used: it shows a bar.
 */

import { type Platform, sleep, type TabInfo } from "../platform";
import type { HelperScreenshotSpec, HelperScreenshotValue } from "../protocol";
import { allowedTab, CommandError, type Deadline, findOrOpenTab, messageOf, waitForLoad } from "./common";

/** Time for the browser to paint a tab it just brought to the front. */
const PAINT_MS = 150;

/** Width and height from a PNG's IHDR chunk (bytes 16 to 24). */
export function pngSize(base64: string): { width: number; height: number } {
  const bytes = Uint8Array.from(atob(base64.slice(0, 64)), (char) => char.charCodeAt(0));
  if (bytes.length < 24) throw new CommandError("other", "The capture is not a PNG.");
  const view = new DataView(bytes.buffer);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export async function runScreenshot(
  platform: Platform,
  spec: HelperScreenshotSpec,
  deadline: Deadline,
): Promise<HelperScreenshotValue> {
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
    if (created) await waitForLoad(platform, tabId, deadline);
  } else if (spec.tabId !== undefined) {
    tabId = spec.tabId;
  } else {
    throw new CommandError("other", "A screenshot names a tab or a url.");
  }
  let tab = await allowedTab(platform, tabId, spec.sites);
  let previous: TabInfo | undefined;
  if (!tab.active) {
    if (!spec.activate) {
      throw new CommandError("tab", `Tab ${tabId} is not the visible tab of its window.`);
    }
    previous = (await platform.chrome.tabsQuery()).find(
      (other) => other.windowId === tab.windowId && other.active,
    );
    await platform.chrome.tabsActivate(tabId);
    await sleep(platform.clock, PAINT_MS);
    tab = await allowedTab(platform, tabId, spec.sites);
  }
  let dataUrl: string;
  try {
    dataUrl = await platform.chrome.captureVisibleTab(tab.windowId);
  } catch (error) {
    throw new CommandError("tab", `Could not capture tab ${tabId}: ${messageOf(error)}`);
  } finally {
    if (previous !== undefined && previous.id !== tabId) {
      // Putting the reader's tab back is a courtesy: a tab closed meanwhile does not fail the capture.
      await platform.chrome.tabsActivate(previous.id).catch((error: unknown) => {
        console.warn("prifly Helper: could not re-activate tab", previous?.id, messageOf(error));
      });
    }
  }
  const pngBase64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return { pngBase64, ...pngSize(pngBase64) };
}
