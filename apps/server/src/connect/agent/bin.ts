// The bundle's entry, `agent.mjs` (docs/prd/targets-connect.md §11.1, §11.3): the program itself. It runs whenever Node is asked to run this file,
// however it was asked: an absolute path, a relative one, or a symlink (the installer starts `current.mjs`, a link to `bundle/<build>/agent.mjs`).
// There is deliberately no "am I the main module?" guard here: comparing `process.argv[1]` with this file is false through a symlink, which made
// `run` and `enroll` exit 0 without doing anything. `main.ts` is the importable part (tests call `main` directly); this file only calls it.
import { main, selfBuild } from './main.js';

main(process.argv.slice(2), process.env, selfBuild(import.meta.url)).then(
  (code) => process.exit(code),
  () => process.exit(1),
);
