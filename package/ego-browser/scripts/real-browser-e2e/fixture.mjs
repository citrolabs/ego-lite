import { createServer } from "node:http";

import { createDamaiRushRoutes } from "./damai-rush/fixture-routes.mjs";

export async function closeFixtureServer(fixtureServer) {
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1000);
    timer.unref?.();
    fixtureServer.close(() => {
      clearTimeout(timer);
      resolve();
    });
    fixtureServer.closeIdleConnections?.();
    fixtureServer.closeAllConnections?.();
  });
}

export async function startFixtureServer(taskName) {
  const handleDamaiRushRoute = createDamaiRushRoutes();
  const fixtureServer = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    try {
      if (await handleDamaiRushRoute(req, res, url)) return;
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
      } else {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("Internal Server Error");
      }
      return;
    }
    if (url.pathname === "/healthz") {
      res.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      });
      res.end(
        JSON.stringify({
          ok: true,
          taskName,
          fixture: "ego-browser-real-e2e",
          now: Date.now(),
        }),
      );
      return;
    }
    if (url.pathname === "/api/json") {
      res.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      });
      res.end(JSON.stringify({ ok: true, value: "json fixture" }));
      return;
    }
    if (url.pathname === "/api/text") {
      res.writeHead(200, {
        "content-type": "text/plain",
        "access-control-allow-origin": "*",
      });
      res.end("server text fixture");
      return;
    }
    if (url.pathname === "/api/header") {
      res.writeHead(200, {
        "content-type": "text/plain",
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
      });
      res.end(req.headers["x-e2e"] || "");
      return;
    }
    if (url.pathname === "/api/redirect") {
      res.writeHead(302, {
        location: "/api/text",
        "access-control-allow-origin": "*",
      });
      res.end();
      return;
    }
    if (url.pathname === "/api/echo") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        res.writeHead(200, {
          "content-type": "text/plain",
          "access-control-allow-origin": "*",
        });
        res.end(`echo:${req.method}:${body}`);
      });
      return;
    }
    if (url.pathname === "/api/error") {
      res.writeHead(500, {
        "content-type": "text/plain",
        "access-control-allow-origin": "*",
      });
      res.end("server error fixture");
      return;
    }
    if (url.pathname === "/api/slow") {
      const delayMs = Number(url.searchParams.get("ms") || 250);
      setTimeout(() => {
        res.writeHead(200, {
          "content-type": "text/plain",
          "access-control-allow-origin": "*",
        });
        res.end("slow fixture");
      }, delayMs);
      return;
    }
    if (url.pathname === "/api/status") {
      const code = Number(url.searchParams.get("code") || 200);
      res.writeHead(code, {
        "content-type": "text/plain",
        "access-control-allow-origin": "*",
      });
      res.end(`status ${code}`);
      return;
    }
    if (url.pathname === "/regression/delayed-asset.svg") {
      const delayMs = boundedDelay(url.searchParams.get("ms"), 1200);
      setTimeout(() => {
        res.writeHead(200, {
          "content-type": "image/svg+xml",
          "cache-control": "no-store",
        });
        res.end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#2457ff"/></svg>',
        );
      }, delayMs);
      return;
    }
    if (url.pathname === "/regression/slow-load") {
      const delayMs = boundedDelay(url.searchParams.get("ms"), 1200);
      res.writeHead(200, {
        "content-type": "text/html",
        "cache-control": "no-store",
      });
      res.end(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>slow load regression</title></head>
  <body>
    <h1>Slow load regression</h1>
    <img alt="delayed asset" src="/regression/delayed-asset.svg?ms=${delayMs}&nonce=${Date.now()}">
  </body>
</html>`);
      return;
    }
    if (url.pathname === "/api/bytes") {
      const n = Math.max(0, Number(url.searchParams.get("n") || 0));
      res.writeHead(200, {
        "content-type": "text/plain",
        "access-control-allow-origin": "*",
      });
      res.end("a".repeat(n));
      return;
    }
    if (url.pathname === "/download/sample.txt") {
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-disposition": 'attachment; filename="sample-download.txt"',
      });
      res.end("download fixture");
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "*",
      });
      res.end();
      return;
    }
    if (url.pathname === "/frame.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(pageHtml("frame"));
      return;
    }
    if (url.pathname === "/nav-target") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(pageHtml("nav-target"));
      return;
    }
    if (url.pathname === "/regression/slow-document") {
      const delayMs = boundedDelay(url.searchParams.get("ms"), 1200);
      res.writeHead(200, {
        "content-type": "text/html",
        "cache-control": "no-store",
      });
      res.flushHeaders?.();
      setTimeout(() => {
        res.end(
          "<!doctype html><html><head><title>slow document regression</title></head><body><h1>Ready</h1></body></html>",
        );
      }, delayMs);
      return;
    }
    if (url.pathname === "/secondary") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(pageHtml("secondary"));
      return;
    }
    if (url.pathname === "/slow-page") {
      const delayMs = Number(url.searchParams.get("ms") || 250);
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          "<!doctype html><html><head><title>slow page</title></head>" +
            '<body><h1 id="slow-marker">slow document loaded</h1></body></html>',
        );
      }, delayMs);
      return;
    }
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(pageHtml("home"));
  });

  await new Promise((resolve, reject) => {
    fixtureServer.once("error", reject);
    fixtureServer.listen(0, "127.0.0.1", () => resolve());
  });
  const address = fixtureServer.address();
  return {
    server: fixtureServer,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

function boundedDelay(raw, fallback) {
  const value = Number(raw ?? fallback);
  return Number.isFinite(value) ? Math.max(0, Math.min(value, 5000)) : fallback;
}

function pageHtml(kind) {
  const title =
    kind === "nav-target"
      ? "ego-lite nav target"
      : kind === "secondary"
        ? "ego-lite secondary"
        : kind === "frame"
          ? "ego-lite iframe"
          : "ego-lite helper e2e";
  const heading =
    kind === "nav-target"
      ? "Navigation target"
      : kind === "secondary"
        ? "Secondary tab"
        : kind === "frame"
          ? "Iframe fixture"
          : "Helper e2e fixture";

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>
      :root {
        --bg: #f5f6f8;
        --surface: #ffffff;
        --text: #1a1a2e;
        --text2: #6b7280;
        --border: #e2e5ea;
        --accent: #3b82f6;
        --accent-bg: #eff6ff;
        --green: #16a34a;
        --green-bg: #f0fdf4;
        --red: #dc2626;
        --purple-bg: #f5f3ff;
        --radius: 6px;
      }
      *, *::before, *::after { box-sizing: border-box; }
      body {
        font-family: system-ui, -apple-system, sans-serif;
        background: var(--bg);
        color: var(--text);
        margin: 0;
        padding: 10px 16px;
        line-height: 1.35;
        font-size: 13px;
      }
      main { max-width: 960px; }
      h1 { font-size: 1.1rem; font-weight: 700; margin: 0 0 2px; letter-spacing: -0.02em; }
      h2 { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text2); margin: 6px 0 2px; }
      [data-testid="status"] { color: var(--text2); font-size: 0.8rem; margin: 0 0 6px; }

      .card-row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 2px; }
      .card {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        padding: 6px 10px;
        margin-bottom: 4px;
      }

      /* Buttons */
      button, .btn {
        font: inherit; font-size: 0.8rem; font-weight: 500;
        padding: 4px 10px; border-radius: 5px;
        border: 1px solid var(--border); background: var(--surface);
        color: var(--text); cursor: pointer;
      }
      button:hover, .btn:hover { background: #f0f1f3; }
      .btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
      .btn-primary:hover { background: #2563eb; }
      #click-count {
        display: inline-flex; align-items: center; justify-content: center;
        min-width: 22px; height: 22px; padding: 0 6px;
        background: var(--accent-bg); color: var(--accent);
        border-radius: 11px; font-size: 0.8rem; font-weight: 600;
        margin-left: 6px;
      }
      .duplicate-action { margin-right: 3px; }

      /* Links */
      a { color: var(--accent); text-decoration: none; font-weight: 500; font-size: 0.8rem; }
      a:hover { text-decoration: underline; }

      /* Form controls */
      label { display: block; margin-bottom: 4px; font-size: 0.8rem; color: var(--text2); }
      label span { display: block; margin-bottom: 1px; font-weight: 500; font-size: 0.75rem; }
      input:not([type="checkbox"]):not([type="file"]), textarea, select {
        font: inherit; font-size: 0.8rem;
        padding: 3px 8px; border: 1px solid var(--border);
        border-radius: 4px; width: 100%; max-width: 220px;
        background: var(--surface); color: var(--text);
      }
      input:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent); }
      textarea { resize: vertical; min-height: 28px; height: 28px; }
      input[type="file"] { font-size: 0.75rem; }
      input[type="checkbox"] { margin-right: 4px; vertical-align: middle; }
      .form-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-end; }
      .form-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }

      /* Interaction zones */
      .zone {
        display: inline-flex; align-items: center; justify-content: center;
        padding: 6px 14px; border: 2px dashed var(--border);
        border-radius: var(--radius); font-size: 0.8rem; color: var(--text2);
        user-select: none;
      }
      #hover-zone { width: 100px; height: 36px; }
      #hover-zone:hover { border-color: var(--accent); background: var(--accent-bg); }
      #drag-source, #drag-target {
        width: 100px; height: 36px; margin: 2px;
      }
      #drag-source { border-style: solid; cursor: grab; }
      #drag-source:active { cursor: grabbing; }
      #drag-target { background: var(--green-bg); border-color: var(--green); }
      .drag-row { display: flex; align-items: center; gap: 6px; }
      .drag-arrow { color: var(--text2); font-size: 1rem; }

      /* Context menu zone */
      #context-menu-zone {
        background: var(--purple-bg);
        border-color: #a78bfa; width: 100px; height: 36px;
      }

      /* Rich editor */
      #rich-editor {
        border: 1px solid var(--border); border-radius: 4px;
        min-height: 28px; padding: 4px 8px; width: 100%; max-width: 220px;
        font-size: 0.8rem;
      }
      #rich-editor:focus { outline: none; border-color: var(--accent); }

      /* Dynamic DOM */
      .dynamic-actions { display: flex; gap: 4px; }
      #dynamic-container { min-height: 4px; margin-top: 4px; }
      #dynamic-element {
        display: inline-block; background: var(--green-bg);
        border: 1px solid var(--green); border-radius: 4px;
        padding: 2px 8px; font-size: 0.8rem; color: var(--green);
      }

      /* Canvas */
      #draw-canvas {
        border: 1px solid var(--border); border-radius: var(--radius);
        cursor: crosshair; display: block; background: #fff;
      }

      /* HTML5 DnD */
      #dnd-source {
        width: 80px; height: 34px;
        background: var(--accent-bg); border: 2px solid var(--accent);
        border-radius: var(--radius); display: inline-flex;
        align-items: center; justify-content: center;
        font-size: 0.8rem; font-weight: 500; color: var(--accent);
        cursor: grab; margin: 2px;
      }
      #dnd-source:active { cursor: grabbing; }
      #dnd-target {
        width: 100px; height: 34px;
        background: var(--green-bg); border: 2px dashed var(--green);
        border-radius: var(--radius); display: inline-flex;
        align-items: center; justify-content: center;
        font-size: 0.8rem; font-weight: 500; color: var(--green);
        margin: 2px;
      }
      #dnd-target.drag-over { background: #dcfce7; border-style: solid; }
      .dnd-row { display: flex; align-items: center; gap: 8px; }

      /* Pointer events area */
      #pointer-area {
        width: 100%; height: 70px;
        border: 1px solid var(--border); border-radius: var(--radius);
        background: #fafbfc; position: relative;
        display: flex; align-items: center; justify-content: center;
        font-size: 0.8rem; color: var(--text2);
        touch-action: none;
      }
      #pointer-area .pointer-indicator {
        position: absolute; width: 6px; height: 6px;
        border-radius: 50%; background: var(--accent);
        transform: translate(-50%, -50%); pointer-events: none;
        opacity: 0;
      }

      /* Tab trap */
      #tab-trap { display: flex; gap: 4px; }
      .tab-stop {
        border: 1px solid var(--border); border-radius: 4px;
        display: inline-block; padding: 3px 10px;
        font-size: 0.8rem; cursor: pointer;
      }
      .tab-stop:focus { outline: none; border-color: var(--accent); background: var(--accent-bg); }

      /* Scroll areas */
      #inner-scroll {
        border: 1px solid var(--border); border-radius: var(--radius);
        height: 80px; margin-top: 4px; overflow: auto; width: 220px;
      }
      #inner-scroll-content { height: 620px; padding-top: 520px; font-size: 0.8rem; color: var(--text2); }
      #scroll-area { height: 1800px; padding-top: 16px; }
      #bottom-marker { margin-top: 1450px; font-size: 0.8rem; color: var(--text2); }

      /* Utility */
      #delayed { display: none; }
      #never-visible { display: none; }
      #file-name, #key-log { font-size: 0.75rem; color: var(--text2); margin: 2px 0; min-height: 1em; }
      #controlled-state { font-size: 0.75rem; color: var(--text2); margin-left: 6px; }
      #dnd-status, #pointer-log { font-size: 0.75rem; color: var(--text2); margin-top: 2px; }
      iframe { display: none; }
    </style>
  </head>
  <body>
    <main>
      <h1>${heading}</h1>
      <p data-testid="status">ready</p>

      <div class="card">
        <button id="click-button" class="btn-primary" aria-label="Increment counter" title="Counter button">Click counter</button>
        <span id="click-count">0</span>
        <button class="duplicate-action" type="button">Duplicate action</button>
        <button class="duplicate-action" type="button">Duplicate action</button>
        <a id="nav-link" href="/nav-target" style="margin-left:8px">Go to nav target</a>
        <a id="download-link" href="/download/sample.txt" download style="margin-left:8px">Download sample</a>
        <div id="home-type-listbox" role="listbox" aria-label="Home type" style="display:inline-flex;gap:6px;margin-left:8px">
          <button id="house-option-primary" type="button" role="option" aria-selected="false">House</button>
          <button id="house-option-secondary" type="button" role="option" aria-selected="false">House</button>
          <!-- Hidden responsive-variant dupe: visible to a naive DOM role scan, ignored by the AX tree. -->
          <button id="house-option-hidden" type="button" role="option" aria-selected="false" style="display:none">House</button>
        </div>
      </div>

      <div class="card-row">
        <div>
          <h2>Pointer &amp; Mouse</h2>
          <div class="card">
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <div id="hover-zone" class="zone">Hover zone</div>
              <div id="context-menu-zone" class="zone">Right-click here</div>
            </div>
            <div class="drag-row" style="margin-top:4px">
              <div id="drag-source" class="zone">Drag source</div>
              <span class="drag-arrow">&rarr;</span>
              <div id="drag-target" class="zone">Drag target</div>
            </div>
          </div>
        </div>
        <div>
          <h2>HTML5 Drag &amp; Drop</h2>
          <div class="card">
            <div class="dnd-row">
              <div id="dnd-source" draggable="true">Drag me</div>
              <span class="drag-arrow">&rarr;</span>
              <div id="dnd-target">Drop here</div>
            </div>
            <div id="dnd-status">Awaiting drag</div>
          </div>
          <h2>Pointer Events</h2>
          <div class="card">
            <div id="pointer-area">
              <span class="pointer-label">Move pointer here</span>
              <div class="pointer-indicator"></div>
            </div>
            <div id="pointer-log">No events</div>
          </div>
        </div>
      </div>

      <div class="card-row">
        <div>
          <h2>Form Inputs</h2>
          <div class="card">
            <div class="form-cols">
              <label><span>Text input</span><input id="text-input" placeholder="Type text" value="initial"></label>
              <label><span>Append input</span><input id="append-input" value="base"></label>
            </div>
            <label><span>Text area</span><textarea id="text-area">seed</textarea></label>
            <div class="form-row">
              <label style="flex:1;max-width:160px"><span>Dropdown</span><select id="dropdown">
                <option value="alpha">Alpha</option>
                <option value="beta">Beta</option>
                <option value="gamma">Gamma</option>
              </select></label>
              <label style="margin-bottom:0"><input type="checkbox" id="checkbox"> Toggle</label>
            </div>
            <label><span>File input</span><input id="file-input" type="file" multiple></label>
            <div id="file-name"></div>
            <div id="key-log"></div>
          </div>
        </div>
        <div>
          <h2>Rich Text &amp; Dynamic DOM</h2>
          <div class="card">
            <img id="alt-logo" alt="Ego fixture logo" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" style="width:1px;height:1px;opacity:0" />
            <label><span>Content editable</span><div id="rich-editor" contenteditable="true">edit me</div></label>
            <div class="dynamic-actions">
              <button id="add-element" type="button">Add element</button>
              <button id="remove-element" type="button">Remove element</button>
            </div>
            <div id="dynamic-container"></div>
          </div>
        </div>
      </div>

      <div class="card-row">
        <div>
          <h2>Canvas Drawing</h2>
          <div class="card">
            <canvas id="draw-canvas" width="300" height="150"></canvas>
          </div>
        </div>
        <div>
          <h2>Advanced</h2>
          <div class="card">
            <div class="form-cols">
              <label><span>Email</span><input id="email-input" type="email" value="old@example.com"></label>
              <label><span>Number</span><input id="number-input" type="number" value="123"></label>
            </div>
            <label style="display:flex;align-items:center;gap:6px"><span style="margin:0">Controlled</span><input id="controlled-input" type="text" style="flex:1;max-width:160px"><span id="controlled-state"></span></label>
            <div id="tab-trap">
              <span class="tab-stop" tabindex="0" data-tab="first">First</span>
              <span class="tab-stop" tabindex="0" data-tab="second">Second</span>
              <span class="tab-stop" tabindex="0" data-tab="third">Third</span>
            </div>
          </div>
        </div>
      </div>

      <div id="delayed">Delayed element</div>
      <div id="never-visible">Never visible</div>
      <iframe id="fixture-frame" src="/frame.html"></iframe>
      <div id="inner-scroll"><div id="inner-scroll-content">Inner scroll marker</div></div>
      <section id="scroll-area"><div id="bottom-marker">Bottom marker</div></section>

      <!-- Kept below #scroll-area: new nodes above it shift the page and break the wheel cases. -->
      <div id="controlled-checkable">
        <label><input type="checkbox" id="controlled-checkbox"> Nonstop only</label>
        <label><input type="radio" name="controlled-plan" id="controlled-radio-basic" value="basic"> Plan basic</label>
        <label><input type="radio" name="controlled-plan" id="controlled-radio-pro" value="pro"> Plan pro</label>
      </div>

      ${kind === "frame" ? '<div id="iframe-marker" data-iframe="true" style="border:2px solid var(--accent);padding:4px 8px;margin-top:4px;border-radius:4px;font-size:0.8rem">iframe target</div>' : ""}
    </main>
    <script>
      window.__fixtureState = {
        clicks: 0,
        doubleClicks: 0,
        dragged: false,
        hovered: false,
        keyEvents: [],
        keys: [],
        lastClickDetail: 0,
        lastDoubleClickDetail: 0,
        pointerEvents: [],
        rightClicked: false,
        dynamicElementExists: false,
        tabOrder: [],
        checkboxChecked: false,
        controlledChecked: false,
        controlledChanges: 0,
        controlledPlan: "",
        controlledPlanChanges: 0,
        dropdownValue: "alpha",
        valueEvents: {},
        canvasStrokes: 0,
        canvasPoints: 0,
        canvasDrawing: false,
        canvasLastPoint: null,
        /* HTML5 DnD */
        dndDropped: false,
        dndData: "",
        /* Pointer Events API */
        pointerEventTypes: [],
        pointerDownCount: 0,
        pointerMoveCount: 0,
        lastPointerType: "",
        lastPointerPressure: 0,
      };

      /* ---- click / dblclick tracking ---- */
      const count = document.querySelector("#click-count");
      const clickButton = document.querySelector("#click-button");
      for (const type of ["mousemove", "mousedown", "mouseup", "click", "dblclick"]) {
        document.addEventListener(type, (event) => {
          window.__fixtureState.pointerEvents.push({
            type, target: event.target.id || event.target.tagName,
            detail: event.detail, x: event.clientX, y: event.clientY,
          });
        }, true);
      }
      clickButton.addEventListener("click", (event) => {
        window.__fixtureState.clicks += 1;
        window.__fixtureState.lastClickDetail = event.detail;
        count.textContent = String(window.__fixtureState.clicks);
      });
      clickButton.addEventListener("dblclick", (event) => {
        window.__fixtureState.doubleClicks += 1;
        window.__fixtureState.lastDoubleClickDetail = event.detail;
      });

      for (const option of document.querySelectorAll("#home-type-listbox [role=option]")) {
        option.addEventListener("click", () => {
          for (const peer of document.querySelectorAll("#home-type-listbox [role=option]")) {
            peer.setAttribute("aria-selected", String(peer === option));
          }
        });
      }

      /* ---- hover zone ---- */
      for (const type of ["mousemove", "mouseover"]) {
        document.querySelector("#hover-zone").addEventListener(type, () => {
          window.__fixtureState.hovered = true;
        });
      }

      /* ---- mouse-based drag (legacy) ---- */
      let dragging = false;
      document.querySelector("#drag-source").addEventListener("mousedown", () => { dragging = true; });
      document.querySelector("#drag-target").addEventListener("mouseup", () => {
        if (dragging) window.__fixtureState.dragged = true;
        dragging = false;
      });

      /* ---- keyboard tracking ---- */
      document.querySelector("#text-input").addEventListener("keydown", (event) => {
        window.__fixtureState.keys.push(event.key);
        window.__fixtureState.keyEvents.push({ type: event.type, key: event.key, value: event.target.value });
        document.querySelector("#key-log").textContent = window.__fixtureState.keys.join(",");
      });
      for (const type of ["beforeinput", "input", "keyup"]) {
        document.querySelector("#text-input").addEventListener(type, (event) => {
          window.__fixtureState.keyEvents.push({ type, key: event.key || event.inputType || "", value: event.target.value });
        });
      }

      /* ---- file input ---- */
      document.querySelector("#file-input").addEventListener("change", (event) => {
        document.querySelector("#file-name").textContent =
          Array.from(event.target.files).map((file) => file.name).join(",");
      });

      /* ---- value inputs (email/number) ---- */
      for (const id of ["email-input", "number-input"]) {
        const valueInput = document.querySelector("#" + id);
        for (const type of ["input", "change"]) {
          valueInput.addEventListener(type, () => {
            (window.__fixtureState.valueEvents[id] ||= []).push(type);
          });
        }
      }

      /* ---- react-style controlled input ---- */
      (function () {
        const el = document.querySelector("#controlled-input");
        const stateEl = document.querySelector("#controlled-state");
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        let state = "";
        function render() { if (el.value !== state) setter.call(el, state); stateEl.textContent = state; }
        el.addEventListener("input", () => { state = el.value; render(); });
        el.addEventListener("change", () => { stateEl.textContent = state + " (change)"; });
        render();
      })();

      /* ---- react-style controlled checkbox / radio ----
         Mirrors React's input value tracker: writing the checked property runs the
         instance setter, which records the new value, so the event that follows
         looks like a no-op and the state never advances. A real click sets
         checkedness internally and bypasses the setter, so the tracker still sees
         a change. React derives checkbox/radio onChange from the click event, so
         this listens there too. */
      (function () {
        const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
        function track(node) {
          let tracked = String(native.get.call(node));
          Object.defineProperty(node, "checked", {
            configurable: true,
            get() { return native.get.call(this); },
            set(value) { tracked = String(value); native.set.call(this, value); },
          });
          return {
            changed() {
              const next = String(native.get.call(node));
              if (next === tracked) return false;
              tracked = next;
              return true;
            },
            sync(value) { tracked = String(value); native.set.call(node, value); },
          };
        }

        const box = document.querySelector("#controlled-checkbox");
        const boxTracker = track(box);
        function renderBox(checked) {
          window.__fixtureState.controlledChecked = checked;
          boxTracker.sync(checked);
        }
        box.addEventListener("click", () => {
          if (!boxTracker.changed()) return;
          window.__fixtureState.controlledChanges += 1;
          renderBox(native.get.call(box));
        });
        renderBox(false);

        const radios = Array.from(document.querySelectorAll("input[name='controlled-plan']"));
        const radioTrackers = new Map(radios.map((radio) => [radio, track(radio)]));
        function renderPlan(plan) {
          window.__fixtureState.controlledPlan = plan;
          for (const radio of radios) radioTrackers.get(radio).sync(radio.value === plan);
        }
        for (const radio of radios) {
          radio.addEventListener("click", () => {
            if (!radioTrackers.get(radio).changed()) return;
            window.__fixtureState.controlledPlanChanges += 1;
            renderPlan(radio.value);
          });
        }
        renderPlan("");
      })();

      /* ---- context menu ---- */
      document.querySelector("#context-menu-zone").addEventListener("contextmenu", (event) => {
        event.preventDefault();
        window.__fixtureState.rightClicked = true;
      });

      /* ---- dynamic DOM ---- */
      document.querySelector("#add-element").addEventListener("click", () => {
        const container = document.querySelector("#dynamic-container");
        if (!document.querySelector("#dynamic-element")) {
          const el = document.createElement("div");
          el.id = "dynamic-element";
          el.setAttribute("role", "status");
          el.textContent = "Dynamic!";
          el.style.cssText = "";
          container.appendChild(el);
          window.__fixtureState.dynamicElementExists = true;
        }
      });
      document.querySelector("#remove-element").addEventListener("click", () => {
        const el = document.querySelector("#dynamic-element");
        if (el) { el.remove(); window.__fixtureState.dynamicElementExists = false; }
      });

      /* ---- checkbox / dropdown ---- */
      document.querySelector("#checkbox").addEventListener("change", (event) => {
        window.__fixtureState.checkboxChecked = event.target.checked;
      });
      document.querySelector("#dropdown").addEventListener("change", (event) => {
        window.__fixtureState.dropdownValue = event.target.value;
      });

      /* ---- tab-trap focus tracking ---- */
      for (const stop of document.querySelectorAll(".tab-stop")) {
        stop.addEventListener("focus", () => {
          window.__fixtureState.tabOrder.push(stop.dataset.tab);
        });
      }

      /* ---- delayed element ---- */
      setTimeout(() => {
        const delayed = document.querySelector("#delayed");
        delayed.style.display = "block";
      }, 350);

      /* ---- canvas drawing ---- */
      (function () {
        const canvas = document.querySelector("#draw-canvas");
        const ctx = canvas.getContext("2d");
        ctx.strokeStyle = "#000"; ctx.lineWidth = 2; ctx.lineCap = "round";
        canvas.addEventListener("mousedown", (e) => {
          const rect = canvas.getBoundingClientRect();
          const x = e.clientX - rect.left, y = e.clientY - rect.top;
          ctx.beginPath(); ctx.moveTo(x, y);
          window.__fixtureState.canvasDrawing = true;
          window.__fixtureState.canvasStrokes++;
          window.__fixtureState.canvasPoints++;
          window.__fixtureState.canvasLastPoint = { x, y };
        });
        canvas.addEventListener("mousemove", (e) => {
          if (!window.__fixtureState.canvasDrawing) return;
          const rect = canvas.getBoundingClientRect();
          const x = e.clientX - rect.left, y = e.clientY - rect.top;
          ctx.lineTo(x, y); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(x, y);
          window.__fixtureState.canvasPoints++;
          window.__fixtureState.canvasLastPoint = { x, y };
        });
        canvas.addEventListener("mouseup", () => { window.__fixtureState.canvasDrawing = false; });
      })();

      /* ---- HTML5 Drag and Drop ---- */
      (function () {
        const source = document.querySelector("#dnd-source");
        const target = document.querySelector("#dnd-target");
        const status = document.querySelector("#dnd-status");
        source.addEventListener("dragstart", (e) => {
          e.dataTransfer.setData("text/plain", "dnd-payload");
          e.dataTransfer.effectAllowed = "move";
          status.textContent = "Dragging...";
        });
        target.addEventListener("dragover", (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          target.classList.add("drag-over");
        });
        target.addEventListener("dragleave", () => { target.classList.remove("drag-over"); });
        target.addEventListener("drop", (e) => {
          e.preventDefault();
          target.classList.remove("drag-over");
          const data = e.dataTransfer.getData("text/plain");
          window.__fixtureState.dndDropped = true;
          window.__fixtureState.dndData = data;
          status.textContent = "Dropped: " + data;
          target.textContent = "Dropped!";
        });
        source.addEventListener("dragend", () => {
          if (!window.__fixtureState.dndDropped) status.textContent = "Drag cancelled";
        });
      })();

      /* ---- Pointer Events API ---- */
      (function () {
        const area = document.querySelector("#pointer-area");
        const indicator = area.querySelector(".pointer-indicator");
        const log = document.querySelector("#pointer-log");
        for (const type of ["pointerdown", "pointermove", "pointerup", "pointerenter", "pointerleave", "pointercancel"]) {
          area.addEventListener(type, (e) => {
            window.__fixtureState.pointerEventTypes.push(type);
            if (type === "pointerdown") window.__fixtureState.pointerDownCount++;
            if (type === "pointermove") {
              window.__fixtureState.pointerMoveCount++;
              const rect = area.getBoundingClientRect();
              indicator.style.left = (e.clientX - rect.left) + "px";
              indicator.style.top = (e.clientY - rect.top) + "px";
              indicator.style.opacity = "1";
            }
            if (type === "pointerleave") indicator.style.opacity = "0";
            window.__fixtureState.lastPointerType = e.pointerType;
            window.__fixtureState.lastPointerPressure = e.pressure;
            log.textContent = type + " (" + e.pointerType + ") p=" + e.pressure.toFixed(2);
          });
        }
      })();
    </script>
  </body>
</html>`;
}
