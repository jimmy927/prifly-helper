/**
 * What the Helper keeps in `chrome.storage.local`, so a service worker that
 * Chrome suspended and woke again picks up where it was: the pairing (device
 * id and token), the reader's settings, and the outbox of commands.
 *
 * The outbox holds each command's id before it runs and its result once it
 * has one, until the host acks it: a worker killed mid-command reports it
 * `interrupted` on the next connect, and a result is never lost between
 * running and delivery.
 */

import { z } from "zod";
import type { StorageArea } from "./platform";
import { HelperResult } from "./protocol";

export const DEFAULT_PORT = 4201;

const PairingSchema = z.object({ deviceId: z.string().min(1), token: z.string().min(1) });
export type Pairing = z.infer<typeof PairingSchema>;

const SettingsSchema = z.object({
  port: z.number().int().min(1).max(65535).catch(DEFAULT_PORT),
  profile: z.string().catch(""),
  pausedUntil: z.number().nullable().catch(null),
});
export type Settings = z.infer<typeof SettingsSchema>;

const OutboxEntrySchema = z.union([
  z.object({ state: z.literal("running"), at: z.number() }),
  z.object({ state: z.literal("done"), at: z.number(), result: HelperResult }),
]);
export type OutboxEntry = z.infer<typeof OutboxEntrySchema>;
export type Outbox = Record<string, OutboxEntry>;

const KEYS = { pairing: "pairing", settings: "settings", outbox: "outbox" } as const;

export const DEFAULT_SETTINGS: Settings = { port: DEFAULT_PORT, profile: "", pausedUntil: null };

export class HelperStore {
  private readonly area: StorageArea;
  /** Outbox writes in order: two commands finishing together must not lose one's entry. */
  private outboxChain: Promise<unknown> = Promise.resolve();

  constructor(area: StorageArea) {
    this.area = area;
  }

  async pairing(): Promise<Pairing | null> {
    const stored = (await this.area.get([KEYS.pairing]))[KEYS.pairing];
    const parsed = PairingSchema.safeParse(stored);
    return parsed.success ? parsed.data : null;
  }

  async setPairing(pairing: Pairing | null): Promise<void> {
    if (pairing === null) await this.area.remove([KEYS.pairing]);
    else await this.area.set({ [KEYS.pairing]: pairing });
  }

  async settings(): Promise<Settings> {
    const stored = (await this.area.get([KEYS.settings]))[KEYS.settings];
    const parsed = SettingsSchema.safeParse(stored ?? {});
    return parsed.success ? parsed.data : { ...DEFAULT_SETTINGS };
  }

  async setSettings(settings: Settings): Promise<void> {
    await this.area.set({ [KEYS.settings]: settings });
  }

  async outbox(): Promise<Outbox> {
    const stored = (await this.area.get([KEYS.outbox]))[KEYS.outbox];
    if (typeof stored !== "object" || stored === null) return {};
    const outbox: Outbox = {};
    for (const [id, entry] of Object.entries(stored)) {
      const parsed = OutboxEntrySchema.safeParse(entry);
      if (parsed.success) outbox[id] = parsed.data;
    }
    return outbox;
  }

  /** Change one entry (null removes it), after every change asked for before it. */
  updateOutbox(id: string, entry: OutboxEntry | null): Promise<void> {
    const next = this.outboxChain.then(async () => {
      const outbox = await this.outbox();
      if (entry === null) delete outbox[id];
      else outbox[id] = entry;
      await this.area.set({ [KEYS.outbox]: outbox });
    });
    // A failed write must not stop the ones after it; the caller still hears of it.
    this.outboxChain = next.catch(() => undefined);
    return next;
  }
}
