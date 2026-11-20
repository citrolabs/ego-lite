import { writeSync } from "node:fs";

import { formatCliLogValue } from "./format.js";
import {
  consumeUnhandledPageNotices,
  resetPageNotices,
  type UnhandledPageNotice,
} from "./page-discovery.js";

/**
 * Round output stays buffered until completion because bytes written before a hard
 * stop cannot be recalled. A hard stop discards business output and Page notices,
 * then emits its owned guidance once. The short-lived process makes this state
 * round-local; reset functions exist only for in-process tests.
 */

type WritableLike = { write(chunk: string): unknown; fd?: number };
type LifecycleLike = {
  on(event: "beforeExit" | "exit", listener: () => void): unknown;
};

export type RoundConsole = Pick<Console, "log" | "info" | "warn" | "error">;

let buffer: string[] = [];
let hardStopMessage: string | null = null;
let flushed = false;
let lifecycleHooked = false;

/** Buffer one already-formatted cliLog chunk (the trailing newline is included). */
export function bufferOutput(chunk: string): void {
  buffer.push(chunk);
}

/** Create the console object injected into one agent round. */
export function createRoundConsole(
  writeLine: (line: string) => void = bufferOutput,
): RoundConsole {
  const append = (prefix: string, args: unknown[]) => {
    const body = args.map(formatCliLogValue).join(" ");
    writeLine(`${prefix}${body}\n`);
  };
  return Object.freeze({
    log: (...args: unknown[]) => append("", args),
    info: (...args: unknown[]) => append("", args),
    warn: (...args: unknown[]) => append("[warn] ", args),
    error: (...args: unknown[]) => append("[error] ", args),
  });
}

/**
 * Record the owned message of the first hard-stop error seen this run. Later hard stops
 * — the same error re-reported on each loop iteration — are ignored so the agent sees
 * the guidance exactly once.
 */
export function markHardStop(message: string): void {
  if (hardStopMessage === null) {
    hardStopMessage = message;
  }
}

/**
 * Emit the run's output exactly once.
 *
 * `thrown` separates a completed script from one ending on an uncaught error. On a clean
 * finish we are the only writer, so a hard stop must print its message here. On an
 * uncaught error the propagating Error already surfaces the message (the host prints it),
 * so we stay silent and only drop the buffer. Non-hard-stop output is flushed either way,
 * so an ordinary failure still shows what the script logged before it threw.
 */
export function flushSink(stream: WritableLike, thrown: boolean): void {
  if (flushed) return;
  flushed = true;
  const pageNotices = consumeUnhandledPageNotices();
  if (hardStopMessage !== null) {
    // Drop every buffered line — business logs, success rows, and the repeated error
    // echoes — so the owned guidance is all that remains.
    if (!thrown) {
      stream.write(
        hardStopMessage.endsWith("\n")
          ? hardStopMessage
          : `${hardStopMessage}\n`,
      );
    }
  } else {
    for (const chunk of buffer) stream.write(chunk);
    if (pageNotices.length > 0) {
      stream.write(formatPageNotices(pageNotices));
    }
  }
  buffer = [];
}

/** Clear sink state. Real runs get a fresh process; this is only for in-process tests. */
export function resetSink(): void {
  buffer = [];
  hardStopMessage = null;
  flushed = false;
  resetPageNotices();
}

function formatPageNotices(notices: UnhandledPageNotice[]): string {
  const lines = notices.map((notice) => {
    const source = notice.openerLabel ? ` from ${notice.openerLabel}` : "";
    const url = oneLine(notice.url || "about:blank");
    return `Unhandled page ${notice.label}${source}: ${url}`;
  });
  return `[ego-browser:pages]\n${lines.join("\n")}\n`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Flush on process teardown for the SDK path, where the host runs each heredoc directly
 * and never calls the CLI `execute()` wrapper, so lifecycle events are our only hook.
 *
 * A clean finish drains the event loop and reaches `beforeExit`; an uncaught async
 * rejection skips `beforeExit` but still reaches `exit` (`thrown: true`, so a hard stop
 * stays silent and lets the propagating Error surface the message). The stream still
 * accepts writes in both events, so the same `stream` serves both. Registered once.
 */
export function installLifecycleFlush(
  stream: WritableLike,
  lifecycle: LifecycleLike = process,
): void {
  if (lifecycleHooked) return;
  lifecycleHooked = true;
  const writer = Number.isInteger(stream.fd)
    ? {
        write(chunk: string) {
          // `exit` cannot wait for a piped Writable to drain. A synchronous fd
          // write preserves the final buffered lines on both lifecycle paths.
          writeSync(stream.fd!, chunk);
        },
      }
    : stream;
  lifecycle.on("beforeExit", () => flushSink(writer, false));
  lifecycle.on("exit", () => flushSink(writer, true));
}
