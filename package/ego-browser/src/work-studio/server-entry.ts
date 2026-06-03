import { startWorkStudioServer } from "./server.js";
import { readStoredTask, writeServerInfo } from "./store.js";

const taskId = process.argv[2];
if (!taskId) {
  process.stderr.write("usage: server-entry <taskId>\n");
  process.exit(2);
}

try {
  const task = await readStoredTask(taskId);
  const started = await startWorkStudioServer({ taskId });
  await writeServerInfo(taskId, {
    taskId,
    safeTaskId: task.safeTaskId,
    host: started.host,
    port: started.port,
    pid: process.pid,
    startedAt: new Date().toISOString()
  });
} catch (error) {
  process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
  process.exit(1);
}
