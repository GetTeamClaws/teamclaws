#!/usr/bin/env node

import { run } from "./app.js";

const controller = new AbortController();
const interrupt = (): void => controller.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

try {
  process.exitCode = await run(process.argv.slice(2), {}, controller.signal);
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
