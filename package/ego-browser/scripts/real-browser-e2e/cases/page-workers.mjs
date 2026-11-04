export function pageDedicatedWorkerCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/?page-api=worker");
    const result = await page.evaluate(async () => {
      const workerUrl = URL.createObjectURL(
        new Blob(['postMessage("worker-ready")'], { type: "text/javascript" })
      );
      const worker = new Worker(workerUrl);
      try {
        return await new Promise((resolve) => {
          const timer = setTimeout(() => resolve("worker-timeout"), 3000);
          worker.onmessage = (event) => {
            clearTimeout(timer);
            resolve(event.data);
          };
          worker.onerror = (event) => {
            clearTimeout(timer);
            resolve("worker-error:" + event.message);
          };
        });
      } finally {
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
      }
    });
    assertEqual(
      result,
      "worker-ready",
      "a dedicated worker starts while its Page is under Agent control"
    );
    await page.close();
  `;
}

export function pageAudioWorkletCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/?page-api=audio-worklet");
    const result = await page.evaluate(async () => {
      const moduleUrl = URL.createObjectURL(
        new Blob(
          [
            'registerProcessor("e2e-noop", class extends AudioWorkletProcessor {' +
              " process() { return true; } });",
          ],
          { type: "text/javascript" }
        )
      );
      const context = new AudioContext();
      try {
        return await Promise.race([
          context.audioWorklet.addModule(moduleUrl).then(() => {
            new AudioWorkletNode(context, "e2e-noop");
            return "worklet-ready";
          }),
          new Promise((resolve) =>
            setTimeout(() => resolve("worklet-timeout"), 3000)
          ),
        ]);
      } catch (error) {
        return "worklet-error:" + error.message;
      } finally {
        void context.close();
        URL.revokeObjectURL(moduleUrl);
      }
    });
    assertEqual(
      result,
      "worklet-ready",
      "an AudioWorklet module loads while its Page is under Agent control"
    );
    await page.close();
  `;
}

export function pageSharedWorkerCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/?page-api=shared-worker");
    const result = await page.evaluate(async () => {
      const workerUrl = URL.createObjectURL(
        new Blob(
          [
            "onconnect = (event) => {" +
              " const port = event.ports[0];" +
              ' port.onmessage = () => port.postMessage("shared-worker-ready");' +
              " };",
          ],
          { type: "text/javascript" }
        )
      );
      const worker = new SharedWorker(workerUrl);
      try {
        return await new Promise((resolve) => {
          const timer = setTimeout(() => resolve("shared-worker-timeout"), 3000);
          worker.port.onmessage = (event) => {
            clearTimeout(timer);
            resolve(event.data);
          };
          worker.onerror = (event) => {
            clearTimeout(timer);
            resolve("shared-worker-error:" + (event.message || "load failed"));
          };
          worker.port.postMessage("ping");
        });
      } finally {
        worker.port.close();
        URL.revokeObjectURL(workerUrl);
      }
    });
    assertEqual(
      result,
      "shared-worker-ready",
      "a SharedWorker starts while its Page is under Agent control"
    );
    await page.close();
  `;
}

export function pageServiceWorkerCase() {
  return `
    const task = await taskSpace(taskName);
    const page = await newPageAt(task, baseUrl + "/service-worker/page");
    const result = await page.evaluate(async () => {
      const timeout = (label) =>
        new Promise((resolve) => setTimeout(() => resolve(label), 5000));
      const registration = await navigator.serviceWorker.register(
        "/service-worker/sw.js",
        { scope: "/service-worker/" }
      );
      try {
        const controlled = navigator.serviceWorker.controller
          ? "controlled"
          : await Promise.race([
              new Promise((resolve) =>
                navigator.serviceWorker.addEventListener(
                  "controllerchange",
                  () => resolve("controlled"),
                  { once: true }
                )
              ),
              timeout("service-worker-activate-timeout"),
            ]);
        if (controlled !== "controlled") return controlled;
        return await Promise.race([
          fetch("/service-worker/ping").then((response) => response.text()),
          timeout("service-worker-fetch-timeout"),
        ]);
      } catch (error) {
        return "service-worker-error:" + error.message;
      } finally {
        await registration.unregister();
      }
    });
    assertEqual(
      result,
      "service-worker-pong",
      "a Service Worker activates and answers fetches while its Page is under Agent control"
    );
    await page.close();
  `;
}
