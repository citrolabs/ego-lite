#!/usr/bin/env node
import { loadConfig } from "../dist/config.js";
import { pingSocket } from "../dist/ego-client.js";
import { startHealthServer } from "../dist/health-server.js";
import {
  inspectHost,
  startManagedDaemon,
  stopHost,
} from "../dist/host-control.js";
import { isCdpUp } from "../dist/chrome-supervisor.js";

const command = process.argv[2] ?? "run";
const config = await loadConfig();

if (command === "status") {
  const status = await inspectHost(config);
  console.log(JSON.stringify(status));
  process.exit(status.state === "ready" ? 0 : 1);
} else if (command === "stop") {
  const result = await stopHost(config);
  console.log(JSON.stringify({ ok: true, ...result }));
  process.exit(0);
} else if (command === "run") {
  const daemon = await startManagedDaemon({ config });
  let health = null;
  const portValue = process.env.PORT;
  try {
    if (portValue) {
      const port = Number(portValue);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`invalid PORT: ${portValue}`);
      }
      health = await startHealthServer({
        host: process.env.EGO_HEALTH_HOST || "::",
        port,
        isReady: async () =>
          (await pingSocket(config.hostSocket)) &&
          (await isCdpUp(config.cdpPort)),
      });
    }
  } catch (error) {
    await daemon.close();
    throw error;
  }

  let shutdownPromise;
  const shutdown = () => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        if (health) await health.close();
        await daemon.close();
      })();
    }
    return shutdownPromise;
  };

  process.on("SIGINT", () => {
    void shutdown().then(() => {
      process.exitCode = 0;
    });
  });
  process.on("SIGTERM", () => {
    void shutdown().then(() => {
      process.exitCode = 0;
    });
  });
} else {
  console.error("usage: ego-linux-hostd [run|status|stop]");
  process.exit(2);
}

// The daemon socket and optional health server own the event loop in run mode.
