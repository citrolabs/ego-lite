import { createServer } from "node:http";

import { CURSOR_PROBE_EXPRESSION } from "./cursor.mjs";
import { SPACES_HTML } from "./spaces-ui.mjs";

/**
 * The Spaces overview.
 *
 * Upstream draws this inside the browser's own chrome, which a Chromium fork can
 * do and a stock Chromium cannot: Chrome 137 removed --load-extension, and the
 * CDP Extensions domain reports "Method not available", so nothing can inject UI
 * into the tab strip from outside. What is reachable is an --app window: no tab
 * strip, no toolbar, its own app_id — a standalone panel that behaves like part
 * of the browser.
 *
 * The server is the only source of truth's front door: it reads and writes the
 * same task-space state file the CLI uses, so the overview and the agent never
 * disagree about which spaces exist.
 */

const THUMBNAIL = {
  format: "jpeg",
  quality: 60,
};

/** How long after its last pointer event a space still counts as being worked in. */
const ACTIVE_WINDOW_MS = 30_000;

/** The crop used while an agent is active. Matches the card's 16/10 frame. */
const FOLLOW = { width: 760, aspect: 16 / 10 };

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

/** Where the agent's cursor is in this page, or null if none has acted here. */
async function readCursor(cdp, sessionId) {
  try {
    const { result } = await cdp.call(
      "Runtime.evaluate",
      { expression: CURSOR_PROBE_EXPRESSION, returnByValue: true },
      sessionId,
    );
    return result?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * A crop centred on the cursor, clamped to the visible viewport.
 *
 * A full-page thumbnail scaled into a ~294px card renders the cursor about five
 * pixels wide, which reads as "nothing is happening" even while the agent is
 * clicking. Cropping to where it is working makes the activity legible; the
 * clamp keeps the rect inside what captureBeyondViewport:false actually paints.
 */
function followClip(cursor) {
  const width = Math.min(FOLLOW.width, cursor.viewportWidth);
  const height = Math.min(width / FOLLOW.aspect, cursor.viewportHeight);
  const left = clamp(cursor.x - width / 2, 0, cursor.viewportWidth - width);
  const top = clamp(cursor.y - height / 2, 0, cursor.viewportHeight - height);
  // The overlay is viewport-fixed; the clip is in page coordinates.
  return {
    x: left + cursor.scrollX,
    y: top + cursor.scrollY,
    width,
    height,
    scale: 1,
  };
}

/**
 * Live frames, pushed rather than polled.
 *
 * captureScreenshot per poll cost four CDP round trips per space (attach, read
 * cursor, capture, detach) and could never show more than one frame per poll —
 * an agent's cursor jumped between stills instead of moving. Page.startScreencast
 * inverts it: Chrome sends a frame whenever the page changes, into a cache the
 * request path just reads.
 *
 * The cost is the crop. A screencast frame is the whole viewport, so the
 * cursor-following zoom moves to the client, which has the cursor position
 * anyway — see the transform in spaces-ui.mjs.
 */
const CAST = { format: "jpeg", quality: 55, maxWidth: 960, maxHeight: 600 };

function createCastPool(cdp) {
  const casts = new Map();
  // Opening is async, so two concurrent polls for the same tab would each find
  // no cast and each attach — the loser's session then leaks, attached and
  // acking frames nobody reads.
  const opening = new Map();
  let closed = false;

  cdp.onShimEvent("Page.screencastFrame", (params, sessionId) => {
    for (const cast of casts.values()) {
      if (cast.sessionId !== sessionId) continue;
      cast.frame = params.data || null;
      cast.seq += 1;
      break;
    }
    // Chrome stops sending frames until each one is acknowledged.
    cdp
      .call("Page.screencastFrameAck", { sessionId: params.sessionId }, sessionId)
      .catch(() => {});
  });

  async function open(targetId) {
    const { sessionId } = await cdp.call("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    cdp.claimSession(sessionId);
    if (closed) {
      // The pool was torn down while this attach was in flight. Registering it
      // now would leave a claimed session that nothing will ever detach.
      cdp.releaseSession(sessionId);
      cdp.call("Target.detachFromTarget", { sessionId }).catch(() => {});
      throw new Error("cast pool is closed");
    }
    const cast = { sessionId, frame: null, seq: 0 };
    casts.set(targetId, cast);
    try {
      await cdp.call("Page.startScreencast", { ...CAST, everyNthFrame: 1 }, sessionId);
    } catch (error) {
      // Leaving the entry behind would serve a blank card for as long as the tab
      // lives: every later poll finds it, skips open(), and reads a stream that
      // is not running.
      casts.delete(targetId);
      cdp.releaseSession(sessionId);
      cdp.call("Target.detachFromTarget", { sessionId }).catch(() => {});
      throw error;
    }
    // The first frame only arrives once the page next paints, which on a static
    // page can be never — so prime the cache with one shot rather than show an
    // empty card until something happens to move.
    try {
      const shot = await cdp.call(
        "Page.captureScreenshot",
        { format: CAST.format, quality: CAST.quality, captureBeyondViewport: false },
        sessionId,
      );
      if (shot.data && !cast.frame) cast.frame = shot.data;
    } catch {
      // The stream will fill it in as soon as the page paints.
    }
    return cast;
  }

  return {
    /** The newest frame for this tab, opening a stream for it on first ask. */
    async frameFor(targetId) {
      const existing = casts.get(targetId);
      if (existing) return existing;
      // Same contract for every caller: a broken stream yields null, never a
      // rejection a caller has to remember to catch.
      const inFlight = opening.get(targetId);
      if (inFlight) return inFlight.catch(() => null);

      const attempt = open(targetId).finally(() => opening.delete(targetId));
      opening.set(targetId, attempt);
      return attempt.catch(() => null);
    },

    sessionFor(targetId) {
      return casts.get(targetId)?.sessionId ?? null;
    },

    /** Tabs that went away take their stream with them. */
    async retain(liveTargetIds) {
      for (const [targetId, cast] of [...casts.entries()]) {
        if (liveTargetIds.has(targetId)) continue;
        casts.delete(targetId);
        cdp.releaseSession(cast.sessionId);
        await cdp.call("Target.detachFromTarget", { sessionId: cast.sessionId }).catch(() => {});
      }
    },

    closeAll() {
      closed = true;
      // Detach first. Releasing alone stops the shim claiming the session while
      // Chrome is still streaming to it, so every frame in flight is forwarded
      // to the harness — into the buffer drainEvents() hands to agents, which is
      // the exact leak the claim exists to prevent.
      for (const cast of casts.values()) {
        cdp.call("Target.detachFromTarget", { sessionId: cast.sessionId }).catch(() => {});
        cdp.releaseSession(cast.sessionId);
      }
      casts.clear();
    },
  };
}

async function captureCard(cdp, targetId, pool) {
  try {
    const cast = await pool.frameFor(targetId);
    if (!cast) return { thumbnail: null, activity: null, trail: [] };

    const cursor = await readCursor(cdp, cast.sessionId);
    const active = Boolean(cursor) && cursor.ageMs < ACTIVE_WINDOW_MS;
    return {
      thumbnail: cast.frame ? `data:image/jpeg;base64,${cast.frame}` : null,
      activity: active
        ? {
            name: cursor.name,
            label: cursor.label,
            ageMs: Math.round(cursor.ageMs),
            // Fractions of the viewport, so the card can zoom to the cursor
            // without the server cropping the frame.
            fx: cursor.viewportWidth ? cursor.x / cursor.viewportWidth : null,
            fy: cursor.viewportHeight ? cursor.y / cursor.viewportHeight : null,
          }
        : null,
      trail: cursor?.trail?.slice(-3).reverse() ?? [],
    };
  } catch {
    return { thumbnail: null, activity: null, trail: [] };
  }
}

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

/**
 * Start the overview server.
 * @param {object} shim The live ego shim (ego + cdp).
 * @returns {Promise<{port:number, close:() => void}>}
 */
export async function startSpacesServer(shim) {
  const { ego, cdp } = shim;
  const pool = createCastPool(cdp);

  const server = createServer(async (request, response) => {
    // Bound to loopback, but a page in the agent's own browser can still reach
    // it, so only same-origin callers get to act.
    const origin = request.headers.origin;
    if (origin && !origin.startsWith("http://127.0.0.1:")) {
      json(response, 403, { error: "cross-origin request refused" });
      return;
    }

    const url = new URL(request.url, "http://127.0.0.1");

    if (request.method === "GET" && url.pathname === "/") {
      const html = SPACES_HTML;
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(html),
      });
      response.end(html);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      json(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/spaces") {
      const { taskSpaces = [] } = await ego.listTaskSpaces();
      // Deliberately NOT ego.listTabs(): that is scoped to the selected space,
      // which is right for an agent (it should only see its own tabs) and wrong
      // for an overview of every space — every non-selected card would report
      // zero tabs, no title and no thumbnail. The panel needs the whole browser.
      const { targetInfos = [] } = await cdp.call("Target.getTargets");
      const byTarget = new Map(
        targetInfos
          .filter((target) => target.type === "page")
          .map((target) => [target.targetId, target]),
      );

      await pool.retain(new Set(byTarget.keys()));
      const spaces = await Promise.all(
        taskSpaces.map(async (space) => {
          const live = (space.targetIds || []).filter((id) => byTarget.has(id));
          const lead = live[0];
          const card = lead
            ? await captureCard(cdp, lead, pool)
            : { thumbnail: null, activity: null, trail: [] };
          return {
            id: space.id,
            name: space.name,
            ownership: space.ownership,
            profile: space.profile || null,
            session: space.session || null,
            tabCount: live.length,
            title: lead ? byTarget.get(lead).title : "",
            url: lead ? byTarget.get(lead).url : "",
            thumbnail: card.thumbnail,
            activity: card.activity,
            trail: card.trail,
          };
        }),
      );
      json(response, 200, { spaces });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/spaces") {
      const { name } = await readBody(request);
      const space = await ego.createTaskSpace(name || "new space");
      json(response, 200, { space });
      return;
    }

    // takeover / stop are the panel's half of the ownership handshake the
    // native app puts on its Space overlay: stop hands the space back to you
    // (the agent's cursor goes away), takeover claims it for the agent again.
    const match = /^\/api\/spaces\/(\d+)\/(use|close|stop|takeover)$/.exec(url.pathname);
    if (request.method === "POST" && match) {
      const id = Number(match[1]);
      if (match[2] === "use") {
        await ego.useTaskSpace(id);
      } else if (match[2] === "stop") {
        await ego.handOffTaskSpace(id);
      } else if (match[2] === "takeover") {
        await ego.takeOverTaskSpace(id);
      } else {
        await ego.closeTaskSpace(id);
      }
      json(response, 200, { done: true });
      return;
    }

    json(response, 404, { error: "not found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: () => {
      pool.closeAll();
      server.close();
    },
  };
}
