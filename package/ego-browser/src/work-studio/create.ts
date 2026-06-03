import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cdp } from "../cdp-eval.js";
import {
  readServerInfo,
  readStoredTask,
  writeStoredTask,
  type WorkStudioSpec,
  type WorkStudioStoredTask
} from "./store.js";

export type CreateWorkStudioResult = {
  taskId: string;
  safeTaskId: string;
  url: string;
  apiUrl: string;
  port: number;
  serverPid?: number;
};

/**
 * Create or update an A2UI-backed Work Studio page for a task space.
 * @param {WorkStudioSpec} spec Work Studio document, tabs, and CDP bridge bindings.
 * @returns {Promise<CreateWorkStudioResult>} Local Work Studio URL and server metadata.
 */
export async function createWorkStudio(spec: WorkStudioSpec): Promise<CreateWorkStudioResult> {
  const existing = await readExistingTask(spec.taskId);
  const stored = await writeStoredTask(spec, existing || undefined);
  await applyTabPolicy(stored);
  const server = await ensureServer(stored);
  const url = `http://${server.host}:${server.port}/tasks/${stored.safeTaskId}?token=${encodeURIComponent(stored.token)}`;
  return {
    taskId: stored.taskId,
    safeTaskId: stored.safeTaskId,
    url,
    apiUrl: `http://${server.host}:${server.port}/api/tasks/${stored.safeTaskId}`,
    port: server.port,
    serverPid: server.pid
  };
}

async function readExistingTask(taskId: string) {
  try {
    return await readStoredTask(taskId);
  } catch {
    return null;
  }
}

async function ensureServer(task: WorkStudioStoredTask) {
  const current = await readServerInfo(task.taskId);
  if (current?.port && await serverAlive(current.host || "127.0.0.1", current.port, task)) {
    return current;
  }
  const command = serverCommand(task.taskId);
  const child = spawn(command.file, command.args, {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await sleep(100);
    const info = await readServerInfo(task.taskId);
    if (info?.port && await serverAlive(info.host || "127.0.0.1", info.port, task)) {
      return info;
    }
  }
  throw new Error("Work Studio bridge server did not start");
}

function serverCommand(taskId: string) {
  const entry = join(dirname(fileURLToPath(import.meta.url)), "server-entry.js");
  if (existsSync(entry)) {
    return { file: process.execPath, args: [entry, taskId] };
  }
  const self = fileURLToPath(import.meta.url);
  return { file: nodeExecutable(), args: [self, "--work-studio-server", taskId] };
}

function nodeExecutable() {
  return process.env.EGO_BROWSER_NODE_PATH || process.env.NODE_BINARY || "node";
}

async function serverAlive(host: string, port: number, task: WorkStudioStoredTask) {
  try {
    const response = await fetch(`http://${host}:${port}/api/tasks/${task.safeTaskId}`, {
      headers: { Authorization: `Bearer ${task.token}` },
      signal: AbortSignal.timeout(1000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function applyTabPolicy(task: WorkStudioStoredTask) {
  const policy = {
    closeInformationTabs: true,
    closeTemporaryTabs: true,
    keepInteractiveTabs: true,
    ...(task.tabPolicy || {})
  };
  for (const tab of task.tabs) {
    if (!tab.targetId) continue;
    const shouldClose = (tab.role === "information_source" && policy.closeInformationTabs) ||
      (tab.role === "temporary" && policy.closeTemporaryTabs);
    if (!shouldClose) continue;
    try {
      await cdp("Target.closeTarget", { targetId: tab.targetId });
    } catch {
      // Closing archived tabs is opportunistic. A stale target must not block the result page.
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const __testing = {
  serverCommand,
  serverAlive,
  applyTabPolicy
};
