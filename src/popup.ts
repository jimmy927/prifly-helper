/**
 * The toolbar popup: where the reader types the pairing code from prifly's
 * Settings → Browser Helper, and sees whether the Helper is connected. It
 * draws the service worker's `View` from `chrome.storage.session` and redraws
 * on every change; its buttons are requests to the worker.
 */

import type { PopupReply, PopupRequest } from "./messages";
import { errorLine, shownFor, USER_SCRIPTS_NOTICE, VIEW_KEY, type View } from "./view";

const PAUSE_MINUTES = 60;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`popup.html has no #${id}`);
  return found as T;
}

const ui = {
  status: element<HTMLElement>("status"),
  title: element<HTMLElement>("status-title"),
  detail: element<HTMLElement>("status-detail"),
  scriptsOff: element<HTMLElement>("scripts-off"),
  scriptsOffText: element<HTMLElement>("scripts-off-text"),
  openDetails: element<HTMLButtonElement>("open-details"),
  pairForm: element<HTMLFormElement>("pair-form"),
  code: element<HTMLInputElement>("code"),
  profile: element<HTMLInputElement>("profile"),
  pair: element<HTMLButtonElement>("pair"),
  retry: element<HTMLButtonElement>("retry"),
  pause: element<HTMLButtonElement>("pause"),
  resume: element<HTMLButtonElement>("resume"),
  error: element<HTMLElement>("error"),
  portForm: element<HTMLFormElement>("port-form"),
  port: element<HTMLInputElement>("port"),
};

/** An error of the popup's own (a request the worker refused); cleared by the next one that works. */
let ownError = "";
let last: View | null = null;
let profileTouched = false;

function draw(view: View | null): void {
  last = view;
  if (view === null) {
    ui.status.dataset.tone = "muted";
    ui.title.textContent = "Starting the Helper…";
    ui.detail.textContent = "";
    for (const hidden of [ui.scriptsOff, ui.pairForm, ui.retry, ui.pause, ui.resume]) hidden.hidden = true;
    showError(ownError);
    return;
  }
  const shown = shownFor(view);
  ui.status.dataset.tone = shown.tone;
  ui.status.dataset.kind = shown.kind;
  ui.title.textContent = shown.title;
  ui.detail.textContent = shown.detail;

  ui.scriptsOff.hidden = view.userScripts;
  ui.scriptsOffText.textContent = USER_SCRIPTS_NOTICE;

  ui.pairForm.hidden = !shown.pairForm;
  ui.pair.disabled = view.pairing;
  ui.pair.textContent = view.pairing ? "Pairing…" : "Pair";
  if (!profileTouched && document.activeElement !== ui.profile) ui.profile.value = view.profile;

  ui.retry.hidden = !shown.retry;
  ui.pause.hidden = !shown.pause || view.pausedUntil !== null;
  ui.resume.hidden = !shown.pause || view.pausedUntil === null;

  if (document.activeElement !== ui.port) ui.port.value = String(view.port);
  showError(ownError !== "" ? ownError : errorLine(view, shown));
}

function showError(text: string): void {
  ui.error.hidden = text === "";
  ui.error.textContent = text;
}

async function ask(request: PopupRequest): Promise<void> {
  let reply: PopupReply | undefined;
  try {
    reply = (await chrome.runtime.sendMessage(request)) as PopupReply | undefined;
  } catch (error) {
    reply = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  ownError = reply === undefined ? "The Helper's worker did not answer." : reply.ok ? "" : reply.error;
  draw(last);
}

ui.pairForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void ask({ type: "pair", code: ui.code.value, profile: ui.profile.value });
});
ui.profile.addEventListener("input", () => {
  profileTouched = true;
});
ui.retry.addEventListener("click", () => void ask({ type: "retry" }));
ui.pause.addEventListener("click", () => void ask({ type: "pause", minutes: PAUSE_MINUTES }));
ui.resume.addEventListener("click", () => void ask({ type: "resume" }));
ui.openDetails.addEventListener("click", () => {
  void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});
ui.portForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const port = Number(ui.port.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    ownError = "A port is a whole number from 1 to 65535.";
    draw(last);
    return;
  }
  void ask({ type: "setPort", port });
});

chrome.storage.session.onChanged.addListener((changes) => {
  const change = changes[VIEW_KEY];
  if (change !== undefined) draw((change.newValue as View | undefined) ?? null);
});

void (async () => {
  const stored = (await chrome.storage.session.get(VIEW_KEY))[VIEW_KEY] as View | undefined;
  draw(stored ?? null);
  // Wakes the worker, reconnects if it was down and re-checks Allow User Scripts.
  await ask({ type: "refresh" });
})();
