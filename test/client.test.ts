import { describe, expect, test } from "bun:test";
import { FIRST_RETRY_MS, HelperClient, MAX_RETRY_MS } from "../src/client";
import type { HelperResult } from "../src/protocol";
import { HELPER_PROTOCOL } from "../src/protocol";
import { shownFor, VIEW_KEY, type View } from "../src/view";
import { fakePlatform, settle, TINY_PNG_BASE64 } from "./fakes";

const SITES = ["https://www.linkedin.com/*"];
const PAIRING = { deviceId: "dev-1", token: "tok-1" };

/** A client started against fakes, its first socket opened by the host. */
async function started(options: { paired?: boolean; outbox?: Record<string, unknown> } = {}) {
  const fake = fakePlatform();
  if (options.paired) fake.chrome.local.data.pairing = PAIRING;
  if (options.outbox) fake.chrome.local.data.outbox = options.outbox;
  const client = new HelperClient(fake.platform);
  await client.start();
  fake.socket().accept();
  await settle();
  return { ...fake, client };
}

/** A client the host welcomed: commands flow. */
async function welcomed(options: { outbox?: Record<string, unknown> } = {}) {
  const ctx = await started({ paired: true, ...options });
  ctx.socket().receive({ type: "welcome", deviceId: PAIRING.deviceId, name: "Chrome 141" });
  await settle();
  return ctx;
}

function view(ctx: { chrome: { session: { data: Record<string, unknown> } } }): View {
  return ctx.chrome.session.data[VIEW_KEY] as View;
}

function lastResult(ctx: Awaited<ReturnType<typeof welcomed>>): HelperResult {
  const result = ctx.socket().of("result").at(-1);
  if (result === undefined) throw new Error("no result sent");
  return result;
}

async function command(ctx: Awaited<ReturnType<typeof welcomed>>, frame: Record<string, unknown>) {
  ctx.socket().receive({ type: "command", timeoutMs: 5_000, ...frame });
  await settle();
}

describe("connecting and pairing", () => {
  test("an unpaired Helper says hello with no token, to /helper on 4201", async () => {
    const ctx = await started();
    expect(ctx.socket().url).toBe("ws://127.0.0.1:4201/helper");
    const [hello] = ctx.socket().of("hello");
    expect(hello).toEqual({
      type: "hello",
      protocol: HELPER_PROTOCOL,
      deviceId: null,
      token: null,
      browser: "Chrome 141",
      os: "Windows",
      profile: "",
      extensionVersion: "0.1.0",
      userScripts: true,
    });
    ctx.socket().receive({ type: "unpaired" });
    await settle();
    expect(shownFor(view(ctx)).kind).toBe("needs-pairing");
  });

  test("the code goes out after the hello; paired stores the token, welcome connects", async () => {
    const ctx = await started();
    await ctx.client.pair(" k7f-29qx ", "Work");
    expect(ctx.socket().sent.map((frame) => frame.type)).toEqual(["hello", "hello", "pair"]);
    expect(ctx.socket().of("pair")[0]).toEqual({ type: "pair", code: "k7f-29qx" });
    expect(ctx.socket().of("hello")[1]?.profile).toBe("Work");
    expect(view(ctx).pairing).toBe(true);

    ctx.socket().receive({ type: "paired", deviceId: "dev-9", token: "secret" });
    ctx.socket().receive({ type: "welcome", deviceId: "dev-9", name: "Chrome 141 (Work)" });
    await settle();
    expect(ctx.chrome.local.data.pairing).toEqual({ deviceId: "dev-9", token: "secret" });
    expect(shownFor(view(ctx))).toMatchObject({ kind: "connected", detail: "As Chrome 141 (Work)." });

    // The next connection carries the token.
    ctx.socket().drop();
    await ctx.clock.advance(FIRST_RETRY_MS);
    ctx.socket().accept();
    await settle();
    expect(ctx.socket().of("hello")[0]).toMatchObject({ deviceId: "dev-9", token: "secret" });
  });

  test("a code typed while prifly is down is sent once the socket opens", async () => {
    const fake = fakePlatform();
    const client = new HelperClient(fake.platform);
    await client.start();
    await client.pair("ABC2345", "");
    expect(fake.sockets).toHaveLength(2);
    fake.socket().accept();
    await settle();
    expect(fake.socket().sent.map((frame) => frame.type)).toEqual(["hello", "pair"]);
  });

  test("a rejected code shows the host's reason and keeps the code field", async () => {
    const ctx = await started();
    await ctx.client.pair("WRONG12", "");
    ctx.socket().receive({ type: "refused", reason: "bad-code", message: "That code is not right." });
    await settle();
    expect(ctx.chrome.local.data.pairing).toBeUndefined();
    expect(shownFor(view(ctx))).toMatchObject({
      kind: "pairing-rejected",
      title: "Pairing rejected",
      detail: "That code is not right.",
      pairForm: true,
    });
    expect(view(ctx).pairing).toBe(false);
  });

  test("an empty code is not sent", async () => {
    const ctx = await started();
    await ctx.client.pair("   ", "");
    expect(ctx.socket().of("pair")).toHaveLength(0);
    expect(view(ctx).error).toBe("Type the code from prifly first.");
  });

  test("a revoked token is forgotten and the popup asks to pair again", async () => {
    const ctx = await started({ paired: true });
    expect(ctx.socket().of("hello")[0]).toMatchObject({ deviceId: "dev-1", token: "tok-1" });
    expect(shownFor(view(ctx)).kind).toBe("checking");
    ctx.socket().receive({
      type: "refused",
      reason: "revoked",
      message: "This browser was unpaired from prifly: pair it again.",
    });
    await settle();
    expect(ctx.chrome.local.data.pairing).toBeUndefined();
    expect(shownFor(view(ctx))).toMatchObject({ kind: "pairing-rejected", title: "Unpaired from prifly" });
  });

  test("a ping is answered with a pong", async () => {
    const ctx = await welcomed();
    ctx.socket().receive({ type: "ping", at: 5 });
    await settle();
    expect(ctx.socket().of("pong")).toEqual([{ type: "pong", at: ctx.clock.now() }]);
  });

  test("a frame type this build does not know is ignored", async () => {
    const ctx = await welcomed();
    const before = ctx.socket().sent.length;
    ctx.socket().receive({ type: "somethingNew", x: 1 });
    ctx.socket().receive("not an object");
    await settle();
    expect(ctx.socket().sent.length).toBe(before);
    expect(view(ctx).welcomed).toBe(true);
  });
});

describe("reconnecting", () => {
  test("prifly down: unreachable, then retries with doubling backoff up to the cap", async () => {
    const fake = fakePlatform();
    const client = new HelperClient(fake.platform);
    await client.start();
    expect(shownFor(fake.chrome.session.data[VIEW_KEY] as View).kind).toBe("connecting");
    fake.socket().refuse();
    await settle();
    expect(shownFor(fake.chrome.session.data[VIEW_KEY] as View)).toMatchObject({
      kind: "unreachable",
      retry: true,
    });

    // On the fake clock: no new socket 1 ms before each expected wait, one exactly at it.
    for (const wait of [1000, 2000, 4000, 8000, 16000, MAX_RETRY_MS, MAX_RETRY_MS]) {
      const before = fake.sockets.length;
      await fake.clock.advance(wait - 1);
      expect(fake.sockets.length).toBe(before);
      await fake.clock.advance(1);
      expect(fake.sockets.length).toBe(before + 1);
      fake.socket().refuse();
      await settle();
    }

    // Once it opens, the backoff starts over.
    await fake.clock.advance(MAX_RETRY_MS);
    fake.socket().accept();
    await settle();
    fake.socket().drop();
    await settle();
    const before = fake.sockets.length;
    await fake.clock.advance(FIRST_RETRY_MS);
    expect(fake.sockets.length).toBe(before + 1);
  });

  test("paired but prifly down reads as paired-host-down", async () => {
    const fake = fakePlatform();
    fake.chrome.local.data.pairing = PAIRING;
    const client = new HelperClient(fake.platform);
    await client.start();
    fake.socket().refuse();
    await settle();
    expect(shownFor(fake.chrome.session.data[VIEW_KEY] as View).kind).toBe("paired-host-down");
  });

  test("the alarm's tick reconnects a woken worker at once, and Retry skips the wait", async () => {
    const fake = fakePlatform();
    const client = new HelperClient(fake.platform);
    await client.start();
    fake.socket().refuse();
    await settle();
    await client.retry();
    expect(fake.sockets).toHaveLength(2);
    fake.socket().accept();
    await settle();
    fake.socket().drop();
    await settle();
    // Chrome suspended the worker before its retry timer fired; the alarm wakes it and connects.
    await client.tick();
    expect(fake.sockets).toHaveLength(3);
    // An open socket is left alone by the next tick.
    fake.socket().accept();
    await settle();
    await client.tick();
    expect(fake.sockets).toHaveLength(3);
  });

  test("a close of a socket already replaced changes nothing", async () => {
    const ctx = await welcomed();
    const old = ctx.socket();
    await ctx.client.setPort(4300);
    expect(old.closedByClient).toBe(true);
    expect(ctx.socket().url).toBe("ws://127.0.0.1:4300/helper");
    old.drop();
    await settle();
    expect(view(ctx).connection).toBe("connecting");
    expect(ctx.clock.pending()).toBe(0);
  });
});

describe("user scripts", () => {
  test("a paired Helper reports the toggle with a status frame", async () => {
    const ctx = await welcomed();
    ctx.chrome.scriptsAllowed = false;
    await ctx.client.tick();
    expect(ctx.socket().of("status")).toEqual([{ type: "status", userScripts: false, paused: false }]);
    expect(view(ctx).userScripts).toBe(false);
  });

  test("an unpaired Helper reports it in a fresh hello", async () => {
    const ctx = await started();
    ctx.chrome.scriptsAllowed = false;
    await ctx.client.tick();
    expect(ctx.socket().of("hello").map((hello) => hello.userScripts)).toEqual([true, false]);
  });
});

describe("commands", () => {
  test("fetch: the browser's cookies, Referer through a one-request rule, named cookie values", async () => {
    const ctx = await welcomed();
    ctx.chrome.cookieJar.JSESSIONID = "ajax:123";
    ctx.answerFetch(async () =>
      new Response('{"ok":true}', {
        status: 201,
        statusText: "Created",
        headers: { "content-type": "application/json" },
      }),
    );
    await command(ctx, {
      id: "c1",
      kind: "fetch",
      spec: {
        url: "https://www.linkedin.com/voyager/api/me#frag",
        method: "GET",
        headers: { "csrf-token": "ajax:123", Origin: "https://www.linkedin.com" },
        credentials: "include",
        redirect: "follow",
        referer: "https://www.linkedin.com/feed/",
        cookies: ["JSESSIONID", "missing"],
      },
    });
    const [call] = ctx.fetches;
    expect(call?.url).toBe("https://www.linkedin.com/voyager/api/me");
    expect(call?.init).toMatchObject({ method: "GET", credentials: "include", headers: { "csrf-token": "ajax:123" } });
    expect(call?.rulesAtFetch).toHaveLength(1);
    expect(call?.rulesAtFetch[0]).toMatchObject({
      action: {
        requestHeaders: [
          { header: "origin", operation: "set", value: "https://www.linkedin.com" },
          { header: "referer", operation: "set", value: "https://www.linkedin.com/feed/" },
        ],
      },
      condition: { urlFilter: "|https://www.linkedin.com/voyager/api/me|", tabIds: [-1] },
    });
    expect(ctx.chrome.rules).toHaveLength(0);
    expect(lastResult(ctx)).toEqual({
      type: "result",
      commandId: "c1",
      ok: true,
      value: {
        status: 201,
        statusText: "Created",
        url: "https://www.linkedin.com/voyager/api/me",
        headers: { "content-type": "application/json" },
        body: '{"ok":true}',
        cookies: { JSESSIONID: "ajax:123" },
      },
    });
  });

  test("fetch: a binary body comes back as base64", async () => {
    const ctx = await welcomed();
    ctx.answerFetch(async () =>
      new Response(new Uint8Array([0, 255, 1]), { headers: { "content-type": "image/png" } }),
    );
    await command(ctx, { id: "c2", kind: "fetch", spec: { url: "https://x.example/a.png", method: "GET", credentials: "include", redirect: "follow" } });
    const result = lastResult(ctx);
    expect(result.ok).toBe(true);
    expect((result.value as { bodyBase64: string }).bodyBase64).toBe(btoa("\u0000ÿ\u0001"));
  });

  test("fetch: a network failure is a network error, and the rule is removed", async () => {
    const ctx = await welcomed();
    ctx.answerFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    await command(ctx, {
      id: "c3",
      kind: "fetch",
      spec: { url: "https://down.example/", method: "GET", credentials: "include", redirect: "follow", referer: "https://down.example/" },
    });
    expect(lastResult(ctx)).toEqual({
      type: "result",
      commandId: "c3",
      ok: false,
      error: { kind: "network", message: "https://down.example/: Failed to fetch" },
    });
    expect(ctx.chrome.rules).toHaveLength(0);
  });

  test("fetch: no answer within timeoutMs is a timeout", async () => {
    const ctx = await welcomed();
    ctx.answerFetch(
      (_url, init) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    await command(ctx, { id: "c4", kind: "fetch", timeoutMs: 1_000, spec: { url: "https://slow.example/", method: "GET", credentials: "include", redirect: "follow" } });
    expect(ctx.socket().of("result")).toHaveLength(0);
    await ctx.clock.advance(1_000);
    expect(lastResult(ctx)).toMatchObject({ commandId: "c4", ok: false, error: { kind: "timeout" } });
  });

  test("tab: an open tab of the same origin is reused, else one is opened in the background", async () => {
    const ctx = await welcomed();
    ctx.chrome.tabs.push({ id: 7, url: "https://www.linkedin.com/feed/", status: "complete", windowId: 1, active: false });
    await command(ctx, { id: "t1", kind: "tab", spec: { url: "https://www.linkedin.com/messaging/", match: "origin", active: false, reuse: true, sites: SITES } });
    expect(lastResult(ctx)).toEqual({
      type: "result",
      commandId: "t1",
      ok: true,
      value: { tabId: 7, url: "https://www.linkedin.com/feed/", created: false },
    });
    await command(ctx, { id: "t2", kind: "tab", spec: { url: "https://www.linkedin.com/messaging/", match: "prefix", active: false, reuse: true, sites: SITES } });
    expect(lastResult(ctx)).toMatchObject({ ok: true, value: { tabId: 100, created: true } });
    expect(ctx.chrome.tabs.at(-1)).toMatchObject({ url: "https://www.linkedin.com/messaging/", active: false });
  });

  test("tab: a URL outside the plugin's sites is refused", async () => {
    const ctx = await welcomed();
    await command(ctx, { id: "t3", kind: "tab", spec: { url: "https://evil.example/", match: "origin", active: false, reuse: true, sites: SITES } });
    expect(lastResult(ctx)).toMatchObject({ commandId: "t3", ok: false, error: { kind: "refused" } });
    expect(ctx.chrome.tabs).toHaveLength(0);
  });

  test("run: the code runs in the tab through userScripts.execute and its value comes back", async () => {
    const ctx = await welcomed();
    ctx.chrome.tabs.push({ id: 7, url: "https://www.linkedin.com/feed/", status: "complete", windowId: 1, active: false });
    ctx.chrome.onExecute = async () => [{ result: { name: "Jimmy" } }];
    await command(ctx, { id: "r1", kind: "run", spec: { tabId: 7, code: "({name: 'Jimmy'})", world: "MAIN", sites: SITES } });
    expect(ctx.chrome.executed).toEqual([{ tabId: 7, code: "({name: 'Jimmy'})", world: "MAIN" }]);
    expect(lastResult(ctx)).toEqual({ type: "result", commandId: "r1", ok: true, value: { value: { name: "Jimmy" } } });
  });

  test("run: by URL, waiting for a selector first", async () => {
    const ctx = await welcomed();
    ctx.chrome.onExecute = async ({ code }) => [{ result: code.startsWith("new Promise") ? true : "done" }];
    await command(ctx, {
      id: "r2",
      kind: "run",
      spec: { url: "https://www.linkedin.com/feed/", code: "'done'", world: "USER_SCRIPT", waitFor: { selector: "main" }, sites: SITES },
    });
    expect(ctx.chrome.executed).toHaveLength(2);
    expect(ctx.chrome.executed[0]?.code).toContain('document.querySelector("main")');
    expect(lastResult(ctx)).toMatchObject({ ok: true, value: { value: "done" } });
  });

  test("run: user scripts off is no-user-scripts", async () => {
    const ctx = await welcomed();
    ctx.chrome.scriptsAllowed = false;
    ctx.chrome.tabs.push({ id: 7, url: "https://www.linkedin.com/feed/", status: "complete", windowId: 1, active: false });
    await command(ctx, { id: "r3", kind: "run", spec: { tabId: 7, code: "1", world: "USER_SCRIPT", sites: SITES } });
    expect(lastResult(ctx)).toMatchObject({ ok: false, error: { kind: "no-user-scripts" } });
    expect(ctx.socket().of("status")).toEqual([{ type: "status", userScripts: false, paused: false }]);
  });

  test("run: a script that throws is a script error", async () => {
    const ctx = await welcomed();
    ctx.chrome.tabs.push({ id: 7, url: "https://www.linkedin.com/feed/", status: "complete", windowId: 1, active: false });
    ctx.chrome.onExecute = async () => [{ error: "ReferenceError: x is not defined" }];
    await command(ctx, { id: "r4", kind: "run", spec: { tabId: 7, code: "x", world: "USER_SCRIPT", sites: SITES } });
    expect(lastResult(ctx)).toEqual({
      type: "result",
      commandId: "r4",
      ok: false,
      error: { kind: "script", message: "ReferenceError: x is not defined" },
    });
  });

  test("run: a tab that navigated off the plugin's sites is refused, and nothing runs", async () => {
    const ctx = await welcomed();
    ctx.chrome.tabs.push({ id: 7, url: "https://elsewhere.example/", status: "complete", windowId: 1, active: false });
    await command(ctx, { id: "r5", kind: "run", spec: { tabId: 7, code: "1", world: "USER_SCRIPT", sites: SITES } });
    expect(lastResult(ctx)).toMatchObject({ ok: false, error: { kind: "refused" } });
    expect(ctx.chrome.executed).toHaveLength(0);
  });

  test("run: a tab that is gone is a tab error", async () => {
    const ctx = await welcomed();
    await command(ctx, { id: "r6", kind: "run", spec: { tabId: 99, code: "1", world: "USER_SCRIPT", sites: SITES } });
    expect(lastResult(ctx)).toMatchObject({ ok: false, error: { kind: "tab" } });
  });

  test("screenshot: a background tab is brought forward, captured, and the reader's tab put back", async () => {
    const ctx = await welcomed();
    ctx.chrome.tabs.push(
      { id: 1, url: "https://news.example/", status: "complete", windowId: 1, active: true },
      { id: 7, url: "https://www.linkedin.com/feed/", status: "complete", windowId: 1, active: false },
    );
    ctx.socket().receive({ type: "command", id: "s1", kind: "screenshot", timeoutMs: 5_000, spec: { tabId: 7, activate: true, sites: SITES } });
    await settle();
    await ctx.clock.advance(200);
    expect(lastResult(ctx)).toEqual({
      type: "result",
      commandId: "s1",
      ok: true,
      value: { pngBase64: TINY_PNG_BASE64, width: 2, height: 3 },
    });
    expect(ctx.chrome.activated).toEqual([7, 1]);
  });

  test("screenshot: a hidden tab with activate off is a tab error", async () => {
    const ctx = await welcomed();
    ctx.chrome.tabs.push({ id: 7, url: "https://www.linkedin.com/feed/", status: "complete", windowId: 1, active: false });
    await command(ctx, { id: "s2", kind: "screenshot", spec: { tabId: 7, activate: false, sites: SITES } });
    expect(lastResult(ctx)).toMatchObject({ ok: false, error: { kind: "tab" } });
  });

  test("an unknown command kind is answered with an error, not dropped", async () => {
    const ctx = await welcomed();
    await command(ctx, { id: "u1", kind: "wait", spec: { selector: "x" } });
    expect(lastResult(ctx)).toEqual({
      type: "result",
      commandId: "u1",
      ok: false,
      error: { kind: "other", message: 'This Helper cannot run a "wait" command (or its spec is malformed).' },
    });
  });
});

describe("the outbox", () => {
  test("a result stays saved until the host acks it", async () => {
    const ctx = await welcomed();
    await command(ctx, { id: "o1", kind: "tab", spec: { url: "https://www.linkedin.com/", match: "origin", active: false, reuse: true, sites: SITES } });
    expect(ctx.chrome.local.data.outbox).toMatchObject({ o1: { state: "done" } });
    ctx.socket().receive({ type: "ack", commandId: "o1" });
    await settle();
    expect(ctx.chrome.local.data.outbox).toEqual({});
  });

  test("on welcome: saved results are sent again, and one a dead worker left running is interrupted", async () => {
    const saved: HelperResult = { type: "result", commandId: "done-1", ok: true, value: { tabId: 3, url: "https://a.example/", created: false } };
    const ctx = await welcomed({
      outbox: {
        "done-1": { state: "done", at: 1, result: saved },
        "ran-1": { state: "running", at: 1 },
      },
    });
    const results = ctx.socket().of("result");
    expect(results).toContainEqual(saved);
    expect(results).toContainEqual({
      type: "result",
      commandId: "ran-1",
      ok: false,
      error: { kind: "interrupted", message: "The Helper restarted while this command ran." },
    });
  });

  test("a command whose result is saved is never run twice", async () => {
    const ctx = await welcomed();
    ctx.chrome.tabs.push({ id: 7, url: "https://www.linkedin.com/feed/", status: "complete", windowId: 1, active: false });
    const frame = { id: "d1", kind: "run", spec: { tabId: 7, code: "1", world: "USER_SCRIPT", sites: SITES } };
    await command(ctx, frame);
    await command(ctx, frame);
    expect(ctx.chrome.executed).toHaveLength(1);
    expect(ctx.socket().of("result").filter((r) => r.commandId === "d1")).toHaveLength(2);
  });

  test("a result finished while the socket was down is delivered after the next welcome", async () => {
    const ctx = await welcomed();
    let release: (response: Response) => void = () => undefined;
    ctx.answerFetch(() => new Promise((resolve) => (release = resolve)));
    await command(ctx, { id: "late", kind: "fetch", spec: { url: "https://x.example/", method: "GET", credentials: "include", redirect: "follow" } });
    ctx.socket().drop();
    await settle();
    release(new Response("hi", { headers: { "content-type": "text/plain" } }));
    await settle();
    expect(ctx.chrome.local.data.outbox).toMatchObject({ late: { state: "done" } });
    await ctx.clock.advance(FIRST_RETRY_MS);
    ctx.socket().accept();
    ctx.socket().receive({ type: "welcome", deviceId: PAIRING.deviceId, name: "Chrome 141" });
    await settle();
    expect(lastResult(ctx)).toMatchObject({ commandId: "late", ok: true, value: { body: "hi" } });
  });
});

describe("pause", () => {
  test("pausing tells the host, and the pause ends on its own", async () => {
    const ctx = await welcomed();
    await ctx.client.setPause(ctx.clock.now() + 60_000);
    expect(ctx.socket().of("status").at(-1)).toEqual({ type: "status", userScripts: true, paused: true });
    expect(shownFor(view(ctx)).title).toBe("Connected to prifly, paused");
    await ctx.clock.advance(61_000);
    await ctx.client.tick();
    expect(ctx.socket().of("status").at(-1)).toEqual({ type: "status", userScripts: true, paused: false });
  });
});
