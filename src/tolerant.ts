/**
 * Strict on write, tolerant on read.
 *
 * Claude Code adds event kinds, tool names and error categories between
 * releases, and its own docs say to ignore values you do not recognise. A
 * strict enum on the read side turns one unknown value into a blank panel, so
 * reads widen and writes stay strict.
 *
 * COPY: prifly's `packages/wire/src/tolerant.ts`, verbatim except this line.
 */

import { z } from "zod";

export function isOneOf<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

/** For lists that have a catch-all member: an unknown value becomes `fallback`. */
export function readEnum<T extends string>(values: readonly T[], fallback: T) {
  return z.string().transform((value): T => (isOneOf(values, value) ? value : fallback));
}

/** For lists with no catch-all: the page draws an unfamiliar value as plain text. */
export const OpenValue = z.string().min(1);

type Issue = { code: string; path: PropertyKey[]; keys?: string[] };

/** Drop the keys an `unrecognized_keys` issue names, in place. */
function dropKeys(value: unknown, issue: Issue): void {
  let at: unknown = value;
  for (const step of issue.path) {
    if (typeof at !== "object" || at === null) return;
    at = (at as Record<PropertyKey, unknown>)[step];
  }
  if (typeof at !== "object" || at === null) return;
  for (const key of issue.keys ?? []) delete (at as Record<string, unknown>)[key];
}

/**
 * Parse a message from the other side, ignoring fields this build does not
 * know. The schemas are strict so that WE never send a field the other side
 * does not expect; on read, a field from a newer build is no reason to throw
 * away the message. Measured on 2026-09-23: a host one change ahead added two
 * fields to each session, and the window rejected every snapshot — the whole
 * session list disappeared — over two keys it would have ignored anyway.
 * Anything else wrong with the message still fails, as before.
 */
export function parseTolerant<T extends z.ZodType>(
  schema: T,
  value: unknown,
): ReturnType<T["safeParse"]> {
  let result = schema.safeParse(value);
  if (result.success) return result as ReturnType<T["safeParse"]>;
  const unknownOnly = (issues: readonly Issue[]) =>
    issues.length > 0 && issues.every((issue) => issue.code === "unrecognized_keys");
  if (!unknownOnly(result.error.issues as Issue[])) return result as ReturnType<T["safeParse"]>;
  const copy: unknown = structuredClone(value);
  for (const issue of result.error.issues as Issue[]) dropKeys(copy, issue);
  result = schema.safeParse(copy);
  return result as ReturnType<T["safeParse"]>;
}
