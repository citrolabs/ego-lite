#!/usr/bin/env node
import { runCli } from "../dist/cli.js";

const code = await runCli(process.argv.slice(2));
process.exit(code ?? 0);
