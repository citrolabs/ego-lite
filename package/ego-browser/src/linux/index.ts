import { findChrome } from "./launcher.js";
import { connectHost, hostDirectory, type LinuxClient } from "./client.js";
import { join } from "node:path";
import { invalid } from "./task-spaces.js";

let installed = false;
let connection: Promise<LinuxClient> | undefined;

export async function installEgoLinux(): Promise<void> {
  if (
    globalThis.ego ||
    installed ||
    process.platform !== "linux" ||
    process.env.EGO_LINUX === "0"
  )
    return;
  if (
    process.env.EGO_LINUX !== "1" &&
    (process.env.CI || process.env.NODE_TEST_CONTEXT || !findChrome())
  )
    return;
  if (process.env.EGO_LINUX_PORT)
    throw new Error(
      "EGO_LINUX_PORT is no longer supported: the Linux host owns Chrome through a private pipe",
    );
  let selected: number | null = null;
  const ego: Record<string, any> = {
    onCDPMessage: null,
    onSendCDPMessageError: null,
    useTaskSpace(id: number) {
      if (arguments.length !== 1 || !Number.isSafeInteger(id) || id < 0)
        invalid("Task space id must be a non-negative integer");
      selected = id;
      return id;
    },
    sendCDPMessage(payload: string) {
      if (typeof payload !== "string") invalid("CDP message must be a string");
      const space = selected;
      let message: any;
      try {
        message = JSON.parse(payload);
      } catch {
        invalid("Invalid CDP JSON");
      }
      void getClient()
        .then((client) => client.call("cdp", space, [message]))
        .then((result) => {
          ego.onCDPMessage?.(
            JSON.stringify({
              id: message.id,
              result,
              ...(message.sessionId ? { sessionId: message.sessionId } : {}),
            }),
          );
        })
        .catch((error) => {
          if (error.error_code && space === selected)
            ego.onSendCDPMessageError?.(error.message, error.error_code);
          else
            ego.onCDPMessage?.(
              JSON.stringify({
                id: message.id,
                error: {
                  message: `${message.method}: ${error.message}`,
                  code: error.code,
                },
                ...(message.sessionId ? { sessionId: message.sessionId } : {}),
              }),
            );
        });
    },
    getBrowserVersion() {
      return null;
    },
  };
  const getClient = () =>
    (connection ??= connectHost()
      .then((client) => {
        ego.linuxInstanceId = client.instanceId;
        client.onEvent = (event, spaceId) => {
          if (spaceId === selected) ego.onCDPMessage?.(JSON.stringify(event));
        };
        return client;
      })
      .catch((error) => {
        connection = undefined;
        throw error;
      }));
  const counts = {
    listProfiles: [0, 0],
    listTaskSpaces: [0, 0],
    createTaskSpace: [1, 2],
    claimTaskSpace: [1, 2],
    createTab: [1, 1],
    listTabs: [0, 0],
    closeTaskSpace: [0, 0],
    completeTaskSpace: [0, 0],
    checkTaskSpaceCompletion: [0, 0],
    handOffTaskSpace: [0, 0],
    takeOverTaskSpace: [0, 0],
    snapshot: [0, 1],
  };
  for (const [method, [min, max]] of Object.entries(counts)) {
    ego[method] = async (...args: unknown[]) => {
      if (args.length < min || args.length > max)
        invalid(`Invalid argument count for ${method}`);
      const space = selected;
      try {
        return await (await getClient()).call(method, space, args);
      } catch (error) {
        if (
          method === "snapshot" ||
          error.error_code === "EGO_INVALID_ARGUMENT"
        )
          throw error;
        return {
          error: error.message,
          error_code: error.error_code ?? "EGO_OPERATION_FAILED",
        };
      }
    };
  }
  process.env.EGO_BROWSER_STATE_DIR ??= join(hostDirectory(), "page-state");
  (globalThis as Record<string, unknown>).ego = ego;
  installed = true;
}
export function isLinuxEgoInstalled() {
  return installed;
}
export async function closeLinuxClient() {
  (await connection?.catch(() => undefined))?.close();
  connection = undefined;
}
export async function stopLinuxHost() {
  const client = await connectHost(false);
  try {
    await client.call("stop");
  } finally {
    client.close();
  }
}
