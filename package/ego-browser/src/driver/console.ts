import {
  drainConsoleMessages,
  waitForConsole as waitForConsoleMessage,
  type ConsoleMessage,
} from "../browser-runtime.js";

export function drainConsole() {
  return drainConsoleMessages();
}

export function waitForConsole(
  matcher?: string | RegExp | ((message: ConsoleMessage) => boolean),
  options?: { timeout?: number; type?: string },
) {
  return waitForConsoleMessage(matcher, options);
}
