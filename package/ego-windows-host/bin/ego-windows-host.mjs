#!/usr/bin/env node
import { main } from "../dist/src/cli.js";

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
}
