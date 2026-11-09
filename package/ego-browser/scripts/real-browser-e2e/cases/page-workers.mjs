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
