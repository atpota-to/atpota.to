// Runs a TypeScript script from this repo through Vite's module runner (the same
// transform the dev server uses), so scripts need no extra tooling:
//   node scripts/run.mjs scripts/publish-guides.ts [args]
// The module's exported main(args) returns the process exit code.

import { resolve } from 'node:path';
import { runnerImport } from 'vite';

const [file, ...args] = process.argv.slice(2);
if (!file) {
  console.error('usage: node scripts/run.mjs <script.ts> [args]');
  process.exit(2);
}
const { module } = await runnerImport(resolve(file));
process.exitCode = await module.main(args);
