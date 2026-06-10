// Unit + smoke tests for the CLI: argument parsing, per-flag validation, error classification,
// the entrypoint symlink guard, and an end-to-end --fake spawn. Filesystem-touching parts are
// scoped to a temp OMEGACODE_HOME (plus a temp bundle under node_modules/.cache for the
// symlinked-bin suite); nothing here ever reads or writes the real ~/.omegacode.

import { strict as assert } from "node:assert"
import { execFileSync, spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { get as httpGet } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { after, before, describe, test } from "node:test"

import { parseArgs, UsageError, isUserFacingError, browserOpenCommand, openBrowser } from "../src/cli.ts"
import { WorkflowSyntaxError } from "../src/runtime/sandbox.ts"
import { WorkflowError } from "../src/runtime/primitives.ts"
import { JournalNotFoundError, ResumePreconditionError } from "../src/runtime/journal.ts"
import { AgentError, AgentInterrupted } from "../src/worker/index.ts"

const CLI_ENTRY = fileURLToPath(new URL("../src/cli.ts", import.meta.url))

describe("parseArgs — positionals", () => {
  test("collects bare positionals into _", () => {
    const f = parseArgs(["run", "wf.js"])
    assert.deepEqual(f._, ["run", "wf.js"])
  })

  test("empty argv yields empty _", () => {
    assert.deepEqual(parseArgs([])._, [])
  })

  test("everything after -- is positional", () => {
    const f = parseArgs(["run", "--", "--not-a-flag", "x"])
    assert.deepEqual(f._, ["run", "--not-a-flag", "x"])
  })
})

describe("parseArgs — value flags", () => {
  test("--flag value form", () => {
    const f = parseArgs(["run", "--provider", "codex"])
    assert.equal(f.provider, "codex")
    assert.deepEqual(f._, ["run"])
  })

  test("--flag=value form", () => {
    const f = parseArgs(["run", "--provider=codex"])
    assert.equal(f.provider, "codex")
  })

  test("--flag=value preserves '=' inside the value", () => {
    const f = parseArgs(["run", "--args=a=b=c"])
    assert.equal(f.args, "a=b=c")
  })

  test("--flag= sets an empty string (distinct from a missing flag)", () => {
    const f = parseArgs(["run", "--resume="])
    assert.equal(f.resume, "")
  })

  test("a value-taking flag with no value throws UsageError (M20: bare --resume)", () => {
    assert.throws(() => parseArgs(["run", "--resume"]), UsageError)
  })

  test("a value-taking flag followed by another --flag throws (does not silently become true)", () => {
    assert.throws(() => parseArgs(["run", "--resume", "--fake"]), UsageError)
  })

  test("a value-taking flag at end of argv throws", () => {
    assert.throws(() => parseArgs(["run", "--port"]), UsageError)
  })
})

describe("parseArgs — boolean flags never consume the next token (M18)", () => {
  test("--fake does not swallow the following positional", () => {
    const f = parseArgs(["run", "--fake", "wf.js"])
    assert.equal(f.fake, true)
    assert.deepEqual(f._, ["run", "wf.js"])
  })

  test("--json, --open, --no-serve stay boolean and leave the next token alone", () => {
    const f = parseArgs(["run", "--json", "--open", "--no-serve", "wf.js"])
    assert.equal(f.json, true)
    assert.equal(f.open, true)
    assert.equal(f["no-serve"], true)
    assert.deepEqual(f._, ["run", "wf.js"])
  })

  test("--fake as the last token is true", () => {
    const f = parseArgs(["run", "wf.js", "--fake"])
    assert.equal(f.fake, true)
  })

  test("--fake=true / --fake=false explicit forms", () => {
    assert.equal(parseArgs(["run", "--fake=true"]).fake, true)
    assert.equal(parseArgs(["run", "--fake=false"]).fake, false)
  })

  test("--fake=garbage throws UsageError", () => {
    assert.throws(() => parseArgs(["run", "--fake=garbage"]), UsageError)
  })

  test("prune-stale / idle-shutdown / claude / agents are booleans", () => {
    const f = parseArgs(["runs", "--prune-stale", "next"])
    assert.equal(f["prune-stale"], true)
    assert.deepEqual(f._, ["runs", "next"])
  })
})

describe("isUserFacingError — typed classification (L17)", () => {
  test("UsageError is user-facing", () => {
    assert.equal(isUserFacingError(new UsageError("x")), true)
  })
  test("WorkflowSyntaxError is user-facing", () => {
    assert.equal(isUserFacingError(new WorkflowSyntaxError("x")), true)
  })
  test("WorkflowError is user-facing", () => {
    assert.equal(isUserFacingError(new WorkflowError("x")), true)
  })
  test("AgentError / AgentInterrupted are user-facing", () => {
    assert.equal(isUserFacingError(new AgentError({ provider: "codex", code: "x", message: "y" })), true)
    assert.equal(isUserFacingError(new AgentInterrupted()), true)
  })
  test("determinism lint bare Error is user-facing by its stable prefix", () => {
    assert.equal(isUserFacingError(new Error("determinism lint failed: Date.now() → use now()")), true)
  })
  test("an arbitrary internal Error is NOT user-facing (would print a stack)", () => {
    assert.equal(isUserFacingError(new Error("Cannot read properties of undefined")), false)
  })
  test("a reworded user message is still classified by class, not prose", () => {
    // The old regex keyed on phrases like "must be the first statement"; a reword used to flip
    // these to a raw stack. Now the class decides regardless of wording.
    assert.equal(isUserFacingError(new WorkflowSyntaxError("totally different wording")), true)
  })
  test("JournalNotFoundError / ResumePreconditionError (typo'd --resume) are user-facing", () => {
    assert.equal(isUserFacingError(new JournalNotFoundError("wf_typo")), true)
    assert.equal(isUserFacingError(new ResumePreconditionError("workflow file changed")), true)
  })
  test("non-Error values are not user-facing (main prints String(err) for them anyway)", () => {
    assert.equal(isUserFacingError("a string"), false)
    assert.equal(isUserFacingError(undefined), false)
  })
})

describe("browserOpenCommand — platform forms (H13)", () => {
  test("darwin uses `open <url>`", () => {
    assert.deepEqual(browserOpenCommand("darwin", "http://x/"), ["open", ["http://x/"]])
  })
  test("win32 uses `cmd /c start \"\" <url>` (start is a cmd builtin, not an exe)", () => {
    assert.deepEqual(browserOpenCommand("win32", "http://x/"), ["cmd", ["/c", "start", "", "http://x/"]])
  })
  test("linux/other uses `xdg-open <url>`", () => {
    assert.deepEqual(browserOpenCommand("linux", "http://x/"), ["xdg-open", ["http://x/"]])
  })

  test("openBrowser never throws even when the opener binary is missing (H13)", async () => {
    // Strip PATH so the opener spawn ENOENTs. The async 'error' event must be swallowed, not crash
    // the process. We assert no unhandled error fires within a short window.
    const savedPath = process.env.PATH
    let unhandled: unknown
    const onUnhandled = (e: unknown): void => {
      unhandled = e
    }
    process.on("uncaughtException", onUnhandled)
    try {
      process.env.PATH = ""
      assert.doesNotThrow(() => openBrowser("http://127.0.0.1:1/"))
      await new Promise((r) => setTimeout(r, 200))
      assert.equal(unhandled, undefined)
    } finally {
      process.env.PATH = savedPath
      process.removeListener("uncaughtException", onUnhandled)
    }
  })
})

// --- spawn helpers: run node with arbitrary args / the CLI from source under tsx ---

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

function runNode(nodeArgs: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, nodeArgs, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return runNode(["--import", "tsx", CLI_ENTRY, ...args], env)
}

/** Does GET /api/runs on this port answer 200? An independent probe of a claimed viewer URL. */
function apiUp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpGet({ host: "127.0.0.1", port, path: "/api/runs", timeout: 1000 }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on("error", () => resolve(false))
    req.on("timeout", () => {
      req.destroy()
      resolve(false)
    })
  })
}

describe("CLI end-to-end (--fake)", () => {
  let home: string
  let wf: string

  before(() => {
    home = mkdtempSync(join(tmpdir(), "omegacode-cli-test-"))
    wf = join(home, "smoke.workflow.js")
    writeFileSync(
      wf,
      `export const meta = { name: "smoke", description: "fake smoke test" }\n` +
        `const a = await agent("say hi")\n` +
        `return a\n`,
    )
  })

  after(() => {
    rmSync(home, { recursive: true, force: true })
  })

  test("--fake --no-serve --json runs a real workflow and emits JSON (M18: --fake not swallowed)", async () => {
    const r = await runCli(["run", wf, "--fake", "--no-serve", "--json"], { OMEGACODE_HOME: home })
    assert.equal(r.code, 0, `nonzero exit; stderr=${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.equal(out.status, "completed")
    assert.match(out.runId, /^wf_/)
    assert.match(String(out.result), /fake/)
    // --no-serve means no viewer; URL must be absent rather than a dead link (M22).
    assert.equal(out.url, undefined)
  })

  test("--fake works even when the workflow file follows --fake directly (regression for M18)", async () => {
    // Old parseArgs: `--fake <file>` swallowed the file as --fake's value → no file → usage error,
    // OR (worse, with the file elsewhere) ran REAL agents. Here the file is the token after --fake.
    const r = await runCli(["run", "--fake", wf, "--no-serve", "--json"], { OMEGACODE_HOME: home })
    assert.equal(r.code, 0, `stderr=${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.equal(out.status, "completed")
  })

  test("invalid --provider exits 1 with a friendly message, not a stack (M5)", async () => {
    const r = await runCli(["run", wf, "--provider", "claude", "--fake", "--no-serve"], { OMEGACODE_HOME: home })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /--provider must be one of/)
    assert.doesNotMatch(r.stderr, /at \w+ \(/) // no stack frames
  })

  test("--provider opencode and --provider pi are accepted (fake round-trip)", async () => {
    for (const provider of ["opencode", "pi"]) {
      const r = await runCli(["run", wf, "--provider", provider, "--fake", "--no-serve", "--json"], { OMEGACODE_HOME: home })
      assert.equal(r.code, 0, `stderr=${r.stderr}`)
      assert.equal(JSON.parse(r.stdout).status, "completed")
    }
  })

  test("doctor resolves bins via env overrides and flags below-minimum versions as OUTDATED", { skip: process.platform === "win32" }, async () => {
    // Stub binaries: opencode reports an outdated version, pi a current one.
    const ocStub = join(home, "fake-opencode")
    const piStub = join(home, "fake-pi")
    writeFileSync(ocStub, "#!/bin/sh\necho 1.15.0\n")
    writeFileSync(piStub, "#!/bin/sh\necho 0.79.1\n")
    chmodSync(ocStub, 0o755)
    chmodSync(piStub, 0o755)
    const r = await runCli(["doctor"], { OMEGACODE_HOME: home, OPENCODE_BIN: ocStub, PI_BIN: piStub })
    assert.equal(r.code, 0, `stderr=${r.stderr}`)
    assert.match(r.stdout, /opencode\s+: 1\.15\.0 — OUTDATED \(< 1\.16\.2\)/)
    assert.match(r.stdout, /pi\s+: 0\.79\.1\n/)
    assert.doesNotMatch(r.stdout, /pi\s+: 0\.79\.1 — OUTDATED/)
  })

  test("a meta.defaultProvider typo is rejected at run setup, even under --fake", async () => {
    const bad = join(home, "bad-default-provider.workflow.js")
    writeFileSync(
      bad,
      `export const meta = { name: "bad", description: "typo'd provider", defaultProvider: "open-code" }\n` +
        `return await agent("say hi")\n`,
    )
    const r = await runCli(["run", bad, "--fake", "--no-serve"], { OMEGACODE_HOME: home })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /invalid provider "open-code"/)
  })

  test("invalid --sandbox (typo for read-only) is rejected (H14)", async () => {
    const r = await runCli(["run", wf, "--sandbox", "readonly", "--fake", "--no-serve"], { OMEGACODE_HOME: home })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /--sandbox must be one of/)
  })

  test("invalid --concurrency (0) is rejected as not a positive integer (M12)", async () => {
    const r = await runCli(["run", wf, "--concurrency", "0", "--fake", "--no-serve"], { OMEGACODE_HOME: home })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /--concurrency must be a positive integer/)
  })

  test("invalid --concurrency (NaN) is rejected — would have hung the run forever (M12)", async () => {
    const r = await runCli(["run", wf, "--concurrency", "abc", "--fake", "--no-serve"], { OMEGACODE_HOME: home })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /--concurrency must be/)
  })

  test("invalid --budget (abc → NaN) is rejected instead of silently disabling the budget (M20)", async () => {
    const r = await runCli(["run", wf, "--budget", "abc", "--fake", "--no-serve"], { OMEGACODE_HOME: home })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /--budget must be a non-negative number/)
  })

  test("empty --budget= is rejected, not silently 0 (Number('') === 0)", async () => {
    const r = await runCli(["run", wf, "--budget=", "--fake", "--no-serve"], { OMEGACODE_HOME: home })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /--budget must be a non-negative number/)
  })

  test("invalid --effort is rejected (M20)", async () => {
    const r = await runCli(["run", wf, "--effort", "turbo", "--fake", "--no-serve"], { OMEGACODE_HOME: home })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /--effort must be one of/)
  })

  test("--effort none (codex's no-reasoning level) is accepted", async () => {
    const r = await runCli(["run", wf, "--effort", "none", "--fake", "--no-serve", "--json"], { OMEGACODE_HOME: home })
    assert.equal(r.code, 0, `stderr=${r.stderr}`)
    assert.equal(JSON.parse(r.stdout).status, "completed")
  })

  test("bare --resume (no runId) is rejected, not a silent fresh run (M20)", async () => {
    const r = await runCli(["run", wf, "--resume", "--fake", "--no-serve"], { OMEGACODE_HOME: home })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /--resume requires a value/)
  })

  test("invalid --port (no value) is rejected with a usage message, not a socket stack (M20)", async () => {
    const r = await runCli(["run", wf, "--fake", "--port"], { OMEGACODE_HOME: home })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /--port requires a value/)
  })

  test("out-of-range --port is rejected", async () => {
    const r = await runCli(["run", wf, "--fake", "--no-serve", "--port", "99999"], { OMEGACODE_HOME: home })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /--port must be an integer/)
  })

  test("malformed --args JSON is a friendly usage error, not a stack", async () => {
    const r = await runCli(["run", wf, "--fake", "--no-serve", "--args", "{not json}"], { OMEGACODE_HOME: home })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /--args is not valid JSON/)
    assert.doesNotMatch(r.stderr, /at Object\./)
  })

  test("valid --args JSON is accepted", async () => {
    const r = await runCli(["run", wf, "--fake", "--no-serve", "--json", "--args", '{"x":1}'], { OMEGACODE_HOME: home })
    assert.equal(r.code, 0, `stderr=${r.stderr}`)
    assert.equal(JSON.parse(r.stdout).status, "completed")
  })
})

describe("ensureViewer never claims a dead URL (M22)", () => {
  let home: string
  let wf: string

  before(() => {
    home = mkdtempSync(join(tmpdir(), "omegacode-viewer-test-"))
    wf = join(home, "smoke.workflow.js")
    writeFileSync(
      wf,
      `export const meta = { name: "smoke", description: "fake smoke test" }\n` + `return await agent("hi")\n`,
    )
  })

  after(() => {
    rmSync(home, { recursive: true, force: true })
  })

  test("when no viewer is up and none can be spawned, url is absent and no view: line is printed", async () => {
    // Under tsx (this spawn) the entry is a .ts file, so ensureViewer cannot self-spawn a viewer;
    // with nothing on the port it must report failure. The old code returned the URL regardless
    // (after a 5s stall) and the CLI printed a dead link.
    const port = String(20000 + Math.floor(Math.random() * 20000))
    const r = await runCli(["run", wf, "--fake", "--json", "--port", port], { OMEGACODE_HOME: home })
    assert.equal(r.code, 0, `stderr=${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.equal(out.status, "completed")
    assert.equal(out.url, undefined)
    assert.doesNotMatch(r.stderr, /view:/)
  })

  test("when a viewer IS already up on the port, its URL is reused and claimed", async () => {
    const port = String(20000 + Math.floor(Math.random() * 20000))
    const server = spawn(process.execPath, ["--import", "tsx", CLI_ENTRY, "serve", "--port", port], {
      env: { ...process.env, OMEGACODE_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    })
    try {
      await new Promise<void>((res, rej) => {
        const t = setTimeout(() => rej(new Error("serve never printed its banner")), 8000)
        server.stderr.on("data", (d) => {
          if (String(d).includes("viewer:")) {
            clearTimeout(t)
            res()
          }
        })
        server.on("error", rej)
      })
      const r = await runCli(["run", wf, "--fake", "--json", "--port", port], { OMEGACODE_HOME: home })
      assert.equal(r.code, 0, `stderr=${r.stderr}`)
      const out = JSON.parse(r.stdout)
      assert.equal(out.status, "completed")
      assert.equal(out.url, `http://127.0.0.1:${port}/#/run/${out.runId}`)
    } finally {
      server.kill("SIGTERM")
      await new Promise((res) => server.on("close", res))
    }
  })
})

describe("CLI invoked through a bin symlink (M22/L17)", () => {
  // npm installs `bin` entries as SYMLINKS, and Node realpath-resolves the entry module — so
  // import.meta.url is the real cli file while argv[1] keeps the symlink path. The old entrypoint
  // guard compared the two as plain path strings, never matched through a symlink, and the
  // installed CLI exited 0 having printed NOTHING; ensureViewer's self-spawned `serve` child died
  // the same way (5s stall every run, viewer never auto-starting). tsx realpaths the entry
  // identically, so the bug reproduces from source; the suite below repeats it against a built bin.
  const posix = process.platform !== "win32" // symlinkSync needs privileges on Windows
  let dir = ""

  before(() => {
    if (!posix) return
    dir = mkdtempSync(join(tmpdir(), "omegacode-symlink-test-"))
  })

  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test("help through a symlinked entry prints help, not a silent exit-0 no-op", { skip: !posix }, async () => {
    const link = join(dir, "omegacode-link.ts") // .ts name so tsx transpiles it; the TARGET is the real entry
    symlinkSync(CLI_ENTRY, link)
    const r = await runNode(["--import", "tsx", link, "help"])
    assert.equal(r.code, 0, `stderr=${r.stderr}`)
    assert.match(r.stdout, /omegacode — run JS workflow files/)
  })
})

describe("npm-installed bin symlink against a built entry (M22/L17 e2e)", () => {
  // The published failure mode end-to-end: bundle the CLI to a real .js (what dist/cli.js is),
  // invoke it through an extension-less symlink (exactly what `npm install -g` creates), and check
  // both halves: main() runs at all (L17), and `run` self-spawns the viewer through the symlink
  // and only then claims a URL (M22). The bundle is written under node_modules/.cache so its
  // external imports still resolve against this repo's node_modules; packaging.test.ts stubs
  // dist/cli.js, so nothing else exercises a real built entry behind a symlink.
  const root = fileURLToPath(new URL("..", import.meta.url))
  const esbuild = join(root, "node_modules", ".bin", "esbuild")
  // Needs symlinks (privileged on Windows) and the esbuild binary (a tsup transitive dep).
  const canRun = process.platform !== "win32" && existsSync(esbuild)
  const port = 20000 + Math.floor(Math.random() * 20000)
  let outDir = ""
  let home = ""
  let bin = ""
  let wf = ""

  before(() => {
    if (!canRun) return
    const cache = join(root, "node_modules", ".cache")
    mkdirSync(cache, { recursive: true })
    outDir = mkdtempSync(join(cache, "omegacode-bin-test-"))
    execFileSync(
      esbuild,
      [
        join(root, "src", "cli.ts"),
        "--bundle",
        "--format=esm",
        "--platform=node",
        "--packages=external",
        `--outfile=${join(outDir, "cli.js")}`,
      ],
      { stdio: "pipe" },
    )
    home = mkdtempSync(join(tmpdir(), "omegacode-bin-home-"))
    bin = join(home, "omegacode") // extension-less symlink, exactly like npm's bin install
    symlinkSync(join(outDir, "cli.js"), bin)
    wf = join(home, "smoke.workflow.js")
    writeFileSync(
      wf,
      `export const meta = { name: "smoke", description: "fake smoke test" }\n` + `return await agent("hi")\n`,
    )
  })

  after(() => {
    if (!canRun) return
    // Reap the detached idle-shutdown viewer the M22 test self-spawned. Match by argv (the unique
    // outDir path) rather than by port: an idle viewer closes its server, so a port lookup can
    // miss a process that hasn't exited yet. Best effort — pgrep exits 1 when nothing matches.
    try {
      const pids = execFileSync("pgrep", ["-f", outDir], { encoding: "utf8" }).trim().split("\n").filter(Boolean)
      for (const pid of pids) process.kill(Number(pid), "SIGTERM")
    } catch {
      // nothing to reap
    }
    if (home) rmSync(home, { recursive: true, force: true })
    if (outDir) rmSync(outDir, { recursive: true, force: true })
  })

  test("L17: the symlinked bin prints help — the old guard made it a silent exit-0 no-op", { skip: !canRun }, async () => {
    const r = await runNode([bin, "help"])
    assert.equal(r.code, 0, `stderr=${r.stderr}`)
    assert.match(r.stdout, /omegacode — run JS workflow files/)
  })

  test("M22: run through the symlinked bin self-spawns the viewer and claims a LIVE url", { skip: !canRun }, async () => {
    const r = await runNode([bin, "run", wf, "--fake", "--json", "--port", String(port)], { OMEGACODE_HOME: home })
    assert.equal(r.code, 0, `stderr=${r.stderr}`)
    const out = JSON.parse(r.stdout)
    assert.equal(out.status, "completed")
    // The url must be claimed (the self-spawn survived the symlink — the old guard silently killed
    // the child, stalling the full 5s poll and never starting a viewer) and must actually answer.
    assert.equal(out.url, `http://127.0.0.1:${port}/#/run/${out.runId}`)
    assert.equal(await apiUp(port), true, "claimed url but /api/runs does not answer")
  })
})

describe("CLI runs --prune --keep validation (H12)", () => {
  let home: string

  before(() => {
    home = mkdtempSync(join(tmpdir(), "omegacode-prune-test-"))
    // Seed three run dirs with the minimum the lister/pruner inspects.
    const runs = join(home, "runs")
    for (const id of ["wf_aaaaaa", "wf_bbbbbb", "wf_cccccc"]) {
      const d = join(runs, id)
      writeFileSync(ensureDir(d, "journal.jsonl"), "")
    }
  })

  after(() => {
    rmSync(home, { recursive: true, force: true })
  })

  test("--prune --keep abc is rejected (would have NaN→slice(NaN)→delete ALL runs)", async () => {
    const r = await runCli(["runs", "--prune", "--keep", "abc"], { OMEGACODE_HOME: home })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /--keep must be a non-negative integer/)
    // And the runs must still be there.
    const after = await runCli(["runs"], { OMEGACODE_HOME: home })
    assert.match(after.stdout, /wf_aaaaaa/)
    assert.match(after.stdout, /wf_cccccc/)
  })

  test("--prune --keep -1 (negative) is rejected", async () => {
    const r = await runCli(["runs", "--prune", "--keep=-1"], { OMEGACODE_HOME: home })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /--keep must be a non-negative integer/)
  })

  test("--prune --keep= (empty) is rejected — Number('') is 0, which would prune EVERYTHING", async () => {
    const r = await runCli(["runs", "--prune", "--keep="], { OMEGACODE_HOME: home })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /--keep must be a non-negative integer/)
    const after = await runCli(["runs"], { OMEGACODE_HOME: home })
    assert.match(after.stdout, /wf_aaaaaa/)
    assert.match(after.stdout, /wf_bbbbbb/)
    assert.match(after.stdout, /wf_cccccc/)
  })

  test("--prune --keep 10 keeps all three (fewer than the cap) and reports it", async () => {
    const r = await runCli(["runs", "--prune", "--keep", "10"], { OMEGACODE_HOME: home })
    assert.equal(r.code, 0, `stderr=${r.stderr}`)
    assert.match(r.stdout, /pruned 0 run\(s\)/)
    const after = await runCli(["runs"], { OMEGACODE_HOME: home })
    assert.match(after.stdout, /wf_aaaaaa/)
  })
})

describe("CLI serve stops on a single SIGTERM (M19)", () => {
  let home: string

  before(() => {
    home = mkdtempSync(join(tmpdir(), "omegacode-serve-test-"))
  })

  after(() => {
    rmSync(home, { recursive: true, force: true })
  })

  test("serve closes and exits on the first SIGTERM", async () => {
    // A high, likely-free port; the test only cares that serve exits on the signal, not the port.
    const port = String(20000 + Math.floor(Math.random() * 20000))
    const child = spawn(process.execPath, ["--import", "tsx", CLI_ENTRY, "serve", "--port", port], {
      env: { ...process.env, OMEGACODE_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    })
    // Wait for the "viewer: ..." banner so we know the server is listening before we signal it.
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("serve never printed its banner")), 8000)
      child.stderr.on("data", (d) => {
        if (String(d).includes("viewer:")) {
          clearTimeout(t)
          res()
        }
      })
      child.on("error", rej)
    })
    const exited = new Promise<number | null>((res) => child.on("close", (code) => res(code)))
    child.kill("SIGTERM")
    const code = await Promise.race([
      exited,
      new Promise<"timeout">((res) => setTimeout(() => res("timeout"), 5000)),
    ])
    if (code === "timeout") {
      child.kill("SIGKILL")
      assert.fail("serve did not exit within 5s of a single SIGTERM")
    }
    // Process exited cleanly after the signal (close() resolved → main() returned).
    assert.ok(code === 0 || code === null, `unexpected exit code ${code}`)
  })
})

describe("CLI misc commands", () => {
  test("no args prints help and exits 0", async () => {
    const r = await runCli([])
    assert.equal(r.code, 0)
    assert.match(r.stdout, /omegacode — run JS workflow files/)
  })

  test("unknown command exits 1", async () => {
    const r = await runCli(["frobnicate"])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Unknown command: frobnicate/)
  })

  test("run with no file prints usage and exits 1", async () => {
    const r = await runCli(["run"])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /usage: omegacode run/)
  })
})

// tiny helper: create the dir for `join(dir, leaf)` and return that full path
function ensureDir(dir: string, leaf: string): string {
  mkdirSync(dir, { recursive: true })
  return join(dir, leaf)
}
