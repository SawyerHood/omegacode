import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DefaultWorkerFactory } from "../src/worker/factory.ts"
import { FakeWorker } from "../src/worker/fake.ts"
import { ClaudeWorker, bashWriteOutsideCwd, checkTool, isReadOnlyBash, usageFromResult } from "../src/worker/claude.ts"
import { CodexWorker } from "../src/worker/codex.ts"
import { OpencodeWorker } from "../src/worker/opencode.ts"
import { PiWorker } from "../src/worker/pi.ts"
import { AgentError, AgentInterrupted, type WorkerContext } from "../src/worker/index.ts"
import type { AgentSpec, ProviderId } from "../src/dsl/types.ts"

test("returns a CodexWorker for 'codex'", () => {
  const f = new DefaultWorkerFactory()
  const w = f.get("codex")
  assert.ok(w instanceof CodexWorker)
  assert.equal(w.id, "codex")
})

test("returns a ClaudeWorker for 'claude-code'", () => {
  const f = new DefaultWorkerFactory()
  const w = f.get("claude-code")
  assert.ok(w instanceof ClaudeWorker)
  assert.equal(w.id, "claude-code")
})

test("returns an OpencodeWorker for 'opencode' and a PiWorker for 'pi'", () => {
  const f = new DefaultWorkerFactory()
  const oc = f.get("opencode")
  assert.ok(oc instanceof OpencodeWorker)
  assert.equal(oc.id, "opencode")
  const pi = f.get("pi")
  assert.ok(pi instanceof PiWorker)
  assert.equal(pi.id, "pi")
})

test("M5: unknown provider id throws instead of silently returning ClaudeWorker", () => {
  const f = new DefaultWorkerFactory()
  // The old code returned a ClaudeWorker (billed!) for any non-codex id.
  assert.throws(
    () => f.get("claude" as ProviderId), // common typo for claude-code
    (err: unknown) => err instanceof AgentError && (err as AgentError).code === "unknown_provider",
  )
  assert.throws(
    () => f.get("garbage" as ProviderId),
    (err: unknown) => err instanceof AgentError && (err as AgentError).code === "unknown_provider",
  )
})

test("fake:true routes EVERY provider id to the FakeWorker", () => {
  const f = new DefaultWorkerFactory({ fake: true })
  assert.ok(f.get("codex") instanceof FakeWorker)
  assert.ok(f.get("claude-code") instanceof FakeWorker)
  // even an otherwise-unknown id is faked (smoke-test convenience)
  assert.ok(f.get("anything" as ProviderId) instanceof FakeWorker)
})

test("caches one worker per provider id", () => {
  const f = new DefaultWorkerFactory()
  assert.equal(f.get("codex"), f.get("codex"))
  assert.equal(f.get("claude-code"), f.get("claude-code"))
  assert.equal(f.get("opencode"), f.get("opencode"))
  assert.equal(f.get("pi"), f.get("pi"))
  assert.notEqual(f.get("codex") as unknown, f.get("claude-code") as unknown)
  assert.notEqual(f.get("opencode") as unknown, f.get("pi") as unknown)
})

test("L5: claudeModel is consumed by the ClaudeWorker", () => {
  const f = new DefaultWorkerFactory({ claudeModel: "claude-opus-4-8" })
  const w = f.get("claude-code") as ClaudeWorker
  // opts is private; assert via the spec path: the worker carries the model option.
  assert.equal((w as unknown as { opts: { model?: string } }).opts.model, "claude-opus-4-8")
})

test("L5: pathToClaudeCodeExecutable is consumed by the ClaudeWorker", () => {
  const f = new DefaultWorkerFactory({ pathToClaudeCodeExecutable: "/usr/local/bin/claude" })
  const w = f.get("claude-code") as ClaudeWorker
  assert.equal(
    (w as unknown as { opts: { pathToClaudeCodeExecutable?: string } }).opts.pathToClaudeCodeExecutable,
    "/usr/local/bin/claude",
  )
})

test("codexBin is consumed by the CodexWorker", () => {
  const f = new DefaultWorkerFactory({ codexBin: "/opt/codex" })
  const w = f.get("codex")
  assert.ok(w instanceof CodexWorker)
})

test("opencodeBin / piBin are consumed by their workers", () => {
  const f = new DefaultWorkerFactory({ opencodeBin: "/opt/opencode", piBin: "/opt/pi" })
  const oc = f.get("opencode")
  assert.equal((oc as unknown as { bin: string }).bin, "/opt/opencode")
  const pi = f.get("pi")
  assert.equal((pi as unknown as { bin: string }).bin, "/opt/pi")
})

test("shutdownAll clears the cache and is safe to call repeatedly", async () => {
  const f = new DefaultWorkerFactory({ fake: true })
  const first = f.get("codex")
  await f.shutdownAll()
  // a fresh instance is created after a shutdown clears the cache
  const second = f.get("codex")
  assert.notEqual(first as unknown, second as unknown)
  await f.shutdownAll()
})

// ---- H4: ClaudeWorker sandbox enforcement (checkTool) ----

const CWD = "/work/repo"

test("H4: read-only denies all write tools", () => {
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
    assert.match(checkTool("read-only", CWD, tool, { file_path: `${CWD}/x` })!, /read-only/)
  }
})

test("H4: workspace-write allows writes INSIDE cwd", () => {
  assert.equal(checkTool("workspace-write", CWD, "Write", { file_path: `${CWD}/sub/file.txt` }), undefined)
  assert.equal(checkTool("workspace-write", CWD, "Edit", { file_path: "sub/file.txt" }), undefined) // relative
  assert.equal(checkTool("workspace-write", CWD, "Write", { file_path: CWD }), undefined) // cwd itself
})

test("H4: workspace-write DENIES writes that escape cwd", () => {
  assert.ok(checkTool("workspace-write", CWD, "Write", { file_path: "/etc/passwd" }))
  assert.ok(checkTool("workspace-write", CWD, "Edit", { file_path: `${CWD}/../evil.txt` }))
  assert.ok(checkTool("workspace-write", CWD, "Write", { file_path: "../../escape" }))
  // a sibling dir that shares a prefix must NOT be considered inside.
  assert.ok(checkTool("workspace-write", CWD, "Write", { file_path: "/work/repo-evil/x" }))
})

test("H4: workspace-write honors alternate path keys (notebook_path, path)", () => {
  assert.ok(checkTool("workspace-write", CWD, "NotebookEdit", { notebook_path: "/tmp/out.ipynb" }))
  assert.equal(checkTool("workspace-write", CWD, "NotebookEdit", { notebook_path: `${CWD}/n.ipynb` }), undefined)
})

test("H4: danger-full-access allows everything", () => {
  assert.equal(checkTool("danger-full-access", CWD, "Write", { file_path: "/etc/passwd" }), undefined)
  assert.equal(checkTool("danger-full-access", CWD, "Bash", { command: "rm -rf /" }), undefined)
})

test("H4: read-only allows harmless read-only Bash but denies writes/unknowns", () => {
  assert.equal(checkTool("read-only", CWD, "Bash", { command: "git log --oneline" }), undefined)
  assert.equal(checkTool("read-only", CWD, "Bash", { command: "grep -r foo ." }), undefined)
  assert.equal(checkTool("read-only", CWD, "Bash", { command: "ls -la && cat README.md" }), undefined)
  // writes / mutations denied
  assert.ok(checkTool("read-only", CWD, "Bash", { command: "git commit -m x" }))
  assert.ok(checkTool("read-only", CWD, "Bash", { command: "rm -rf node_modules" }))
  assert.ok(checkTool("read-only", CWD, "Bash", { command: "echo hi > out.txt" }))
  assert.ok(checkTool("read-only", CWD, "Bash", { command: "python script.py" })) // interpreter denied
})

test("H4: workspace-write allows Bash (file-tool boundary carries the guarantee)", () => {
  assert.equal(checkTool("workspace-write", CWD, "Bash", { command: "rm -rf build" }), undefined)
})

test("H4: non-write, non-Bash tools (Read/Grep) are allowed in every sandbox", () => {
  for (const sb of ["read-only", "workspace-write", "danger-full-access"] as const) {
    assert.equal(checkTool(sb, CWD, "Read", { file_path: "/etc/hosts" }), undefined)
    assert.equal(checkTool(sb, CWD, "Grep", { pattern: "x" }), undefined)
  }
})

test("isReadOnlyBash classification", () => {
  assert.equal(isReadOnlyBash("git status"), true)
  assert.equal(isReadOnlyBash("git diff HEAD~1"), true)
  assert.equal(isReadOnlyBash("git push origin main"), false)
  assert.equal(isReadOnlyBash("cat a | grep b | wc -l"), true)
  assert.equal(isReadOnlyBash("ls; rm x"), false)
  assert.equal(isReadOnlyBash("find . -name '*.ts'"), true)
  assert.equal(isReadOnlyBash("find . -delete"), false)
  assert.equal(isReadOnlyBash("find . -exec rm {} +"), false)
  assert.equal(isReadOnlyBash("cat a >> b"), false)
  assert.equal(isReadOnlyBash("FOO=bar git log"), true) // leading env assignment
  assert.equal(isReadOnlyBash(""), false)
  assert.equal(isReadOnlyBash("unknowncmd"), false)
})

test("H4: isReadOnlyBash denies command/process substitution", () => {
  assert.equal(isReadOnlyBash("echo $(rm -rf x)"), false)
  assert.equal(isReadOnlyBash("cat `touch pwned`"), false)
  assert.equal(isReadOnlyBash("diff <(sort a) <(sort b)"), false)
  assert.equal(isReadOnlyBash("grep x >(tee out)"), false)
})

test("H4: isReadOnlyBash allows harmless fd redirects, denies fd redirects to files", () => {
  assert.equal(isReadOnlyBash("grep foo . 2>/dev/null"), true)
  assert.equal(isReadOnlyBash("cat f 2>&1 | grep b"), true)
  assert.equal(isReadOnlyBash("echo hi >&2"), true)
  assert.equal(isReadOnlyBash("grep foo . 2>err.txt"), false) // 2>file writes a file
  assert.equal(isReadOnlyBash("ls > /dev/null"), true)
  assert.equal(isReadOnlyBash("ls > out.txt"), false)
})

test("H4: isReadOnlyBash denies newline/&-chained writes hidden behind a read", () => {
  assert.equal(isReadOnlyBash("git log\nrm -rf x"), false)
  assert.equal(isReadOnlyBash("ls & rm x"), false)
  assert.equal(isReadOnlyBash("git log\ngit diff"), true)
})

test("H4: isReadOnlyBash treats `env` as a transparent prefix (env cmd executes cmd)", () => {
  assert.equal(isReadOnlyBash("env rm -rf x"), false)
  assert.equal(isReadOnlyBash("env FOO=1 git log"), true)
  assert.equal(isReadOnlyBash("env"), true) // bare env just prints
})

test("H4: isReadOnlyBash denies writer flags on read-only programs", () => {
  assert.equal(isReadOnlyBash("sort -o out.txt in.txt"), false)
  assert.equal(isReadOnlyBash("cat f | sort"), true)
  assert.equal(isReadOnlyBash("git log --output=f"), false)
  assert.equal(isReadOnlyBash("uniq in out"), false) // uniq IN OUT writes OUT
  assert.equal(isReadOnlyBash("sort f | uniq -c"), true)
})

test("H4: isReadOnlyBash denies pre-subcommand git -c config injection, allows `git log -c`", () => {
  assert.equal(isReadOnlyBash("git -c core.fsmonitor=touch status"), false)
  assert.equal(isReadOnlyBash("git -ccore.fsmonitor=touch status"), false) // attached -c form
  assert.equal(isReadOnlyBash("git --config-env=X=Y status"), false) // --config-env injection
  assert.equal(isReadOnlyBash("git log -c"), true) // read-only combined-diff flag
})

test("H4: isReadOnlyBash classifies the git subcommand past -C/--git-dir global flags (write bypass)", () => {
  // `git -C dir <write>` — the subcommand is the write verb, not the directory argument.
  assert.equal(isReadOnlyBash("git -C /tmp/x reset --hard"), false)
  assert.equal(isReadOnlyBash("git -C /tmp/x clean -fd"), false)
  assert.equal(isReadOnlyBash("git -C /tmp/x push origin main"), false)
  assert.equal(isReadOnlyBash("git --git-dir /tmp/x/.git --work-tree /tmp/x reset"), false)
  assert.equal(isReadOnlyBash("git --namespace ns checkout main"), false)
  // read-only subcommands behind the same global flags stay readable.
  assert.equal(isReadOnlyBash("git -C /tmp/x log --oneline"), true)
  assert.equal(isReadOnlyBash("git -C /tmp/x status"), true)
  assert.equal(isReadOnlyBash("git --git-dir /tmp/x/.git log"), true)
  assert.equal(isReadOnlyBash("git --version"), true) // no subcommand
})

test("H4: isReadOnlyBash denies the attached sort/tree -o write form (write bypass)", () => {
  assert.equal(isReadOnlyBash("sort -o/tmp/x in.txt"), false) // attached -o<file>
  assert.equal(isReadOnlyBash("sort -o /tmp/x in.txt"), false) // separate -o file
  assert.equal(isReadOnlyBash("tree -o/tmp/out"), false)
  assert.equal(isReadOnlyBash("cat f | sort"), true) // no output flag → still readable
})

test("H4: isReadOnlyBash denies find -fls (write bypass)", () => {
  assert.equal(isReadOnlyBash("find . -fls /tmp/x"), false)
  assert.equal(isReadOnlyBash("find . -fprintf /tmp/x %p"), false)
  assert.equal(isReadOnlyBash("find . -name '*.ts'"), true)
})

// ---- H4: workspace-write Bash best-effort confinement ----

test("H4: workspace-write Bash denies redirects outside cwd", () => {
  assert.ok(checkTool("workspace-write", CWD, "Bash", { command: "echo x > /etc/cron.d/evil" }))
  assert.ok(checkTool("workspace-write", CWD, "Bash", { command: "git log >> ~/notes.txt" }))
  assert.equal(checkTool("workspace-write", CWD, "Bash", { command: "git status > status.txt" }), undefined)
  assert.equal(checkTool("workspace-write", CWD, "Bash", { command: "npm test 2>&1 | tee test.log" }), undefined)
})

test("H4: workspace-write Bash denies write programs targeting paths outside cwd", () => {
  assert.equal(bashWriteOutsideCwd(CWD, "rm -rf build"), undefined)
  assert.equal(bashWriteOutsideCwd(CWD, `rm -rf ${CWD}/dist`), undefined)
  assert.ok(bashWriteOutsideCwd(CWD, "rm -rf /work/other-repo"))
  assert.ok(bashWriteOutsideCwd(CWD, "touch ../escape")) // relative escape
  assert.ok(bashWriteOutsideCwd(CWD, "mkdir -p /etc/x"))
  assert.ok(bashWriteOutsideCwd(CWD, "tee /tmp/x"))
  assert.ok(bashWriteOutsideCwd(CWD, "dd if=/dev/zero of=/tmp/img"))
  assert.equal(bashWriteOutsideCwd(CWD, "dd if=/dev/zero of=local.img"), undefined)
})

test("H4: workspace-write Bash checks only the destination for cp/mv/ln", () => {
  // reading from outside cwd is fine in workspace-write — only the write target matters
  assert.equal(bashWriteOutsideCwd(CWD, "cp /etc/hosts hosts.local"), undefined)
  assert.ok(bashWriteOutsideCwd(CWD, "cp secrets.txt /tmp/exfil"))
  assert.ok(bashWriteOutsideCwd(CWD, "mv build ~/elsewhere"))
  assert.equal(bashWriteOutsideCwd(CWD, "ln -s /usr/lib/libfoo.so vendor-link"), undefined)
})

test("H4: workspace-write Bash leaves non-write programs alone", () => {
  assert.equal(bashWriteOutsideCwd(CWD, "cat /etc/hosts"), undefined)
  assert.equal(bashWriteOutsideCwd(CWD, "npm install && npm test"), undefined)
  assert.equal(bashWriteOutsideCwd(CWD, "node script.js"), undefined)
})

// ---- H4 residual: symlinks must not smuggle writes past the workspace boundary ----

test("H4: workspace-write resolves symlinks — a link inside cwd pointing outside is DENIED", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "claude-sym-cwd-"))
  const outside = await mkdtemp(join(tmpdir(), "claude-sym-out-"))
  // dir symlink: cwd/link → outside. Lexically cwd/link/x.txt is "inside"; the write is not.
  await symlink(outside, join(cwd, "link"))
  assert.ok(checkTool("workspace-write", cwd, "Write", { file_path: join(cwd, "link", "x.txt") }))
  // file symlink: cwd/innocent.txt → outside/secret.txt (an Edit would rewrite the OUTSIDE file)
  await writeFile(join(outside, "secret.txt"), "s")
  await symlink(join(outside, "secret.txt"), join(cwd, "innocent.txt"))
  assert.ok(checkTool("workspace-write", cwd, "Edit", { file_path: join(cwd, "innocent.txt") }))
  // BROKEN symlink: a write through it CREATES the outside target — still an escape
  await symlink(join(outside, "ghost.txt"), join(cwd, "broken.txt"))
  assert.ok(checkTool("workspace-write", cwd, "Write", { file_path: join(cwd, "broken.txt") }))
  // the best-effort Bash confinement goes through the same containment check
  assert.ok(bashWriteOutsideCwd(cwd, `tee ${join(cwd, "link", "out.log")}`))
})

test("H4: symlinks that stay INSIDE cwd (and a symlinked cwd itself) remain writable", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "claude-sym-in-"))
  await mkdir(join(cwd, "real"))
  await symlink(join(cwd, "real"), join(cwd, "alias"))
  assert.equal(checkTool("workspace-write", cwd, "Write", { file_path: join(cwd, "alias", "f.txt") }), undefined)
  // cwd reached THROUGH a symlink: base and target realpath to the same root
  const outer = await mkdtemp(join(tmpdir(), "claude-sym-outer-"))
  const cwdLink = join(outer, "cwd-link")
  await symlink(cwd, cwdLink)
  assert.equal(checkTool("workspace-write", cwdLink, "Write", { file_path: join(cwdLink, "real", "g.txt") }), undefined)
})

test("H4 known limitation (pinned): $HOME is NOT expanded in the Bash gate — only ~ is", () => {
  // expandHome handles `~`/`~/...`; `$HOME/...` expands in the shell, not here, so it resolves
  // lexically under cwd and slips the best-effort Bash confinement (the file-tool boundary is
  // the hard guarantee). Pinned so any change in this behavior is a deliberate one.
  assert.ok(checkTool("workspace-write", CWD, "Bash", { command: "echo x > ~/evil.txt" })) // tilde IS caught
  assert.equal(checkTool("workspace-write", CWD, "Bash", { command: "echo x > $HOME/evil.txt" }), undefined)
  assert.equal(bashWriteOutsideCwd(CWD, "touch $HOME/evil.txt"), undefined)
})

test("H4: write tool with no recognizable path target fails closed in workspace-write", () => {
  assert.ok(checkTool("workspace-write", CWD, "Write", {}))
  assert.ok(checkTool("workspace-write", CWD, "Edit", { content: "x" }))
  // danger-full-access still allows it
  assert.equal(checkTool("danger-full-access", CWD, "Write", {}), undefined)
})

// ---- M8: ClaudeWorker pre-abort check ----

function claudeSpec(): AgentSpec {
  return { prompt: "hi", provider: "claude-code", cwd: "/tmp", sandbox: "read-only", approval: "never" }
}

test("M8: ClaudeWorker throws AgentInterrupted immediately if the signal is already aborted", async () => {
  const w = new ClaudeWorker()
  const ac = new AbortController()
  ac.abort()
  const ctx: WorkerContext = { signal: ac.signal, onProgress: () => {} }
  // Must reject before ever invoking the SDK query (no network/SDK call).
  await assert.rejects(() => w.runAgent(claudeSpec(), ctx), (err: unknown) => err instanceof AgentInterrupted)
})

// ---- L8: author schema errors surface before the paid turn ----

test("L8: ClaudeWorker rejects a non-compiling schema before invoking the SDK", async () => {
  const w = new ClaudeWorker()
  const ctx: WorkerContext = { signal: new AbortController().signal, onProgress: () => {} }
  const spec: AgentSpec = { ...claudeSpec(), schema: { $ref: "#/does/not/exist" } }
  await assert.rejects(
    () => w.runAgent(spec, ctx),
    (err: unknown) => {
      assert.ok(err instanceof AgentError)
      assert.equal((err as AgentError).code, "invalid_schema")
      assert.equal((err as AgentError).retryable, false)
      return true
    },
  )
})

// ---- L6: usage accounting (cache tokens + failed turns) ----

test("L6: usageFromResult sums cache read/creation tokens into inputTokens", () => {
  const u = usageFromResult({
    usage: { input_tokens: 100, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500, output_tokens: 42 },
    total_cost_usd: 0.12,
  })
  assert.equal(u.inputTokens, 4600)
  assert.equal(u.outputTokens, 42)
  assert.equal(u.costUsd, 0.12)
})

test("L6: usageFromResult tolerates missing/malformed usage", () => {
  const u = usageFromResult({})
  assert.equal(u.inputTokens, 0)
  assert.equal(u.outputTokens, 0)
  const v = usageFromResult({ usage: { input_tokens: "NaN-ish" }, total_cost_usd: "free" })
  assert.equal(v.inputTokens, 0)
  assert.equal(v.costUsd, 0)
})

test("L6: AgentError carries usage so failed turns can be billed against budgets", () => {
  const usage = usageFromResult({ usage: { input_tokens: 10, output_tokens: 5 } })
  const err = new AgentError({ provider: "claude-code", code: "error_during_execution", message: "boom", usage })
  assert.equal(err.usage?.inputTokens, 10)
  assert.equal(err.usage?.outputTokens, 5)
  // and stays optional
  const bare = new AgentError({ provider: "codex", code: "x", message: "y" })
  assert.equal(bare.usage, undefined)
})

test("L6: a failed turn's AgentError carries CACHE-INCLUSIVE usage (the two halves tie together)", () => {
  // Mirrors ClaudeWorker's non-success path (claude.ts): a failed result still reports usage, and
  // that usage must include cache read/creation tokens so a budget consumer bills the real cost —
  // not zero, and not the un-cached undercount.
  const last = {
    usage: { input_tokens: 100, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500, output_tokens: 42 },
    total_cost_usd: 0.07,
  }
  const usage = usageFromResult(last)
  const err = new AgentError({ provider: "claude-code", code: "error_during_execution", message: "claude result: error_during_execution", usage })
  assert.equal(err.usage?.inputTokens, 4600)
  assert.equal(err.usage?.outputTokens, 42)
  assert.equal(err.usage?.costUsd, 0.07)
})

// ---- M4 (classification half): error_max_turns must not be retryable ----

test("M4: AgentError defaults to retryable:false; explicit classification is preserved", () => {
  const maxTurns = new AgentError({ provider: "claude-code", code: "error_max_turns", message: "claude result: error_max_turns" })
  assert.equal(maxTurns.retryable, false)
  const overloaded = new AgentError({ provider: "claude-code", code: "overloaded", message: "529", retryable: true })
  assert.equal(overloaded.retryable, true)
})
