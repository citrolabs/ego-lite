/**
 * Output sink for the agent-facing heredoc runtime.
 *
 * `console.log` is the only channel an agent reads (the runtime routes it here). An
 * owned hard stop can turn that channel into noise: a script that loops over work and
 * swallows each error (try/catch, `.catch()`) may print the same guidance on every
 * iteration, buried under its own business logging and success rows.
 *
 * To collapse that to one clean line we buffer console.log output instead of writing it
 * straight through. When a hard-stop error is born (see `buildEgoError` and the legacy
 * skill guard) we record its owned message once. At the end of the run we either:
 *   - a hard stop occurred -> discard the whole buffer and emit the owned message once
 *   - otherwise            -> flush the buffered output verbatim
 * and in both cases append the update-notice trailer (if any) last, so an out-of-band
 * "ego lite update available" hint reads as a footer after the command's own output.
 *
 * Buffering is the price of discarding pre-stop output: bytes already written cannot be
 * recalled, so nothing may be written until we know the run did not hard-stop. Each
 * heredoc runs in its own short-lived process, so this module state is per-run and needs
 * no cross-round reset; `resetSink()` exists only so in-process tests can reuse the run.
 */

type WritableLike = { write(chunk: string): unknown };

let buffer: string[] = [];
let hardStopMessage: string | null = null;
let noticeTrailer: string | null = null;
let flushed = false;
let lifecycleHooked = false;

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
  }
  // The update hint is independent of the run's own output (and of a hard stop), so it
  // is appended last in every case — after the business output or the owned guidance.
  if (noticeTrailer !== null) {
    stream.write(
      noticeTrailer.endsWith("\n") ? noticeTrailer : `${noticeTrailer}\n`,
    );
  }
  buffer = [];
}

/** Clear sink state. Real runs get a fresh process; this is only for in-process tests. */
export function resetSink(): void {
  buffer = [];
  hardStopMessage = null;
  noticeTrailer = null;
  flushed = false;
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
export function installLifecycleFlush(stream: WritableLike): void {
  if (lifecycleHooked) return;
  lifecycleHooked = true;
  process.on("beforeExit", () => flushSink(stream, false));
  process.on("exit", () => flushSink(stream, true));
}
