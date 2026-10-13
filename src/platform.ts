/**
 * Everything the Helper touches outside its own code: the few `chrome.*` calls
 * it makes, the WebSocket, `fetch` and the clock. `background.ts` wires the
 * real ones; the tests hand in fakes, so the protocol runs without a browser.
 */

export type StorageArea = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
};

export type TabInfo = {
  id: number;
  url: string;
  /** "loading" or "complete". */
  status: string;
  windowId: number;
  active: boolean;
};

export type InjectionResult = { result?: unknown; error?: string };

export type SessionRule = {
  id: number;
  priority: number;
  action: {
    type: "modifyHeaders";
    requestHeaders: { header: string; operation: "set"; value: string }[];
  };
  condition: {
    urlFilter: string;
    tabIds: number[];
    resourceTypes: "xmlhttprequest"[];
  };
};

export type ChromeApi = {
  local: StorageArea;
  /** Lives while the browser runs; the popup reads the view from here. */
  session: StorageArea;
  extensionVersion(): string;
  /** "Chrome 141", "Edge 141". */
  browser(): string;
  /** "Windows", "macOS", "Linux", "ChromeOS". */
  os(): Promise<string>;
  /** The documented test: `chrome.userScripts.getScripts()` throws while user scripts are not allowed. */
  userScriptsAllowed(): boolean;
  userScriptsExecute(injection: {
    tabId: number;
    code: string;
    world: "USER_SCRIPT" | "MAIN";
  }): Promise<InjectionResult[]>;
  tabsQuery(): Promise<TabInfo[]>;
  /** Rejects when the tab is gone. */
  tabsGet(tabId: number): Promise<TabInfo>;
  tabsCreate(props: { url: string; active: boolean }): Promise<TabInfo>;
  tabsActivate(tabId: number): Promise<void>;
  /** A PNG data URL of the window's visible tab. */
  captureVisibleTab(windowId: number): Promise<string>;
  sessionRules(): Promise<{ id: number }[]>;
  updateSessionRules(change: { addRules?: SessionRule[]; removeRuleIds?: number[] }): Promise<void>;
  cookies(url: string, name: string): Promise<{ name: string; value: string }[]>;
};

/** The subset of a WebSocket the client uses. */
export type SocketLike = {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export const SOCKET_OPEN = 1;

export type Clock = {
  now(): number;
  /** Run `fn` after `ms`; the answer cancels it. */
  after(ms: number, fn: () => void): () => void;
};

export const realClock: Clock = {
  now: () => Date.now(),
  after(ms, fn) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

export type Platform = {
  chrome: ChromeApi;
  openSocket(url: string): SocketLike;
  fetch(url: string, init: RequestInit): Promise<Response>;
  clock: Clock;
};

export function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => clock.after(ms, resolve));
}
