/**
 * What the popup shows. The service worker writes a `View` to
 * `chrome.storage.session` on every change; the popup words it with
 * `shownFor`, which is pure so the tests can check each state's sentence.
 */

import type { HelperRefusal } from "./protocol";

export type Connection = "connecting" | "open" | "unreachable";

export type View = {
  connection: Connection;
  /** A token is stored: this browser was paired. */
  paired: boolean;
  /** The host accepted the token on this connection: commands can flow. */
  welcomed: boolean;
  /** The host's name for this browser, "Chrome 141 (Work)". */
  name: string;
  userScripts: boolean;
  pausedUntil: number | null;
  /** A code was sent and its answer has not come. */
  pairing: boolean;
  refusal: HelperRefusal | null;
  /** The last thing that went wrong, one line; "" when none. */
  error: string;
  port: number;
  profile: string;
};

export const VIEW_KEY = "view";

export type Tone = "good" | "warning" | "muted" | "bad";

export type ShownKind =
  | "connecting"
  | "connected"
  | "unreachable"
  | "paired-host-down"
  | "checking"
  | "needs-pairing"
  | "pairing-rejected";

export type Shown = {
  kind: ShownKind;
  title: string;
  detail: string;
  tone: Tone;
  /** The code field and Pair button. */
  pairForm: boolean;
  retry: boolean;
  pause: boolean;
};

/** How the Details page names the toggle, for the user-scripts notice. */
export const USER_SCRIPTS_NOTICE =
  "Allow User Scripts is off. The Helper can still fetch, but cannot run an extension's code in a tab. Turn on Allow User Scripts on the Helper's Details page (in Chrome before 138: turn on Developer mode on the extensions page).";

const SETTINGS = "prifly → Settings → Browser Helper";

/** The error a socket that never opened leaves: the status line already says it. */
export const HOST_DOWN = "prifly did not answer.";

/** The popup's error line: the view's error, unless the status above already says it. */
export function errorLine(view: View, shown: Shown): string {
  if (shown.kind === "pairing-rejected") return "";
  if (shown.kind === "connected" || shown.kind === "checking") return "";
  if (view.error === HOST_DOWN) return "";
  return view.error;
}

export function shownFor(view: View): Shown {
  const base = { pairForm: false, retry: false, pause: false };
  if (view.connection === "connecting") {
    return {
      ...base,
      kind: "connecting",
      title: "Connecting to prifly…",
      detail: `Looking for prifly on 127.0.0.1:${view.port}.`,
      tone: "muted",
    };
  }
  if (view.connection === "unreachable") {
    return view.paired
      ? {
          ...base,
          kind: "paired-host-down",
          title: "Paired, but prifly is not running",
          detail: `Nothing answers on 127.0.0.1:${view.port}. Commands resume once prifly runs; the Helper keeps trying.`,
          tone: "muted",
          retry: true,
        }
      : {
          ...base,
          kind: "unreachable",
          title: "prifly is not running",
          detail: `Nothing answers on 127.0.0.1:${view.port}. Start prifly, then pair from ${SETTINGS}.`,
          tone: "bad",
          retry: true,
        };
  }
  if (view.welcomed) {
    const paused = view.pausedUntil !== null;
    return {
      ...base,
      kind: "connected",
      title: paused ? "Connected to prifly, paused" : "Connected to prifly",
      detail: paused
        ? `As ${view.name}. Paused: prifly sends no commands until ${new Date(view.pausedUntil ?? 0).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`
        : `As ${view.name}.`,
      tone: paused ? "warning" : "good",
      pause: true,
    };
  }
  if (view.paired) {
    return {
      ...base,
      kind: "checking",
      title: "Checking the pairing…",
      detail: "prifly is answering; waiting for it to accept this browser.",
      tone: "muted",
    };
  }
  if (view.refusal !== null && view.refusal !== "protocol") {
    return {
      ...base,
      kind: "pairing-rejected",
      title: view.refusal === "revoked" ? "Unpaired from prifly" : "Pairing rejected",
      detail: view.error,
      tone: "bad",
      pairForm: true,
    };
  }
  return {
    ...base,
    kind: "needs-pairing",
    title: "Not paired yet",
    detail: `Type the code from ${SETTINGS}.`,
    tone: "warning",
    pairForm: true,
  };
}
