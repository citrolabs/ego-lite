import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

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
  // Source: https://cdn.openai.com/papers/gpt-4-system-card.pdf
  const pdfFixture = await readFile(
    new URL("./fixtures/openai-gpt-4-system-card.pdf", import.meta.url),
  );
  let crossSiteBaseUrl = "";
  const fixtureServer = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
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
    if (url.pathname === "/api/download") {
      const requestedSpace = url.searchParams.get("space");
      const space =
        requestedSpace === "first" || requestedSpace === "second"
          ? requestedSpace
          : undefined;
      const body = space
        ? `ego-browser ${space} TaskSpace download\n`
        : "ego-browser download fixture\n";
      const filename = space ? `ego-${space}-download.txt` : "ego-download.txt";
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-length": Buffer.byteLength(body),
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }
    if (url.pathname === "/api/openai-gpt-4-system-card.pdf") {
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-length": pdfFixture.length,
        "content-disposition":
          'inline; filename="openai-gpt-4-system-card.pdf"',
        "cache-control": "no-store",
      });
      res.end(pdfFixture);
      return;
    }
    if (url.pathname === "/api/image.png") {
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      );
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": png.length,
        "access-control-allow-origin": "*",
      });
      res.end(png);
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
    if (url.pathname === "/redirect/favicon.ico") {
      res.writeHead(302, {
        location: "/api/slow?ms=2000&case=favicon-redirect",
        "cache-control": "no-store",
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
          "cache-control": "no-store",
        });
        res.end(`echo:${req.method}:${body}`);
      });
      return;
    }
    if (url.pathname === "/api/request-info") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        res.writeHead(201, {
          "content-type": "application/json",
          "x-fixture-response": "page-fetch",
        });
        res.end(
          JSON.stringify({
            method: req.method,
            path: url.pathname,
            cookie: req.headers.cookie || "",
            origin: req.headers.origin || "",
            requestHeader: req.headers["x-page-fetch"] || "",
            body,
          }),
        );
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
          "cache-control": "no-store",
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
    if (url.pathname === "/api/bytes") {
      const n = Math.max(0, Number(url.searchParams.get("n") || 0));
      res.writeHead(200, {
        "content-type": "text/plain",
        "access-control-allow-origin": "*",
      });
      res.end("a".repeat(n));
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
      res.end(pageHtml("frame", { iframeUrl: null }));
      return;
    }
    if (url.pathname === "/slow-frame") {
      const delayMs = Number(url.searchParams.get("ms") || 800);
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html>
        <html>
          <head><title>Slow OOPIF fixture</title></head>
          <body>
            <h1>Slow OOPIF</h1>
            <img src="/api/slow?ms=${delayMs}" alt="slow OOPIF resource">
          </body>
        </html>`);
      return;
    }
    if (url.pathname === "/nav-target") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(pageHtml("nav-target"));
      return;
    }
    if (url.pathname === "/secondary") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(pageHtml("secondary"));
      return;
    }
    if (url.pathname === "/download-entry") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html>
        <html>
          <head><title>Download entry</title></head>
          <body>
            <a href="/api/openai-gpt-4-system-card.pdf" target="_blank">Preview report</a>
          </body>
        </html>`);
      return;
    }
    if (url.pathname === "/same-origin-frame") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(pageHtml("home", { iframeUrl: "/frame.html" }));
      return;
    }
    if (url.pathname === "/oopif-network") {
      const delayMs = Number(url.searchParams.get("ms") || 800);
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        pageHtml("home", {
          iframeUrl: `${crossSiteBaseUrl}/slow-frame?ms=${delayMs}`,
        }),
      );
      return;
    }
    if (url.pathname === "/visual") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(visualPageHtml());
      return;
    }
    if (url.pathname === "/pointer-workbench") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(pointerWorkbenchHtml());
      return;
    }
    if (url.pathname === "/media-workbench") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(mediaWorkbenchHtml());
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
    if (url.pathname === "/streamed-page") {
      const delayMs = Number(url.searchParams.get("ms") || 1000);
      res.writeHead(200, { "content-type": "text/html" });
      res.write(`<!doctype html><html><head><title>Streamed fixture</title></head>
        <body><h1 id="commit-marker">document committed</h1>
        <script>document.documentElement.dataset.committed = "true";</script>`);
      setTimeout(() => {
        res.end("</body></html>");
      }, delayMs);
      return;
    }
    if (url.pathname === "/domcontentloaded-page") {
      const delayMs = Number(url.searchParams.get("ms") || 1500);
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html>
        <html>
          <head><title>DOMContentLoaded fixture</title></head>
          <body>
            <h1 id="dcl-marker">parsed before slow image</h1>
            <img src="/api/slow?ms=${delayMs}" alt="slow resource">
            <script>
              addEventListener("DOMContentLoaded", () => {
                document.documentElement.dataset.domContentLoaded = "true";
              });
            </script>
          </body>
        </html>`);
      return;
    }
    if (url.pathname === "/favicon-redirect-page") {
      res.writeHead(200, {
        "content-type": "text/html",
        "cache-control": "no-store",
      });
      res.end(`<!doctype html>
        <html>
          <head>
            <title>Favicon redirect fixture</title>
            <link rel="icon" href="/redirect/favicon.ico">
          </head>
          <body><h1>Favicon redirect fixture</h1></body>
        </html>`);
      return;
    }
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(pageHtml("home", { iframeUrl: `${crossSiteBaseUrl}/frame.html` }));
  });

  await new Promise((resolve, reject) => {
    fixtureServer.once("error", reject);
    fixtureServer.listen(0, "127.0.0.1", () => resolve());
  });
  const address = fixtureServer.address();
  crossSiteBaseUrl = `http://localhost:${address.port}`;
  return {
    server: fixtureServer,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

function pageHtml(kind, { iframeUrl = "/frame.html" } = {}) {
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
      body { font-family: system-ui, sans-serif; margin: 24px; }
      button, input { font: inherit; }
      #hover-zone, #drag-source, #drag-target {
        align-items: center;
        border: 1px solid #777;
        display: inline-flex;
        height: 64px;
        justify-content: center;
        margin: 8px;
        width: 160px;
      }
      #drag-target { background: #eef7ee; }
      #rich-editor {
        border: 1px solid #777;
        min-height: 48px;
        padding: 8px;
        width: 320px;
      }
      #context-menu-zone {
        align-items: center;
        background: #f7eef7;
        border: 1px dashed #777;
        display: inline-flex;
        height: 48px;
        justify-content: center;
        margin: 8px;
        width: 160px;
      }
      #dynamic-container { min-height: 24px; margin: 8px 0; }
      .tab-stop {
        border: 1px solid #999;
        display: inline-block;
        margin: 4px;
        padding: 4px 12px;
      }
      .tab-stop:focus { outline: 2px solid #44f; }
      #inner-scroll {
        border: 1px solid #777;
        height: 120px;
        margin-top: 12px;
        overflow: auto;
        width: 320px;
      }
      #inner-scroll-content { height: 620px; padding-top: 520px; }
      #scroll-area { height: 1800px; padding-top: 16px; }
      #bottom-marker { margin-top: 1450px; }
      #delayed { display: none; }
    </style>
  </head>
  <body>
    <main>
      <h1>${heading}</h1>
      <p data-testid="status">ready</p>
      <button id="click-button" aria-label="Increment counter">Click counter</button>
      <button class="duplicate-action" type="button">Duplicate action</button>
      <button class="duplicate-action" type="button">Duplicate action</button>
      <a id="nav-link" href="/nav-target">Go to nav target</a>
      <span id="click-count">0</span>
      <div id="hover-zone">Hover zone</div>
      <div id="drag-source">Drag source</div>
      <div id="drag-target">Drag target</div>
      <label>Text input <input id="text-input" value="initial"></label>
      <label>Append input <input id="append-input" value="base"></label>
      <label>Text area <textarea id="text-area">seed</textarea></label>
      <label for="file-input">File input</label>
      <input id="file-input" type="file" multiple hidden>
      <button id="dynamic-file-button" type="button">Choose files dynamically</button>
      <div id="dynamic-file-container"></div>
      <div id="file-name"></div>
      <div id="key-log"></div>
      <label>Dropdown <select id="dropdown">
        <option value="alpha">Alpha</option>
        <option value="beta">Beta</option>
        <option value="gamma">Gamma</option>
      </select></label>
      <label><input type="checkbox" id="checkbox"> Toggle checkbox</label>
      <div id="rich-editor" contenteditable="true">edit me</div>
      <div id="context-menu-zone">Right-click here</div>
      <button id="add-element" type="button">Add element</button>
      <button id="remove-element" type="button">Remove element</button>
      <div id="dynamic-container"></div>
      <div id="tab-trap">
        <span class="tab-stop" tabindex="0" data-tab="first">First</span>
        <span class="tab-stop" tabindex="0" data-tab="second">Second</span>
        <span class="tab-stop" tabindex="0" data-tab="third">Third</span>
      </div>
      <div id="delayed">Delayed element</div>
      <div id="never-visible" style="display:none">Never visible</div>
      ${iframeUrl ? `<iframe id="fixture-frame" src="${iframeUrl}"></iframe>` : ""}
      <div id="inner-scroll"><div id="inner-scroll-content">Inner scroll marker</div></div>
      <section id="scroll-area"><div id="bottom-marker">Bottom marker</div></section>
      <label>Email input <input id="email-input" type="email" value="old@example.com"></label>
      <label>Number input <input id="number-input" type="number" value="123"></label>
      <label>Controlled input <input id="controlled-input" type="text"></label>
      <span id="controlled-state"></span>
      <shadow-fixture id="shadow-fixture"></shadow-fixture>
      ${kind === "frame" ? '<div id="iframe-marker" data-iframe="true" style="border:2px solid #44f;padding:8px;margin-top:8px;">iframe target</div>' : ""}
      ${kind === "frame" ? '<button id="iframe-action" type="button" aria-label="Run iframe action">Run iframe action</button><label>Iframe field <input id="iframe-field" aria-label="Iframe field"></label><span id="iframe-result">idle</span>' : ""}
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
        dropdownValue: "alpha",
        valueEvents: {},
      };
      const iframeAction = document.querySelector("#iframe-action");
      iframeAction?.addEventListener("click", (event) => {
        document.querySelector("#iframe-result").textContent =
          "clicked:" + String(event.isTrusted);
      });
      const shadowHost = document.querySelector("#shadow-fixture");
      const shadowRoot = shadowHost.attachShadow({ mode: "open" });
      const nestedHost = document.createElement("nested-shadow-fixture");
      shadowRoot.append(nestedHost);
      const nestedShadowRoot = nestedHost.attachShadow({ mode: "open" });
      const shadowInput = document.createElement("input");
      shadowInput.setAttribute("aria-label", "Shadow field");
      shadowRoot.prepend(shadowInput);
      const shadowButton = document.createElement("button");
      shadowButton.id = "shadow-action";
      shadowButton.textContent = "Shadow action";
      shadowButton.addEventListener("click", () => {
        shadowButton.dataset.clicked = "true";
      });
      nestedShadowRoot.append(shadowButton);
      const count = document.querySelector("#click-count");
      const clickButton = document.querySelector("#click-button");
      for (const type of ["mousemove", "mousedown", "mouseup", "click", "dblclick"]) {
        document.addEventListener(
          type,
          (event) => {
            window.__fixtureState.pointerEvents.push({
              type,
              target: event.target.id || event.target.tagName,
              detail: event.detail,
              x: event.clientX,
              y: event.clientY,
              trusted: event.isTrusted,
            });
          },
          true,
        );
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
      for (const type of ["mousemove", "mouseover"]) {
        document.querySelector("#hover-zone").addEventListener(type, () => {
          window.__fixtureState.hovered = true;
        });
      }
      let dragging = false;
      document.querySelector("#drag-source").addEventListener("mousedown", () => {
        dragging = true;
      });
      document.querySelector("#drag-target").addEventListener("mouseup", () => {
        if (dragging) window.__fixtureState.dragged = true;
        dragging = false;
      });
      document.querySelector("#text-input").addEventListener("keydown", (event) => {
        window.__fixtureState.keys.push(event.key);
        window.__fixtureState.keyEvents.push({
          type: event.type,
          key: event.key,
          value: event.target.value,
        });
        document.querySelector("#key-log").textContent = window.__fixtureState.keys.join(",");
      });
      for (const type of ["beforeinput", "input", "keyup"]) {
        document.querySelector("#text-input").addEventListener(type, (event) => {
          window.__fixtureState.keyEvents.push({
            type,
            key: event.key || event.inputType || "",
            value: event.target.value,
          });
        });
      }
      document.querySelector("#file-input").addEventListener("change", (event) => {
        document.querySelector("#file-name").textContent =
          Array.from(event.target.files).map((file) => file.name).join(",");
      });
      document.querySelector("#dynamic-file-button").addEventListener("click", () => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = true;
        input.dataset.dynamicUpload = "true";
        document.querySelector("#dynamic-file-container").replaceChildren(input);
        input.click();
      });

      /* value inputs (email/number) — track input/change for fillInput regressions */
      for (const id of ["email-input", "number-input"]) {
        const valueInput = document.querySelector("#" + id);
        for (const type of ["input", "change"]) {
          valueInput.addEventListener(type, () => {
            (window.__fixtureState.valueEvents[id] ||= []).push(type);
          });
        }
      }

      /* react-style controlled input — every input event writes value back through
         the native prototype setter, mirroring React/Vue controlled components.
         Guards fillInput's persistence on inputs that fight back. */
      (function () {
        const el = document.querySelector("#controlled-input");
        const stateEl = document.querySelector("#controlled-state");
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        ).set;
        let state = "";
        function render() {
          if (el.value !== state) setter.call(el, state);
          stateEl.textContent = state;
        }
        el.addEventListener("input", () => {
          state = el.value;
          render();
        });
        el.addEventListener("change", () => {
          stateEl.textContent = state + " (change)";
        });
        render();
      })();

      /* context menu zone — captures right-click */
      const contextZone = document.querySelector("#context-menu-zone");
      contextZone.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        window.__fixtureState.rightClicked = true;
      });

      /* dynamic DOM — add/remove elements */
      document.querySelector("#add-element").addEventListener("click", () => {
        const container = document.querySelector("#dynamic-container");
        if (!document.querySelector("#dynamic-element")) {
          const el = document.createElement("div");
          el.id = "dynamic-element";
          el.setAttribute("role", "status");
          el.textContent = "Dynamic!";
          el.style.cssText = "background:#efe;border:1px solid #7a7;padding:4px 8px;";
          container.appendChild(el);
          window.__fixtureState.dynamicElementExists = true;
        }
      });
      document.querySelector("#remove-element").addEventListener("click", () => {
        const el = document.querySelector("#dynamic-element");
        if (el) {
          el.remove();
          window.__fixtureState.dynamicElementExists = false;
        }
      });

      /* checkbox */
      document.querySelector("#checkbox").addEventListener("change", (event) => {
        window.__fixtureState.checkboxChecked = event.target.checked;
      });

      /* dropdown */
      document.querySelector("#dropdown").addEventListener("change", (event) => {
        window.__fixtureState.dropdownValue = event.target.value;
      });

      /* tab-trap focus tracking */
      for (const stop of document.querySelectorAll(".tab-stop")) {
        stop.addEventListener("focus", () => {
          window.__fixtureState.tabOrder.push(stop.dataset.tab);
        });
      }

      /* delayed element */
      setTimeout(() => {
        const delayed = document.querySelector("#delayed");
        delayed.style.display = "block";
      }, 350);
    </script>
  </body>
</html>`;
}

function visualPageHtml() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>ego-lite visual fixture</title>
    <style>
      html, body { height: 100%; margin: 0; overflow: hidden; }
      body { background: #f4f6fa; }
      canvas { left: 100px; position: fixed; top: 100px; }
    </style>
  </head>
  <body>
    <canvas id="visual-canvas" width="320" height="180"></canvas>
    <script>
      const canvas = document.querySelector("#visual-canvas");
      const context = canvas.getContext("2d");
      window.__visualClicks = 0;

      function draw(active) {
        context.fillStyle = "#172033";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = active ? "#2563eb" : "#dc2626";
        context.fillRect(20, 20, 120, 60);
        context.fillStyle = "#ffffff";
        context.font = "20px sans-serif";
        context.fillText(active ? "DONE" : "CLICK", 45, 58);
      }

      canvas.addEventListener("click", (event) => {
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        if (x >= 20 && x <= 140 && y >= 20 && y <= 80) {
          window.__visualClicks += 1;
          window.__visualTrusted = event.isTrusted;
          draw(true);
        }
      });
      draw(false);
    </script>
  </body>
</html>`;
}

function pointerWorkbenchHtml() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>ego-lite pointer workbench</title>
    <style>
      * { box-sizing: border-box; }
      body { background: #f6f7fb; font-family: system-ui, sans-serif; margin: 0; }
      h1 { font-size: 20px; margin: 12px 24px; }
      #drag-area {
        background: #fff;
        border: 2px solid #cbd5e1;
        height: 170px;
        margin: 0 24px 16px;
        position: relative;
        width: 720px;
      }
      #drag-source, #drop-target {
        align-items: center;
        display: flex;
        justify-content: center;
        position: absolute;
        user-select: none;
      }
      #drag-source {
        background: #ef4444;
        color: #fff;
        height: 56px;
        left: 32px;
        top: 54px;
        width: 72px;
        z-index: 2;
      }
      #drag-source.dropped { background: #16a34a; }
      #drop-target {
        background: #dcfce7;
        border: 3px dashed #16a34a;
        height: 110px;
        left: 540px;
        top: 28px;
        width: 140px;
      }
      #drawing-canvas {
        background: #fff;
        border: 2px solid #334155;
        display: block;
        height: 300px;
        margin: 0 24px;
        width: 720px;
      }
    </style>
  </head>
  <body>
    <h1>Pointer workbench</h1>
    <div id="drag-area">
      <div id="drag-source">A</div>
      <div id="drop-target">B</div>
    </div>
    <canvas id="drawing-canvas" width="720" height="300"></canvas>
    <script>
      const dragArea = document.querySelector("#drag-area");
      const dragSource = document.querySelector("#drag-source");
      const dropTarget = document.querySelector("#drop-target");
      const canvas = document.querySelector("#drawing-canvas");
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.strokeStyle = "#172033";
      context.lineCap = "round";
      context.lineJoin = "round";
      context.lineWidth = 6;

      const state = {
        drag: {
          downTrusted: false,
          landed: false,
          moveCount: 0,
          movesTrusted: true,
          upTrusted: false,
        },
        drawing: {
          allButtonsHeld: true,
          allTrusted: true,
          strokes: [],
        },
      };
      window.__pointerWorkbench = state;

      let drag;
      dragSource.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        const rect = dragSource.getBoundingClientRect();
        drag = {
          offsetX: event.clientX - rect.left,
          offsetY: event.clientY - rect.top,
        };
        state.drag.downTrusted = event.isTrusted;
        event.preventDefault();
      });
      window.addEventListener("mousemove", (event) => {
        if (!drag) return;
        const areaRect = dragArea.getBoundingClientRect();
        dragSource.style.left =
          event.clientX - areaRect.left - drag.offsetX + "px";
        dragSource.style.top =
          event.clientY - areaRect.top - drag.offsetY + "px";
        state.drag.moveCount += 1;
        state.drag.movesTrusted &&= event.isTrusted;
      });
      window.addEventListener("mouseup", (event) => {
        if (!drag) return;
        const sourceRect = dragSource.getBoundingClientRect();
        const targetRect = dropTarget.getBoundingClientRect();
        const centerX = sourceRect.left + sourceRect.width / 2;
        const centerY = sourceRect.top + sourceRect.height / 2;
        state.drag.landed =
          centerX >= targetRect.left &&
          centerX <= targetRect.right &&
          centerY >= targetRect.top &&
          centerY <= targetRect.bottom;
        state.drag.upTrusted = event.isTrusted;
        if (state.drag.landed) dragSource.classList.add("dropped");
        drag = null;
      });

      let activeStroke;
      const canvasPoint = (event) => {
        const rect = canvas.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
      };
      canvas.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        const point = canvasPoint(event);
        activeStroke = {
          points: [point],
          downTrusted: event.isTrusted,
          upTrusted: false,
        };
        state.drawing.strokes.push(activeStroke);
        state.drawing.allTrusted &&= event.isTrusted;
        context.beginPath();
        context.moveTo(point.x, point.y);
        event.preventDefault();
      });
      canvas.addEventListener("mousemove", (event) => {
        if (!activeStroke) return;
        const point = canvasPoint(event);
        activeStroke.points.push(point);
        state.drawing.allButtonsHeld &&= (event.buttons & 1) === 1;
        state.drawing.allTrusted &&= event.isTrusted;
        context.lineTo(point.x, point.y);
        context.stroke();
      });
      window.addEventListener("mouseup", (event) => {
        if (!activeStroke) return;
        activeStroke.upTrusted = event.isTrusted;
        state.drawing.allTrusted &&= event.isTrusted;
        activeStroke = null;
      });

      state.read = () => {
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let inkPixels = 0;
        let minX = canvas.width;
        let minY = canvas.height;
        let maxX = -1;
        let maxY = -1;
        for (let y = 0; y < canvas.height; y += 1) {
          for (let x = 0; x < canvas.width; x += 1) {
            const offset = (y * canvas.width + x) * 4;
            if (pixels[offset] > 80 || pixels[offset + 1] > 80 || pixels[offset + 2] > 80) {
              continue;
            }
            inkPixels += 1;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }
        }
        return {
          drag: { ...state.drag },
          drawing: {
            allButtonsHeld: state.drawing.allButtonsHeld,
            allTrusted: state.drawing.allTrusted,
            inkBounds: inkPixels > 0 ? { minX, minY, maxX, maxY } : null,
            inkPixels,
            strokes: state.drawing.strokes.map((stroke) => ({
              downTrusted: stroke.downTrusted,
              points: stroke.points,
              upTrusted: stroke.upTrusted,
            })),
          },
        };
      };
    </script>
  </body>
</html>`;
}

function mediaWorkbenchHtml() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>ego-lite media workbench</title>
    <style>
      * { box-sizing: border-box; }
      body {
        background: #eef2ff;
        color: #172033;
        font-family: system-ui, sans-serif;
        margin: 0;
        padding: 24px;
      }
      main { display: grid; gap: 20px; grid-template-columns: 520px 300px; }
      section {
        background: #fff;
        border: 1px solid #cbd5e1;
        border-radius: 12px;
        padding: 16px;
      }
      video {
        background: #111827;
        display: block;
        height: 270px;
        margin-bottom: 12px;
        width: 480px;
      }
      button { margin: 4px 6px 4px 0; padding: 8px 12px; }
      output { display: block; font-family: monospace; margin-top: 12px; }
    </style>
  </head>
  <body data-media-ready="false">
    <h1>Media workbench</h1>
    <main>
      <section>
        <h2>Generated video</h2>
        <video id="test-video" playsinline></video>
        <button id="video-play">Play video</button>
        <button id="video-pause">Pause video</button>
        <button id="video-rate">Set video to 1.5×</button>
        <button id="video-mute">Toggle video mute</button>
      </section>
      <section>
        <h2>Generated audio</h2>
        <audio id="test-audio"></audio>
        <button id="audio-play">Play audio</button>
        <button id="audio-pause">Pause audio</button>
        <button id="audio-seek">Seek audio</button>
        <button id="audio-volume">Set audio volume</button>
        <output id="media-status">Preparing media…</output>
      </section>
    </main>
    <script>
      const video = document.querySelector("#test-video");
      const audio = document.querySelector("#test-audio");
      const status = document.querySelector("#media-status");
      const state = {
        errors: [],
        ready: false,
        trustedControls: true,
        videoEvents: {},
        audioEvents: {},
      };

      function observeMedia(element, events) {
        for (const name of [
          "play",
          "playing",
          "pause",
          "timeupdate",
          "seeking",
          "seeked",
          "ratechange",
          "volumechange",
          "ended",
        ]) {
          events[name] = 0;
          element.addEventListener(name, () => {
            events[name] += 1;
            element.dataset.playing = String(!element.paused);
            if (element.currentTime >= 0.15) {
              element.dataset.progressed = "true";
            }
          });
        }
      }

      function bindControl(selector, action) {
        document.querySelector(selector).addEventListener("click", async (event) => {
          state.trustedControls &&= event.isTrusted;
          try {
            await action();
          } catch (error) {
            state.errors.push(String(error?.message || error));
          }
        });
      }

      function createWaveUrl() {
        const duration = 3;
        const sampleRate = 8000;
        const sampleCount = duration * sampleRate;
        const dataLength = sampleCount * 2;
        const buffer = new ArrayBuffer(44 + dataLength);
        const view = new DataView(buffer);
        const writeText = (offset, text) => {
          for (let index = 0; index < text.length; index += 1) {
            view.setUint8(offset + index, text.charCodeAt(index));
          }
        };
        writeText(0, "RIFF");
        view.setUint32(4, 36 + dataLength, true);
        writeText(8, "WAVE");
        writeText(12, "fmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        writeText(36, "data");
        view.setUint32(40, dataLength, true);
        for (let index = 0; index < sampleCount; index += 1) {
          const sample = Math.sin((index / sampleRate) * Math.PI * 2 * 440);
          view.setInt16(44 + index * 2, sample * 5000, true);
        }
        return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
      }

      async function createVideoUrl() {
        const canvas = document.createElement("canvas");
        canvas.width = 480;
        canvas.height = 270;
        const context = canvas.getContext("2d");
        const stream = canvas.captureStream(20);
        const mimeType = [
          "video/webm;codecs=vp8",
          "video/webm;codecs=vp9",
          "video/webm",
        ].find((candidate) => MediaRecorder.isTypeSupported(candidate));
        const recorder = new MediaRecorder(
          stream,
          mimeType ? { mimeType } : undefined,
        );
        const chunks = [];
        const stopped = new Promise((resolve, reject) => {
          recorder.addEventListener("dataavailable", (event) => {
            if (event.data.size > 0) chunks.push(event.data);
          });
          recorder.addEventListener("stop", resolve, { once: true });
          recorder.addEventListener("error", () => reject(recorder.error), {
            once: true,
          });
        });
        recorder.start();
        const startedAt = performance.now();
        await new Promise((resolve) => {
          const draw = (now) => {
            const elapsed = (now - startedAt) / 1000;
            const hue = Math.round((elapsed * 140) % 360);
            context.fillStyle = "hsl(" + hue + " 70% 45%)";
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.fillStyle = "#ffffff";
            context.font = "bold 34px sans-serif";
            context.fillText("FRAME " + elapsed.toFixed(1), 130, 145);
            if (elapsed >= 2.5) {
              resolve();
              return;
            }
            requestAnimationFrame(draw);
          };
          requestAnimationFrame(draw);
        });
        recorder.stop();
        await stopped;
        for (const track of stream.getTracks()) track.stop();
        return URL.createObjectURL(new Blob(chunks, { type: mimeType }));
      }

      function waitForMetadata(element) {
        if (element.readyState >= HTMLMediaElement.HAVE_METADATA) {
          return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
          element.addEventListener("loadedmetadata", resolve, { once: true });
          element.addEventListener("error", () => reject(element.error), {
            once: true,
          });
        });
      }

      observeMedia(video, state.videoEvents);
      observeMedia(audio, state.audioEvents);
      bindControl("#video-play", () => video.play());
      bindControl("#video-pause", () => video.pause());
      bindControl("#video-rate", () => {
        video.playbackRate = 1.5;
      });
      bindControl("#video-mute", () => {
        video.muted = !video.muted;
      });
      bindControl("#audio-play", () => audio.play());
      bindControl("#audio-pause", () => audio.pause());
      bindControl("#audio-seek", () => {
        audio.currentTime = 1.2;
      });
      bindControl("#audio-volume", () => {
        audio.volume = 0.25;
      });

      window.__mediaWorkbench = {
        read() {
          const describe = (element, events) => ({
            currentTime: element.currentTime,
            duration: Number.isFinite(element.duration) ? element.duration : null,
            events: { ...events },
            muted: element.muted,
            paused: element.paused,
            playbackRate: element.playbackRate,
            progressed: element.dataset.progressed === "true",
            readyState: element.readyState,
            volume: element.volume,
          });
          return {
            errors: [...state.errors],
            ready: state.ready,
            trustedControls: state.trustedControls,
            video: describe(video, state.videoEvents),
            audio: describe(audio, state.audioEvents),
          };
        },
      };

      (async () => {
        try {
          audio.src = createWaveUrl();
          video.src = await createVideoUrl();
          await Promise.all([waitForMetadata(video), waitForMetadata(audio)]);
          state.ready = true;
          document.body.dataset.mediaReady = "true";
          status.textContent = "Media ready";
        } catch (error) {
          state.errors.push(String(error?.message || error));
          document.body.dataset.mediaError = "true";
          status.textContent = "Media setup failed";
        }
      })();
    </script>
  </body>
</html>`;
}
