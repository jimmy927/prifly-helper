/** What the popup asks of the service worker, over `chrome.runtime.sendMessage`. */

export type PopupRequest =
  | { type: "refresh" }
  | { type: "pair"; code: string; profile: string }
  | { type: "retry" }
  | { type: "setPort"; port: number }
  | { type: "pause"; minutes: number }
  | { type: "resume" };

export type PopupReply = { ok: true } | { ok: false; error: string };
