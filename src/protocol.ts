/**
 * The prifly Helper's wire protocol, v1: a browser extension (repo
 * `jimmy927/prifly-helper`) and the host over one WebSocket at `/helper`.
 *
 * Every frame is one JSON object with a `type`. The host parses what the
 * extension sends tolerantly (an unknown `type` or field is ignored and
 * logged, never a crash) and writes strictly. The extension is built apart
 * from this repo, so these schemas ARE the contract: change one only by
 * bumping `HELPER_PROTOCOL`.
 *
 * COPY: this file is prifly's `packages/wire/src/protocol-helper.ts`, copied
 * verbatim (this repo cannot import `@prifly/wire`); only this paragraph
 * differs. Here the roles flip: the extension
 * writes `HelperInMsg` frames strictly and reads `HelperOutMsg` tolerantly.
 * When prifly changes its copy, copy it again.
 */

import { z } from "zod";
import { readEnum } from "./tolerant";

export const HELPER_PROTOCOL = 1;

/** The path the extension connects to on the host's port. */
export const HELPER_ROUTE = "/helper";

// ---------------------------------------------------------------- commands

export const HELPER_COMMAND_KINDS = ["fetch", "tab", "run", "screenshot"] as const;
export const HelperCommandKind = z.enum(HELPER_COMMAND_KINDS);
export type HelperCommandKind = z.infer<typeof HelperCommandKind>;

export const HelperRetry = z.enum(["safe", "never"]);
export type HelperRetry = z.infer<typeof HelperRetry>;

/** A request made with the browser's own cookies. */
export const HelperFetchSpec = z.strictObject({
  url: z.string().min(1),
  method: z.string().min(1).default("GET"),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  bodyBase64: z.string().optional(),
  credentials: z.enum(["include", "omit", "same-origin"]).default("include"),
  redirect: z.enum(["follow", "manual", "error"]).default("follow"),
  /** Applied as the request's Origin header (a session declarativeNetRequest rule). */
  origin: z.string().optional(),
  referer: z.string().optional(),
  /** Names of cookies whose values come back with the answer; the jar never does. */
  cookies: z.array(z.string().min(1)).optional(),
});
export type HelperFetchSpec = z.infer<typeof HelperFetchSpec>;

export const HelperFetchValue = z.strictObject({
  status: z.number().int(),
  statusText: z.string().default(""),
  url: z.string(),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().optional(),
  bodyBase64: z.string().optional(),
  cookies: z.record(z.string(), z.string()).optional(),
});
export type HelperFetchValue = z.infer<typeof HelperFetchValue>;

/**
 * The sending plugin's declared `helper.sites` (Chrome match patterns). The
 * extension re-reads a tab's URL right before acting on it and refuses with
 * `error.kind: "refused"` when it matches none, so a tab that navigated off
 * the plugin's sites is never touched.
 */
const HelperSites = z.array(z.string().min(1));

/** Find an open tab (or open one in the background). */
export const HelperTabSpec = z.strictObject({
  url: z.string().min(1),
  match: z.enum(["origin", "prefix", "exact"]).default("origin"),
  active: z.boolean().default(false),
  reuse: z.boolean().default(true),
  sites: HelperSites,
});
export type HelperTabSpec = z.infer<typeof HelperTabSpec>;

export const HelperTabValue = z.strictObject({
  tabId: z.number().int(),
  url: z.string(),
  created: z.boolean(),
});
export type HelperTabValue = z.infer<typeof HelperTabValue>;

export const HelperWaitFor = z.union([
  z.literal("load"),
  z.strictObject({
    selector: z.string().min(1),
    timeoutMs: z.number().int().positive().optional(),
  }),
]);
export type HelperWaitFor = z.infer<typeof HelperWaitFor>;

/** Code run in a tab by `chrome.userScripts.execute`; the last expression may be a promise. */
export const HelperRunSpec = z
  .strictObject({
    tabId: z.number().int().optional(),
    url: z.string().min(1).optional(),
    code: z.string().min(1),
    world: z.enum(["USER_SCRIPT", "MAIN"]).default("USER_SCRIPT"),
    waitFor: HelperWaitFor.optional(),
    sites: HelperSites,
  })
  .refine((spec) => (spec.tabId === undefined) !== (spec.url === undefined), {
    message: "a run names a tab or a url, not both and not neither",
  });
export type HelperRunSpec = z.infer<typeof HelperRunSpec>;

export const HelperRunValue = z.strictObject({ value: z.unknown() });
export type HelperRunValue = z.infer<typeof HelperRunValue>;

export const HelperScreenshotSpec = z
  .strictObject({
    tabId: z.number().int().optional(),
    url: z.string().min(1).optional(),
    activate: z.boolean().default(true),
    sites: HelperSites,
  })
  .refine((spec) => (spec.tabId === undefined) !== (spec.url === undefined), {
    message: "a screenshot names a tab or a url, not both and not neither",
  });
export type HelperScreenshotSpec = z.infer<typeof HelperScreenshotSpec>;

export const HelperScreenshotValue = z.strictObject({
  pngBase64: z.string(),
  width: z.number().int(),
  height: z.number().int(),
});
export type HelperScreenshotValue = z.infer<typeof HelperScreenshotValue>;

// ----------------------------------------------------------------- errors

export const HELPER_ERROR_KINDS = [
  "timeout",
  "network",
  "no-user-scripts",
  "tab",
  "script",
  "refused",
  "interrupted",
  "other",
] as const;
export type HelperErrorKind = (typeof HELPER_ERROR_KINDS)[number];

/** What the extension reports; a kind a newer extension adds reads as "other". */
export const HelperResultError = z.strictObject({
  kind: readEnum(HELPER_ERROR_KINDS, "other"),
  message: z.string().default(""),
});
export type HelperResultError = z.infer<typeof HelperResultError>;

// ------------------------------------------------------ extension to host

export const HelperHello = z.strictObject({
  type: z.literal("hello"),
  protocol: z.number().int(),
  deviceId: z.string().nullable(),
  token: z.string().nullable(),
  /** "Chrome 154". */
  browser: z.string(),
  os: z.string(),
  /** The label the reader gave this browser profile; "" when none. */
  profile: z.string().default(""),
  extensionVersion: z.string().default(""),
  userScripts: z.boolean(),
});
export type HelperHello = z.infer<typeof HelperHello>;

export const HelperPair = z.strictObject({
  type: z.literal("pair"),
  /** As typed: the host strips spaces and dashes and upper-cases it. */
  code: z.string(),
});
export type HelperPair = z.infer<typeof HelperPair>;

export const HelperResult = z.strictObject({
  type: z.literal("result"),
  commandId: z.string().min(1),
  ok: z.boolean(),
  value: z.unknown().optional(),
  error: HelperResultError.optional(),
});
export type HelperResult = z.infer<typeof HelperResult>;

export const HelperPong = z.strictObject({ type: z.literal("pong"), at: z.number() });

/** The user-scripts toggle or the popup's Pause changed. */
export const HelperStatusFrame = z.strictObject({
  type: z.literal("status"),
  userScripts: z.boolean(),
  paused: z.boolean().default(false),
});
export type HelperStatusFrame = z.infer<typeof HelperStatusFrame>;

export const HelperInMsg = z.discriminatedUnion("type", [
  HelperHello,
  HelperPair,
  HelperResult,
  HelperPong,
  HelperStatusFrame,
]);
export type HelperInMsg = z.infer<typeof HelperInMsg>;

/** Every `type` the host reads; any other is ignored and logged. */
export const HELPER_IN_TYPES: readonly string[] = ["hello", "pair", "result", "pong", "status"];

// ------------------------------------------------------ host to extension

export const HelperWelcome = z.strictObject({
  type: z.literal("welcome"),
  deviceId: z.string(),
  name: z.string(),
});

export const HelperUnpaired = z.strictObject({ type: z.literal("unpaired") });

export const HelperPaired = z.strictObject({
  type: z.literal("paired"),
  deviceId: z.string(),
  token: z.string(),
});

export const HELPER_REFUSALS = [
  "bad-code",
  "code-expired",
  "too-many-tries",
  "revoked",
  "protocol",
] as const;
export const HelperRefusal = z.enum(HELPER_REFUSALS);
export type HelperRefusal = z.infer<typeof HelperRefusal>;

export const HelperRefused = z.strictObject({
  type: z.literal("refused"),
  reason: HelperRefusal,
  message: z.string(),
});

const commandFrame = <K extends HelperCommandKind, S extends z.ZodType>(kind: K, spec: S) =>
  z.strictObject({
    type: z.literal("command"),
    id: z.string().min(1),
    kind: z.literal(kind),
    spec,
    timeoutMs: z.number().int().positive(),
  });

/** One command; `spec` is the kind's own shape. */
export const HelperCommand = z.union([
  commandFrame("fetch", HelperFetchSpec),
  commandFrame("tab", HelperTabSpec),
  commandFrame("run", HelperRunSpec),
  commandFrame("screenshot", HelperScreenshotSpec),
]);
export type HelperCommand = z.infer<typeof HelperCommand>;

export const HelperAck = z.strictObject({ type: z.literal("ack"), commandId: z.string() });
export const HelperPing = z.strictObject({ type: z.literal("ping"), at: z.number() });

export const HelperOutMsg = z.union([
  HelperWelcome,
  HelperUnpaired,
  HelperPaired,
  HelperRefused,
  HelperCommand,
  HelperAck,
  HelperPing,
]);
export type HelperOutMsg = z.infer<typeof HelperOutMsg>;

// ------------------------------------------------ the window (status bar)

export const HELPER_STATES = ["not-installed", "needs-pairing", "offline", "connected"] as const;
export const HelperState = z.enum(HELPER_STATES);
export type HelperState = z.infer<typeof HelperState>;

export const HelperBrowser = z.strictObject({
  id: z.string(),
  name: z.string(),
  browser: z.string(),
  os: z.string(),
  profile: z.string(),
  pairedAt: z.number(),
  lastSeenAt: z.number(),
  online: z.boolean(),
  userScripts: z.boolean(),
});
export type HelperBrowser = z.infer<typeof HelperBrowser>;

/** One lane of the queue: what runs now, how many wait, the pace and the last outcome. */
export const HelperSite = z.strictObject({
  site: z.string(),
  extension: z.string(),
  now: z.string().nullable(),
  waiting: z.number().int(),
  pace: z.string(),
  last: z.string().nullable(),
});
export type HelperSite = z.infer<typeof HelperSite>;

export const HELPER_INSTALL_PHASES = ["preparing", "ready", "failed"] as const;
export type HelperInstallPhase = (typeof HELPER_INSTALL_PHASES)[number];

/**
 * Where the host's install of the Helper folder stands: running (or about to),
 * done, or failed with a one-line reason. A phase a newer host adds reads as
 * "preparing", and a host that sends none is "preparing" too.
 */
export const HelperInstall = z.strictObject({
  phase: readEnum(HELPER_INSTALL_PHASES, "preparing"),
  /** Why it failed, one line; "" unless `phase` is "failed". */
  reason: z.string().default(""),
});
export type HelperInstall = z.infer<typeof HelperInstall>;

/**
 * `StatusMsg.helper`: the chip and Settings → Browser Helper. Null from a host
 * that has none, so an older window parses the frame.
 */
export const HelperStatus = z.strictObject({
  state: HelperState,
  /** Whether a connected Helper (paired, else unpaired) can run user scripts. */
  userScripts: z.boolean(),
  /** The pairing code shown in the window, while it lives. */
  code: z.strictObject({ code: z.string(), expiresAt: z.number() }).nullable(),
  /** The folder to pick under "Load unpacked"; null until the host has placed one (needs a buildable extension commit). */
  folder: z.string().nullable(),
  /** The install that makes `folder`: the window says why there is none, and offers a retry. */
  install: HelperInstall.default({ phase: "preparing", reason: "" }),
  browsers: z.array(HelperBrowser),
  /** A Helper connected right now that is not paired (steps 1 and 2 done). */
  unpaired: z.strictObject({ browser: z.string(), userScripts: z.boolean() }).nullable(),
  sites: z.array(HelperSite),
});
export type HelperStatus = z.infer<typeof HelperStatus>;

export const HelperNewCodeMsg = z.strictObject({ type: z.literal("helperNewCode") });
export type HelperNewCodeMsg = z.infer<typeof HelperNewCodeMsg>;

export const HelperUnpairMsg = z.strictObject({
  type: z.literal("helperUnpair"),
  deviceId: z.string().min(1),
});
export type HelperUnpairMsg = z.infer<typeof HelperUnpairMsg>;

/** Run the Helper folder's install again (a no-op while one runs). */
export const HelperRetryInstallMsg = z.strictObject({ type: z.literal("helperRetryInstall") });
export type HelperRetryInstallMsg = z.infer<typeof HelperRetryInstallMsg>;

export const HELPER_CLIENT_MSGS = [
  HelperNewCodeMsg,
  HelperUnpairMsg,
  HelperRetryInstallMsg,
] as const;
