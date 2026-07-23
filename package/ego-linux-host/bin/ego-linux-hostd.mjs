#!/usr/bin/env node
import { startDaemon } from "../dist/host-daemon.js";

const daemon = await startDaemon();

const shutdown = async (signal) => {
  try {
    await daemon.close();
  } catch {
    // ignore
  }
  process.exit(signal === "SIGTERM" || signal === "SIGINT" ? 0 : 1);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Keep process alive; socket server owns the event loop.
