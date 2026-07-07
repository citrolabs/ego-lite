/**
 * Output sink for the agent-facing runtime.
 *
 * `console.log` is the primary channel an agent reads. A single user takeover turns
 * that channel into noise: while the user holds control, every browser command
 * re-reports the same hard-stop error, so a script that loops over work and swallows
 * each error (try/catch, `.catch()`) prints the same guidance on every iteration,
 * buried under its own business logging and success rows.
 *
 * To collapse that to one clean line, execution runs inside an output boundary. When
 * a hard-stop error is born (see `buildEgoError`) we record its owned message once.
 * At the end of the boundary we either:
 *   - a hard stop occurred -> discard boundary output and emit the owned message once
 *   - otherwise            -> flush the captured output verbatim
 * and in both cases append the update-notice trailer (if any) last, so an out-of-band
 * "ego lite update available" hint reads as a footer after the command's own output.
 *
 * The boundary is one stdin script in compatibility mode, or one REPL cell in
 * interactive mode. That distinction matters: a long-lived REPL process must not let
 * one cell's hard-stop state pollute the next cell.
 */

type WritableLike = { write(chunk: string): unknown };
type OutputCapture = {
  clear(): unknown;
  take(): unknown;
};
type FlushResult = {
  hardStop: boolean;
  wrote: boolean;
};

let buffer: string[] = [];
let hardStopMessage: string | null = null;
let noticeTrailer: string | null = null;
let flushed = false;
let lifecycleHooked = false;
let boundaryDepth = 0;
let boundaryCapture: OutputCapture | null = null;

/** Buffer one already-formatted console.log chunk (the trailing newline is included). */
export function bufferOutput(chunk: string): void {
  buffer.push(chunk);
}

/**
 * Record the update-notice line to append after this run's output. Set out-of-band by
 * the fire-and-forget version check; appended by `flushSink` so it trails the command's
 * own output rather than racing ahead of it. Last write wins.
 */
export function setNoticeTrailer(line: string): void {
  noticeTrailer = line;
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

/** Start an output boundary for one stdin script or one REPL cell. */
export function beginOutputBoundary(capture?: OutputCapture | null): void {
  if (boundaryDepth === 0) {
    // The update-notice probe is fire-and-forget and typically resolves between
    // boundaries (REPL bootstrap runs it long before the first cell arrives), so a
    // pending trailer belongs to the next flush and must survive the per-cell reset.
    const pendingNotice = noticeTrailer;
    resetSink();
    noticeTrailer = pendingNotice;
    boundaryCapture = capture || null;
    boundaryCapture?.clear();
  }
  boundaryDepth += 1;
}

/** Finish the active output boundary and flush or discard its output. */
export function finishOutputBoundary(
  stream: WritableLike,
  thrown: boolean,
): FlushResult {
  if (boundaryDepth > 0) {
    boundaryDepth -= 1;
    if (boundaryDepth > 0) {
      return { hardStop: hardStopMessage !== null, wrote: false };
    }
  }
  return flushSink(stream, thrown);
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
export function flushSink(stream: WritableLike, thrown: boolean): FlushResult {
  if (flushed) return { hardStop: hardStopMessage !== null, wrote: false };
  flushed = true;
  let wrote = false;
  const captured = boundaryCapture ? String(boundaryCapture.take() ?? "") : "";
  boundaryCapture = null;
  if (hardStopMessage !== null) {
    // Drop every buffered line — business logs, success rows, and the repeated error
    // echoes — so the owned guidance is all that remains.
    if (!thrown) {
      stream.write(
        hardStopMessage.endsWith("\n")
          ? hardStopMessage
          : `${hardStopMessage}\n`,
      );
      wrote = true;
    }
  } else {
    for (const chunk of buffer) {
      stream.write(chunk);
      wrote = true;
    }
    if (captured) {
      stream.write(captured);
      wrote = true;
    }
  }
  // The update hint is independent of the run's own output (and of a hard stop), so it
  // is appended last in every case — after the business output or the owned guidance.
  // Cleared once written: a long-lived REPL process flushes once per cell, and the
  // hint must not repeat as a footer on every subsequent cell.
  if (noticeTrailer !== null) {
    stream.write(
      noticeTrailer.endsWith("\n") ? noticeTrailer : `${noticeTrailer}\n`,
    );
    noticeTrailer = null;
    wrote = true;
  }
  const hardStop = hardStopMessage !== null;
  buffer = [];
  hardStopMessage = null;
  boundaryDepth = 0;
  return { hardStop, wrote };
}

/** Clear sink state. Real runs get a fresh process; this is only for in-process tests. */
export function resetSink(): void {
  buffer = [];
  hardStopMessage = null;
  noticeTrailer = null;
  flushed = false;
  boundaryDepth = 0;
  boundaryCapture = null;
}

export function isInsideOutputBoundary(): boolean {
  return boundaryDepth > 0;
}

export function outputCaptureFromTarget(
  target: Record<string, unknown>,
): OutputCapture | null {
  const capture = target.__egoNodeOutputCapture;
  if (
    capture &&
    typeof capture === "object" &&
    typeof (capture as OutputCapture).clear === "function" &&
    typeof (capture as OutputCapture).take === "function"
  ) {
    return capture as OutputCapture;
  }
  return null;
}

/**
 * Flush on process teardown for SDK hosts that run code directly and never call the
 * CLI `execute()` wrapper, so lifecycle events are our last-resort hook.
 *
 * A clean finish drains the event loop and reaches `beforeExit`; an uncaught async
 * rejection skips `beforeExit` but still reaches `exit` (`thrown: true`, so a hard stop
 * stays silent and lets the propagating Error surface the message). The stream still
 * accepts writes in both events, so the same `stream` serves both. Registered once.
 */
export function installLifecycleFlush(stream: WritableLike): void {
  if (lifecycleHooked) return;
  lifecycleHooked = true;
  process.on("beforeExit", () => flushSink(stream, false));
  process.on("exit", () => flushSink(stream, true));
}
