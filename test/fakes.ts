/** A fake host socket, a fake `chrome.*`, a fake fetch and a clock the test moves by hand. */

import type {
  ChromeApi,
  Clock,
  InjectionResult,
  Platform,
  SessionRule,
  SocketLike,
  StorageArea,
  TabInfo,
} from "../src/platform";
import type { HelperInMsg } from "../src/protocol";

export class FakeClock implements Clock {
  time = 1_000_000;
  private timers: { at: number; fn: () => void; live: boolean }[] = [];

  now(): number {
    return this.time;
  }

  after(ms: number, fn: () => void): () => void {
    const timer = { at: this.time + ms, fn, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  }

  /** Move time on, running every timer that comes due, in order, letting promises settle between. */
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.live && timer.at <= end)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.time = Math.max(this.time, due.at);
      due.live = false;
      due.fn();
      await settle();
    }
    this.time = end;
    this.timers = this.timers.filter((timer) => timer.live);
    await settle();
  }

  pending(): number {
    return this.timers.filter((timer) => timer.live).length;
  }
}

/** Let every promise chain that can move, move. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  /** Frames the extension sent, parsed. */
  readonly sent: HelperInMsg[] = [];
  closedByClient = false;

  constructor(readonly url: string) {}

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("send on a socket that is not open");
    this.sent.push(JSON.parse(data) as HelperInMsg);
  }

  close(): void {
    this.closedByClient = true;
    this.readyState = 3;
  }

  // ---- what the host does

  accept(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  /** The connection never opens: nothing listens on the port. */
  refuse(): void {
    this.readyState = 3;
    this.onerror?.(new Event("error"));
    this.onclose?.(new CloseEvent("close", { code: 1006, reason: "" }));
  }

  drop(code = 1006, reason = ""): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close", { code, reason }));
  }

  receive(frame: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }

  /** The sent frames of one type. */
  of<T extends HelperInMsg["type"]>(type: T): Extract<HelperInMsg, { type: T }>[] {
    return this.sent.filter((frame) => frame.type === type) as Extract<HelperInMsg, { type: T }>[];
  }
}

export class FakeStorage implements StorageArea {
  data: Record<string, unknown> = {};

  async get(keys: string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const key of keys) if (key in this.data) out[key] = structuredClone(this.data[key]);
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.data[key] = structuredClone(value);
  }

  async remove(keys: string[]): Promise<void> {
    for (const key of keys) delete this.data[key];
  }
}

/** A 2x3 PNG's first bytes: signature, then IHDR with width 2 and height 3. */
export const TINY_PNG_BASE64 = btoa(
  String.fromCharCode(
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    0, 0, 0, 2, 0, 0, 0, 3,
    8, 6, 0, 0, 0,
  ),
);

export class FakeChrome implements ChromeApi {
  local = new FakeStorage();
  session = new FakeStorage();
  scriptsAllowed = true;
  tabs: TabInfo[] = [];
  nextTabId = 100;
  rules: SessionRule[] = [];
  cookieJar: Record<string, string> = {};
  executed: { tabId: number; code: string; world: string }[] = [];
  /** What `userScripts.execute` answers; the default runs nothing and answers 42. */
  onExecute: (injection: { tabId: number; code: string; world: string }) => Promise<InjectionResult[]> =
    async () => [{ result: 42 }];
  activated: number[] = [];

  extensionVersion(): string {
    return "0.1.0";
  }

  browser(): string {
    return "Chrome 141";
  }

  async os(): Promise<string> {
    return "Windows";
  }

  userScriptsAllowed(): boolean {
    return this.scriptsAllowed;
  }

  async userScriptsExecute(injection: {
    tabId: number;
    code: string;
    world: "USER_SCRIPT" | "MAIN";
  }): Promise<InjectionResult[]> {
    if (!this.scriptsAllowed) throw new Error("userScripts is not allowed");
    this.executed.push(injection);
    return this.onExecute(injection);
  }

  async tabsQuery(): Promise<TabInfo[]> {
    return this.tabs.map((tab) => ({ ...tab }));
  }

  async tabsGet(tabId: number): Promise<TabInfo> {
    const tab = this.tabs.find((each) => each.id === tabId);
    if (tab === undefined) throw new Error(`No tab with id: ${tabId}.`);
    return { ...tab };
  }

  async tabsCreate(props: { url: string; active: boolean }): Promise<TabInfo> {
    const tab: TabInfo = { id: this.nextTabId++, url: props.url, status: "complete", windowId: 1, active: props.active };
    this.tabs.push(tab);
    return { ...tab };
  }

  async tabsActivate(tabId: number): Promise<void> {
    const tab = this.tabs.find((each) => each.id === tabId);
    if (tab === undefined) throw new Error(`No tab with id: ${tabId}.`);
    for (const other of this.tabs) if (other.windowId === tab.windowId) other.active = false;
    tab.active = true;
    this.activated.push(tabId);
  }

  async captureVisibleTab(windowId: number): Promise<string> {
    if (!this.tabs.some((tab) => tab.windowId === windowId && tab.active)) throw new Error("no visible tab");
    return `data:image/png;base64,${TINY_PNG_BASE64}`;
  }

  async sessionRules(): Promise<{ id: number }[]> {
    return this.rules.map((rule) => ({ id: rule.id }));
  }

  async updateSessionRules(change: { addRules?: SessionRule[]; removeRuleIds?: number[] }): Promise<void> {
    const remove = new Set(change.removeRuleIds ?? []);
    this.rules = this.rules.filter((rule) => !remove.has(rule.id));
    this.rules.push(...(change.addRules ?? []));
  }

  async cookies(_url: string, name: string): Promise<{ name: string; value: string }[]> {
    const value = this.cookieJar[name];
    return value === undefined ? [] : [{ name, value }];
  }
}

export type FetchCall = { url: string; init: RequestInit; rulesAtFetch: SessionRule[] };

export function fakePlatform() {
  const clock = new FakeClock();
  const chrome = new FakeChrome();
  const sockets: FakeSocket[] = [];
  const fetches: FetchCall[] = [];
  let answer: (url: string, init: RequestInit) => Promise<Response> = async () =>
    new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  const platform: Platform = {
    chrome,
    clock,
    openSocket(url) {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    fetch(url, init) {
      fetches.push({ url, init, rulesAtFetch: structuredClone(chrome.rules) });
      return answer(url, init);
    },
  };
  return {
    platform,
    clock,
    chrome,
    sockets,
    fetches,
    /** The socket the client opened last. */
    socket(): FakeSocket {
      const last = sockets.at(-1);
      if (last === undefined) throw new Error("no socket opened");
      return last;
    },
    answerFetch(fn: (url: string, init: RequestInit) => Promise<Response>) {
      answer = fn;
    },
  };
}
