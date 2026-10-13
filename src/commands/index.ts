/** One command frame, run to its value or its typed failure, within the frame's `timeoutMs`. */

import type { Platform } from "../platform";
import type { HelperCommand, HelperResultError } from "../protocol";
import { CommandError, messageOf } from "./common";
import { runFetch } from "./fetch";
import { runRun } from "./run";
import { runScreenshot } from "./screenshot";
import { runTab } from "./tab";

export type Outcome = { ok: true; value: unknown } | { ok: false; error: HelperResultError };

function dispatch(platform: Platform, command: HelperCommand, deadline: number): Promise<unknown> {
  switch (command.kind) {
    case "fetch":
      return runFetch(platform, command.spec, deadline);
    case "tab":
      return runTab(platform, command.spec);
    case "run":
      return runRun(platform, command.spec, deadline);
    case "screenshot":
      return runScreenshot(platform, command.spec, deadline);
  }
}

export async function runCommand(platform: Platform, command: HelperCommand): Promise<Outcome> {
  const deadline = platform.clock.now() + command.timeoutMs;
  let cancel: () => void = () => undefined;
  const timedOut = new Promise<never>((_, reject) => {
    cancel = platform.clock.after(command.timeoutMs, () =>
      reject(new CommandError("timeout", `No answer within ${command.timeoutMs} ms.`)),
    );
  });
  try {
    const value = await Promise.race([dispatch(platform, command, deadline), timedOut]);
    return { ok: true, value };
  } catch (error) {
    if (error instanceof CommandError) {
      return { ok: false, error: { kind: error.kind, message: error.message } };
    }
    return { ok: false, error: { kind: "other", message: messageOf(error) } };
  } finally {
    cancel();
  }
}
