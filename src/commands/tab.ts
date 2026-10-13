/** `tab`: find an open tab whose URL matches, or open one (in the background unless asked). */

import type { Platform } from "../platform";
import type { HelperTabSpec, HelperTabValue } from "../protocol";
import { findOrOpenTab } from "./common";

export async function runTab(platform: Platform, spec: HelperTabSpec): Promise<HelperTabValue> {
  const { tab, created } = await findOrOpenTab(platform, spec);
  return { tabId: tab.id, url: tab.url, created };
}
