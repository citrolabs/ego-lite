#!/usr/bin/env node
import { runRealBrowserE2e } from "./real-browser-e2e/runner.mjs";

// The suite drives the real `ego-browser` command, which ships inside the ego
// lite app. That app is macOS-only today, so bail out with an explanation
// instead of failing later on an opaque ENOENT.
if (process.platform !== "darwin" && !process.env.EGO_BROWSER_REAL_E2E_FORCE) {
  console.log(
    `skip: the real-browser e2e suite requires the ego lite app (macOS only); ` +
      `platform is ${process.platform}. Set EGO_BROWSER_REAL_E2E_FORCE=1 to run it anyway.`,
  );
  process.exit(0);
}

await runRealBrowserE2e();
