import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Who is opening this space.
 *
 * The panel's right-hand label mirrors the native Space category ("Personal",
 * "Work"). On a cue-managed machine the useful equivalent is the agent profile
 * that opened the space, so a glance at the overview answers "which of my agents
 * is doing this" rather than just "an agent is".
 *
 * Read at creation time, from the environment of the process that ran the
 * heredoc — the browser itself has no idea who is driving it.
 */

const RUNTIME_MARKER = "/.config/cue/runtime/";

/** cue launches its sessions against a per-profile runtime directory. */
function profileFromEnvironment() {
  for (const value of Object.values(process.env)) {
    if (typeof value !== "string") continue;
    const at = value.indexOf(RUNTIME_MARKER);
    if (at === -1) continue;
    const rest = value.slice(at + RUNTIME_MARKER.length);
    const name = rest.split("/")[0];
    if (name) return name;
  }
  return null;
}

/** Directories can pin a profile; walk up like cue itself does. */
function profileFromPinFile(startDir) {
  let dir = startDir;
  for (let depth = 0; depth < 12; depth += 1) {
    const pin = join(dir, ".cue.profile");
    if (existsSync(pin)) {
      try {
        const name = readFileSync(pin, "utf8").trim();
        if (name) return name;
      } catch {
        // unreadable pin is the same as no pin
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function agentIdentity(cwd = process.cwd()) {
  // The Spaces panel's own daemon inherits the environment of whichever session
  // happened to start it. A space you create by hand from the panel is yours,
  // not that profile's, so the daemon opts out of attribution entirely.
  if (process.env.EGO_LINUX_PANEL === "1") {
    return { profile: null, session: null };
  }
  const profile = profileFromEnvironment() || profileFromPinFile(cwd) || null;
  const session = process.env.CLAUDE_CODE_SESSION_ID || null;
  return {
    profile,
    // Enough to tell two concurrent sessions apart without being a wall of hex.
    session: session ? session.slice(0, 8) : null,
  };
}
