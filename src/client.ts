/**
 * The Helper's side of prifly's `/helper` socket (protocol v1, `protocol.ts`).
 *
 * - One WebSocket to `ws://127.0.0.1:<port>/helper`. Every connection starts
 *   with a hello: with the stored token the host answers `welcome`, without
 *   one `unpaired` (the socket stays open so prifly ticks its first set-up
 *   steps), with a token it no longer knows `refused revoked`.
 * - Pairing: the code the reader types goes out as `pair`; `paired` brings the
 *   device id and token, stored before anything else happens.
 * - Commands run only once welcomed. Each command's id is written to the
 *   outbox before it runs and its result after; the result is re-sent on every
 *   welcome until the host acks it. A command a dead worker left running is
 *   reported `interrupted`.
 * - A dropped or refused connection is retried with backoff, 1 s doubling to
 *   30 s. The host's ping every 20 s keeps the service worker awake; when
 *   Chrome suspends it anyway, the 30 s alarm wakes it and `tick()` reconnects.
 */

import { runCommand } from "./commands";
import { messageOf } from "./commands/common";
import { type Platform, SOCKET_OPEN, type SocketLike } from "./platform";
import {
  HELPER_PROTOCOL,
  HELPER_ROUTE,
  HelperCommand,
  type HelperInMsg,
  HelperInMsg as HelperInSchema,
  HelperOutMsg,
  type HelperResult,
} from "./protocol";
import { parseTolerant } from "./tolerant";
import { DEFAULT_SETTINGS, HelperStore, type Pairing, type Settings } from "./store";
import { HOST_DOWN, VIEW_KEY, type View } from "./view";

export const FIRST_RETRY_MS = 1_000;
export const MAX_RETRY_MS = 30_000;

export class HelperClient {
  private readonly platform: Platform;
  private readonly store: HelperStore;
  private socket: SocketLike | null = null;
  private retryMs = FIRST_RETRY_MS;
  private cancelRetry: (() => void) | null = null;
  private pairingInfo: Pairing | null = null;
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private os = "";
  /** A code typed while the socket was not open: sent right after the hello. */
  private pendingCode: string | null = null;
  /** Commands running in this worker, so a duplicate frame is not run twice. */
  private readonly running = new Set<string>();
  private started: Promise<void> | null = null;
  private view: View;

  constructor(platform: Platform) {
    this.platform = platform;
    this.store = new HelperStore(platform.chrome.local);
    this.view = {
      connection: "connecting",
      paired: false,
      welcomed: false,
      name: "",
      userScripts: platform.chrome.userScriptsAllowed(),
      pausedUntil: null,
      pairing: false,
      refusal: null,
      error: "",
      port: DEFAULT_SETTINGS.port,
      profile: "",
    };
  }

  /** Load what storage holds and connect; every later call waits for the first. */
  start(): Promise<void> {
    this.started ??= this.boot();
    return this.started;
  }

  private async boot(): Promise<void> {
    this.pairingInfo = await this.store.pairing();
    this.settings = await this.store.settings();
    this.os = await this.platform.chrome.os();
    this.patch({
      paired: this.pairingInfo !== null,
      port: this.settings.port,
      profile: this.settings.profile,
      pausedUntil: this.livePause(),
    });
    this.connect();
  }

  /** What the popup reads. */
  current(): View {
    return { ...this.view };
  }

  // ------------------------------------------------------------- the popup

  /** The alarm (every 30 s) and the popup opening: reconnect if down, re-check user scripts and the pause. */
  async tick(): Promise<void> {
    await this.start();
    this.recheckUserScripts();
    if (this.settings.pausedUntil !== null && this.livePause() === null) {
      await this.setPause(null);
    }
    if (this.socket === null) this.connect();
  }

  /** The reader typed a pairing code. */
  async pair(code: string, profile: string): Promise<void> {
    await this.start();
    const trimmed = code.trim();
    if (trimmed === "") {
      this.patch({ error: "Type the code from prifly first." });
      return;
    }
    if (profile.trim() !== this.settings.profile) {
      this.settings = { ...this.settings, profile: profile.trim() };
      await this.store.setSettings(this.settings);
    }
    this.patch({ pairing: true, refusal: null, error: "", profile: this.settings.profile });
    if (this.isOpen()) {
      // A changed profile label goes with a fresh hello, so prifly names the browser by it.
      this.sendHello();
      this.send({ type: "pair", code: trimmed });
    } else {
      this.pendingCode = trimmed;
      this.connect();
    }
  }

  /** Retry now instead of waiting for the backoff. */
  async retry(): Promise<void> {
    await this.start();
    this.retryMs = FIRST_RETRY_MS;
    this.connect();
  }

  async setPort(port: number): Promise<void> {
    await this.start();
    this.settings = { ...this.settings, port };
    await this.store.setSettings(this.settings);
    this.patch({ port });
    this.retryMs = FIRST_RETRY_MS;
    this.connect();
  }

  /** Pause until `until` (null resumes): prifly sends no command meanwhile. */
  async setPause(until: number | null): Promise<void> {
    await this.start();
    this.settings = { ...this.settings, pausedUntil: until };
    await this.store.setSettings(this.settings);
    this.patch({ pausedUntil: this.livePause() });
    if (this.view.welcomed) this.sendStatus();
  }

  // ------------------------------------------------------------ the socket

  private url(): string {
    return `ws://127.0.0.1:${this.settings.port}${HELPER_ROUTE}`;
  }

  private isOpen(): boolean {
    return this.socket !== null && this.socket.readyState === SOCKET_OPEN;
  }

  /** Drop any socket and open a fresh one. */
  private connect(): void {
    this.cancelRetry?.();
    this.cancelRetry = null;
    const old = this.socket;
    this.socket = null;
    if (old !== null) old.close(1000, "reconnecting");
    this.patch({ connection: "connecting", welcomed: false });
    let socket: SocketLike;
    try {
      socket = this.platform.openSocket(this.url());
    } catch (error) {
      this.patch({ connection: "unreachable", error: messageOf(error) });
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    let opened = false;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      opened = true;
      this.retryMs = FIRST_RETRY_MS;
      this.patch({ connection: "open", error: this.view.refusal === null ? "" : this.view.error });
      this.sendHello();
      if (this.pendingCode !== null) {
        this.send({ type: "pair", code: this.pendingCode });
        this.pendingCode = null;
      }
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      void this.onFrame(event.data);
    };
    socket.onerror = () => undefined;
    socket.onclose = (event) => {
      // A socket this client already replaced: its close changes nothing.
      if (this.socket !== socket) return;
      this.socket = null;
      this.patch({
        connection: opened ? "connecting" : "unreachable",
        welcomed: false,
        pairing: false,
        error: opened ? closeReason(event) : this.view.refusal === null ? HOST_DOWN : this.view.error,
      });
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    this.cancelRetry?.();
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    this.cancelRetry = this.platform.clock.after(wait, () => {
      this.cancelRetry = null;
      this.connect();
    });
  }

  /** Strict on write: a frame the host would not accept is a bug here, not sent. */
  private send(frame: HelperInMsg): boolean {
    const checked = HelperInSchema.safeParse(frame);
    if (!checked.success) {
      console.error("prifly Helper: refusing to send an invalid frame", frame.type, checked.error);
      return false;
    }
    if (this.socket === null || !this.isOpen()) return false;
    this.socket.send(JSON.stringify(checked.data));
    return true;
  }

  private sendHello(): void {
    this.send({
      type: "hello",
      protocol: HELPER_PROTOCOL,
      deviceId: this.pairingInfo?.deviceId ?? null,
      token: this.pairingInfo?.token ?? null,
      browser: this.platform.chrome.browser(),
      os: this.os,
      profile: this.settings.profile,
      extensionVersion: this.platform.chrome.extensionVersion(),
      userScripts: this.view.userScripts,
    });
  }

  private sendStatus(): void {
    this.send({ type: "status", userScripts: this.view.userScripts, paused: this.livePause() !== null });
  }

  private livePause(): number | null {
    const until = this.settings.pausedUntil;
    return until !== null && until > this.platform.clock.now() ? until : null;
  }

  /** The Details-page toggle has no event: checked on every tick, popup open and run. */
  recheckUserScripts(): void {
    const now = this.platform.chrome.userScriptsAllowed();
    if (now === this.view.userScripts) return;
    this.patch({ userScripts: now });
    // A paired socket says so with a status frame; an unpaired one, which the host
    // takes no status from, says it again in a fresh hello so prifly's step 2 ticks.
    if (this.view.welcomed) this.sendStatus();
    else if (this.isOpen()) this.sendHello();
  }

  // ------------------------------------------------------------ the frames

  private async onFrame(data: unknown): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      console.warn("prifly Helper: a frame that is not JSON");
      return;
    }
    if (typeof raw !== "object" || raw === null || !("type" in raw)) return;
    if (raw.type === "command") {
      await this.onCommand(raw);
      return;
    }
    const parsed = parseTolerant(HelperOutMsg, raw);
    if (!parsed.success) {
      // A newer host may send frames this build does not know: ignored, never a crash.
      console.warn("prifly Helper: ignored frame", raw.type);
      return;
    }
    const frame = parsed.data;
    switch (frame.type) {
      case "ping":
        this.send({ type: "pong", at: this.platform.clock.now() });
        return;
      case "unpaired":
        this.patch({ welcomed: false });
        return;
      case "paired":
        this.pairingInfo = { deviceId: frame.deviceId, token: frame.token };
        await this.store.setPairing(this.pairingInfo);
        this.patch({ paired: true, pairing: false, refusal: null, error: "" });
        return;
      case "welcome":
        this.patch({ welcomed: true, name: frame.name, refusal: null, error: "", pairing: false });
        if (this.livePause() !== null) this.sendStatus();
        await this.flushOutbox();
        return;
      case "refused":
        if (frame.reason === "revoked") {
          this.pairingInfo = null;
          await this.store.setPairing(null);
        }
        this.patch({
          refusal: frame.reason,
          error: frame.message,
          pairing: false,
          paired: this.pairingInfo !== null,
          welcomed: false,
        });
        return;
      case "ack":
        await this.store.updateOutbox(frame.commandId, null);
        return;
      case "command":
        // Commands are routed above, before the generic parse.
        return;
    }
  }

  private async onCommand(raw: object): Promise<void> {
    const id = "id" in raw && typeof raw.id === "string" && raw.id !== "" ? raw.id : null;
    if (!this.view.welcomed) {
      console.warn("prifly Helper: a command before welcome, ignored");
      return;
    }
    if (id === null) {
      console.warn("prifly Helper: a command without an id, ignored");
      return;
    }
    if (this.running.has(id)) return;
    const box = await this.store.outbox();
    const stored = box[id];
    if (stored?.state === "done") {
      // Already ran: the stored answer, never a second run.
      this.send(stored.result);
      return;
    }
    const parsed = parseTolerant(HelperCommand, raw);
    if (!parsed.success) {
      const kind = "kind" in raw ? String(raw.kind) : "?";
      await this.finish(id, {
        type: "result",
        commandId: id,
        ok: false,
        error: { kind: "other", message: `This Helper cannot run a "${kind}" command (or its spec is malformed).` },
      });
      return;
    }
    const command = parsed.data;
    this.running.add(id);
    try {
      await this.store.updateOutbox(id, { state: "running", at: this.platform.clock.now() });
      if (command.kind === "run") this.recheckUserScripts();
      const outcome = await runCommand(this.platform, command);
      await this.finish(
        id,
        outcome.ok
          ? { type: "result", commandId: id, ok: true, value: outcome.value }
          : { type: "result", commandId: id, ok: false, error: outcome.error },
      );
    } finally {
      this.running.delete(id);
    }
  }

  /** Saved before it is sent: a socket that drops now still delivers it on the next welcome. */
  private async finish(id: string, result: HelperResult): Promise<void> {
    await this.store.updateOutbox(id, { state: "done", at: this.platform.clock.now(), result });
    if (this.view.welcomed) this.send(result);
  }

  /** On welcome: every saved result again, and what a dead worker left running as interrupted. */
  private async flushOutbox(): Promise<void> {
    const box = await this.store.outbox();
    for (const [id, entry] of Object.entries(box)) {
      if (entry.state === "done") {
        this.send(entry.result);
      } else if (!this.running.has(id)) {
        await this.finish(id, {
          type: "result",
          commandId: id,
          ok: false,
          error: { kind: "interrupted", message: "The Helper restarted while this command ran." },
        });
      }
    }
  }

  // --------------------------------------------------------------- the view

  private patch(change: Partial<View>): void {
    this.view = { ...this.view, ...change };
    this.platform.chrome.session.set({ [VIEW_KEY]: this.view }).catch((error: unknown) => {
      console.warn("prifly Helper: could not publish the popup's view", messageOf(error));
    });
  }
}

function closeReason(event: { code: number; reason: string }): string {
  if (event.code === 4001) return "This browser was unpaired from prifly: pair it again.";
  if (event.code === 1002) return "prifly cannot talk to this version of the Helper.";
  return event.reason === "" ? "The connection to prifly dropped; reconnecting." : event.reason;
}
