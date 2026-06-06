// Builds the React viewer as a self-installing step so a fresh clone -> install -> build -> npm pack
// works end to end. The root package is npm-governed (package-lock.json); the viewer is pnpm-governed
// (pnpm-lock.yaml + pnpm-workspace.yaml). `npm install` at the root does NOT install the viewer's
// deps, and `pnpm -C viewer build` does not install them either, so prepublishOnly used to fail on a
// fresh clone. This script bridges the two: install the viewer deps with pnpm (frozen to its
// lockfile) if they're missing, then build. When pnpm itself isn't on PATH (npm-only machine), fall
// back to `npx -y pnpm@10`, which only requires npm — keeping the root story npm-driven end to end.

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const viewer = join(root, "viewer")
const onWindows = process.platform === "win32"

function trySpawn(cmd, args) {
  return spawnSync(cmd, args, { cwd: viewer, stdio: "inherit", shell: onWindows })
}

function pnpm(args) {
  let r = trySpawn("pnpm", args)
  // ENOENT = pnpm not installed; npx ships with npm, and pnpm@10 reads lockfileVersion 9.0.
  // Under shell:true (Windows) a missing pnpm is NOT an ENOENT — cmd prints "not recognized"
  // and exits nonzero — so there ANY bare-pnpm failure falls back to npx. When pnpm exists and
  // the command legitimately fails, the npx retry fails the same way; one redundant attempt.
  if ((r.error && r.error.code === "ENOENT") || (onWindows && (r.error || r.status !== 0))) {
    r = trySpawn("npx", ["--yes", "pnpm@10", ...args])
  }
  if (r.error) {
    throw new Error(`failed to spawn pnpm (and npx fallback): ${r.error.message}`)
  }
  if (r.status !== 0) {
    throw new Error(`\`pnpm ${args.join(" ")}\` exited with code ${r.status}`)
  }
}

if (!existsSync(join(viewer, "node_modules"))) {
  // --frozen-lockfile: reproducible from pnpm-lock.yaml, fails loudly if the lockfile is stale.
  pnpm(["install", "--frozen-lockfile"])
}

pnpm(["build"])
