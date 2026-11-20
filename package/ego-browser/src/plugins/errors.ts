/**
 * Structured plugin failures. Every code carries the next step an Agent should
 * take, so a failed plugin call never leaves the Agent guessing whether to
 * retry, ask the user, or fall back to hand-written page code.
 */
export const PLUGIN_ERROR_CODES = [
  "INVALID_ARGS",
  "PLUGIN_NOT_FOUND",
  "PLUGIN_REVOKED",
  "PLUGIN_INSTALL_FAILED",
  "PLUGIN_BROKEN",
  "SITE_CHANGED",
  "NOT_LOGGED_IN",
  "RATE_LIMITED",
  "NOT_FOUND",
  "TIMEOUT",
] as const;

export type PluginErrorCode = (typeof PLUGIN_ERROR_CODES)[number];

const FALLBACK =
  "Fall back to page.snapshot() and hand-written page code for this task.";

const NEXT_STEPS: Record<PluginErrorCode, string> = {
  INVALID_ARGS: "Fix the arguments and call the plugin again.",
  PLUGIN_NOT_FOUND: `Run plugins(await page.url()) to list the plugins for this site, or ${lowerFirst(FALLBACK)}`,
  PLUGIN_REVOKED: `This plugin version was withdrawn and must not run. ${FALLBACK}`,
  PLUGIN_INSTALL_FAILED: `Retry later. ${FALLBACK}`,
  PLUGIN_BROKEN: `Do not retry. ${FALLBACK}`,
  SITE_CHANGED: `The site no longer matches this plugin and no fixed version is available yet. ${FALLBACK}`,
  NOT_LOGGED_IN:
    "Ask the user to sign in to the site in this task space (hand off with task.handOff()), then call the plugin again.",
  RATE_LIMITED:
    "The site is throttling requests. Wait a few minutes or reduce the limit, then retry.",
  NOT_FOUND:
    "The requested item does not exist on the site. Check the input with the user.",
  TIMEOUT: `Retry once with a smaller limit or a larger { timeout }. If it times out again, ${lowerFirst(FALLBACK)}`,
};

export class PluginError extends Error {
  readonly code: PluginErrorCode;
  readonly plugin?: string;
  readonly nextStep: string;
  readonly details?: unknown;

  constructor(
    code: PluginErrorCode,
    message: string,
    options: {
      plugin?: string;
      nextStep?: string;
      details?: unknown;
      cause?: unknown;
    } = {},
  ) {
    const nextStep = options.nextStep || NEXT_STEPS[code] || FALLBACK;
    const prefix = options.plugin ? `[${options.plugin}] ` : "";
    super(`${prefix}${code}: ${message}\nNext: ${nextStep}`, {
      cause: options.cause,
    });
    this.name = "PluginError";
    this.code = code;
    this.plugin = options.plugin;
    this.nextStep = nextStep;
    this.details = options.details;
  }
}

/** Re-label an error a plugin threw with the command that threw it. */
export function attributePluginError(
  error: unknown,
  plugin: string,
): PluginError {
  if (error instanceof PluginError) {
    if (error.plugin === plugin) return error;
    return new PluginError(error.code, stripDecorations(error.message), {
      plugin,
      nextStep: error.nextStep,
      details: error.details,
      cause: error.cause,
    });
  }
  // Plugins may throw plain errors carrying a known code, so they do not
  // need to import anything from the SDK.
  const code = (error as { code?: unknown })?.code;
  if (
    typeof code === "string" &&
    (PLUGIN_ERROR_CODES as readonly string[]).includes(code)
  ) {
    return new PluginError(
      code as PluginErrorCode,
      (error as Error).message || code,
      { plugin, cause: error },
    );
  }
  return new PluginError(
    "PLUGIN_BROKEN",
    `the plugin threw ${(error as Error)?.stack || String(error)}`,
    { plugin, cause: error },
  );
}

function stripDecorations(message: string): string {
  return message
    .replace(/^\[[^\]]+\] /, "")
    .replace(/^[A-Z_]+: /, "")
    .replace(/\nNext: [\s\S]*$/, "");
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
