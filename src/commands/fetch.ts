/**
 * `fetch`: a request with the browser's own cookies. The extension holds host
 * permission for every site, so the request counts as same-site and even
 * `SameSite=Strict` cookies go with it.
 *
 * Origin and Referer cannot be set on a `fetch`; they are set by a
 * declarativeNetRequest session rule scoped to this one URL and to requests
 * outside any tab (the extension's own), removed again when the answer is in.
 * Named cookie values come back on request; the jar itself never leaves.
 */

import type { Platform, SessionRule } from "../platform";
import type { HelperFetchSpec, HelperFetchValue } from "../protocol";
import { CommandError, type Deadline, messageOf } from "./common";

/** Headers `fetch` drops silently, which the session rule sets instead. */
const RULE_HEADERS = new Set(["origin", "referer"]);

let nextRuleId = 1;

/** Session rule ids; `background.ts` clears every session rule when the worker starts. */
export function takeRuleId(): number {
  const id = nextRuleId;
  nextRuleId = nextRuleId >= 1_000_000 ? 1 : nextRuleId + 1;
  return id;
}

/**
 * A urlFilter matching exactly `url`. `*`, `^` and `|` are the filter's own
 * syntax: a URL holding one is matched by its prefix up to there instead.
 */
export function urlFilterFor(url: string): string {
  const special = url.search(/[*^|]/);
  return special === -1 ? `|${url}|` : `|${url.slice(0, special)}`;
}

/** A body is text when its type says so; anything else comes back as base64. */
export function isTextual(contentType: string | null): boolean {
  if (contentType === null || contentType === "") return true;
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    type.startsWith("text/") ||
    type.endsWith("+json") ||
    type.endsWith("+xml") ||
    [
      "application/json",
      "application/javascript",
      "application/xml",
      "application/x-www-form-urlencoded",
      "application/graphql",
    ].includes(type)
  );
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let at = 0; at < bytes.length; at += chunk) {
    binary += String.fromCharCode(...bytes.subarray(at, at + chunk));
  }
  return btoa(binary);
}

function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function requestUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CommandError("other", `Not a URL: ${raw}`);
  }
  // A fragment never reaches the network, and would keep the rule from matching.
  url.hash = "";
  return url.href;
}

export async function runFetch(
  platform: Platform,
  spec: HelperFetchSpec,
  deadline: Deadline,
): Promise<HelperFetchValue> {
  const url = requestUrl(spec.url);
  const headers: Record<string, string> = {};
  const ruled = new Map<string, string>();
  for (const [name, value] of Object.entries(spec.headers ?? {})) {
    if (RULE_HEADERS.has(name.toLowerCase())) ruled.set(name.toLowerCase(), value);
    else headers[name] = value;
  }
  if (spec.origin !== undefined) ruled.set("origin", spec.origin);
  if (spec.referer !== undefined) ruled.set("referer", spec.referer);

  let ruleId: number | null = null;
  if (ruled.size > 0) {
    ruleId = takeRuleId();
    const rule: SessionRule = {
      id: ruleId,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [...ruled].map(([header, value]) => ({ header, operation: "set", value })),
      },
      condition: { urlFilter: urlFilterFor(url), tabIds: [-1], resourceTypes: ["xmlhttprequest"] },
    };
    try {
      await platform.chrome.updateSessionRules({ removeRuleIds: [ruleId], addRules: [rule] });
    } catch (error) {
      throw new CommandError("other", `Could not set the request's headers: ${messageOf(error)}`);
    }
  }

  const abort = new AbortController();
  const cancelTimer = platform.clock.after(Math.max(0, deadline - platform.clock.now()), () =>
    abort.abort(),
  );
  try {
    let response: Response;
    try {
      response = await platform.fetch(url, {
        method: spec.method,
        headers,
        body: spec.bodyBase64 !== undefined ? bytesOf(spec.bodyBase64) : spec.body,
        credentials: spec.credentials,
        redirect: spec.redirect,
        signal: abort.signal,
      });
    } catch (error) {
      if (abort.signal.aborted) throw new CommandError("timeout", `${url} did not answer in time.`);
      throw new CommandError("network", `${url}: ${messageOf(error)}`);
    }
    const value: HelperFetchValue = {
      status: response.status,
      statusText: response.statusText,
      // An opaque redirect (redirect: "manual") has no URL of its own.
      url: response.url || url,
      headers: Object.fromEntries(response.headers.entries()),
    };
    try {
      if (isTextual(response.headers.get("content-type"))) value.body = await response.text();
      else value.bodyBase64 = base64Of(new Uint8Array(await response.arrayBuffer()));
    } catch (error) {
      if (abort.signal.aborted) throw new CommandError("timeout", `${url} did not finish in time.`);
      throw new CommandError("network", `Reading ${url}: ${messageOf(error)}`);
    }
    if (spec.cookies !== undefined && spec.cookies.length > 0) {
      const cookies: Record<string, string> = {};
      for (const name of spec.cookies) {
        const [found] = await platform.chrome.cookies(url, name);
        if (found !== undefined) cookies[name] = found.value;
      }
      value.cookies = cookies;
    }
    return value;
  } finally {
    cancelTimer();
    if (ruleId !== null) {
      const id = ruleId;
      await platform.chrome.updateSessionRules({ removeRuleIds: [id] }).catch((error: unknown) => {
        // Left over, it only ever matches this one URL; the next worker start clears it.
        console.warn("prifly Helper: could not remove session rule", id, messageOf(error));
      });
    }
  }
}
