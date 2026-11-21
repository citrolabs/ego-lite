import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import { LinuxBridge } from "./bridge.js";

export function findChrome(env = process.env): string | undefined {
  const names = env.EGO_CHROME_BIN
    ? [env.EGO_CHROME_BIN]
    : [
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "/snap/bin/chromium",
      ];
  for (const name of names) {
    for (const file of isAbsolute(name)
      ? [name]
      : (env.PATH ?? "")
          .split(":")
          .filter(Boolean)
          .map((dir) => join(dir, name))) {
      try {
        accessSync(file, constants.X_OK);
        return file;
      } catch {}
    }
  }
}

export interface ChromeInstance {
  process: ChildProcess;
  bridge: LinuxBridge;
  headless: boolean;
  close(): Promise<void>;
}

export function chromeArguments(profile: string, headless: boolean): string[] {
  return [
    "--remote-debugging-pipe",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    ...(headless ? ["--headless=new"] : ["--ozone-platform-hint=auto"]),
    "about:blank",
  ];
}

export async function launchChrome(directory: string): Promise<ChromeInstance> {
  const executable = findChrome();
  if (!executable)
    throw new Error(
      "Chrome/Chromium not found; set EGO_CHROME_BIN to an executable path",
    );
  const headless =
    process.env.EGO_LINUX_HEADLESS === "1" ||
    (process.env.EGO_LINUX_HEADLESS !== "0" &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY);
  const profile = await mkdtemp(join(directory, "profile-"));
  const child = spawn(executable, chromeArguments(profile, headless), {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  const bridge = new LinuxBridge(
    child.stdio[3] as Writable,
    child.stdio[4] as Readable,
  );
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      bridge.close();
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
          child.kill("SIGTERM");
        });
      }
      await rm(profile, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    })());
  child.once("error", (error) => bridge.close(error));
  child.once("exit", () => bridge.close(new Error(`Chrome exited. ${stderr}`)));
  try {
    await bridge.call("Browser.getVersion");
  } catch (error) {
    await close();
    throw new Error(
      `Could not start sandboxed Chrome: ${error.message}. ${stderr}`,
    );
  }
  return { process: child, bridge, headless, close };
}
