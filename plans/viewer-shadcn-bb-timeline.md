# Plan: rebuild the viewer as a Vite + React + shadcn app that looks like bb's timeline

Migrate the `agent-workflows` viewer from the current no-build vanilla-JS SPA to a **Vite + React 19 +
Tailwind v4 + shadcn/ui** app whose run-detail / chat feed is a near-pixel match for **bb's thread
timeline**. The strategy is not "reimplement bb's look" — it's **port bb's actual timeline + conversation
components** (bb is already this exact stack) and feed them our data.

Scaffold with the provided preset:
```
pnpm dlx shadcn@latest init --preset bH32 --template vite
```

---

## 1. Why this is mostly *porting*, not *designing*

bb's UI (`~/bb/apps/app`) is already the target stack — confirmed from its `components.json` +
`package.json`:
- **shadcn/ui**, style `radix-mira`, `cssVariables: true`, tokens in `src/components/ui/theme.css`,
  base color `neutral`, **icon library `hugeicons`** (not lucide), aliases `@/components`, `@/lib/utils`,
  `@/components/ui`, `@/hooks`.
- **React 19 + Vite + `@tailwindcss/vite` (Tailwind v4)**, `react-router-dom` 7, `@tanstack/react-query`
  5, `react-markdown`, `react-resizable-panels`, Radix primitives, `class-variance-authority`, `clsx`,
  `tailwind-merge`.
- A reusable component library in `src/components/ui/` we can lift almost verbatim:
  `conversation.tsx`, `detail-card.tsx`, `event-code-block.tsx`, `bottom-anchored-scroll-body.tsx`
  (sticky-bottom streaming scroll), `disclosure.tsx` / `expandable-line.tsx` (collapsibles),
  `markdown-preview.*`, `diff-stats-tally.tsx`, `copy-button.tsx`, `image-lightbox.tsx`, `badge.tsx`,
  `dialog.tsx`, `drawer.tsx`, `empty-state.tsx`, `height-transition.tsx`, `icon.tsx`.
- The timeline renderers in `src/components/thread/timeline/`: `ThreadTimelineRows.tsx`,
  `ExpandableTimelineRow.tsx`, `TimelineRowHeader.tsx`, `TimelineRowDetails.tsx`,
  `TerminalOutputBlock.tsx`, `ToolCallDetailBlock.tsx`, `TimelineFileDiffBlock.tsx`,
  `ConversationMessageContent.tsx`, `TimelineDetailScroll.tsx`, `TimelineStatusIndicator.tsx`,
  `TimelineWorkingIndicator.tsx`, `TimelineTitleView.tsx`.

So the bH32 preset gives us the same shadcn baseline; then we copy bb's theme tokens + the components
above and adapt them to our data. (See the earlier `PARITY.md`-style exploration notes for bb's exact
OKLch palette, Inter/Fira-Code typography, radius/spacing scale, and ANSI palette `--ansi-0..15`.)

## 2. Our data is already the right shape

The current viewer's data contract maps cleanly onto bb's timeline item model:

| bb timeline concept | our data | source |
|---|---|---|
| `userMessage` | `ChatChunk{kind:"meta"}.prompt` | `agents/<i>.jsonl` |
| `agentMessage` | coalesced `ChatChunk{kind:"text"}` | `agents/<i>.jsonl` |
| `reasoning` | `ChatChunk{kind:"reasoning"}` | `agents/<i>.jsonl` |
| `commandExecution` / `toolCall` | `ChatChunk{kind:"tool", name, input}` + paired `tool-result{output,isError}` | `agents/<i>.jsonl` |
| `fileChange` (diff card) | a `tool` whose `name` is `fileChange` / Edit/Write, `input.changes`/diff | `agents/<i>.jsonl` |
| status / working indicator | `ChatChunk{kind:"status"}` + run/agent `state` | transcript + `events.jsonl` |
| workflow phase tree (`workflow` work row) | `WorkflowEvent{type:"phase"\|"agent"}` snapshot | `events.jsonl` |

Endpoints stay as-is (`GET /api/runs`, `/api/runs/:id`, `/api/runs/:id/stream`,
`/api/runs/:id/agents/:index`, `.../stream`) — see §6 for one streaming refinement.

## 3. Target architecture

```
agent-workflows/
  viewer/                      # NEW: the Vite + React + shadcn app (scaffolded by the bH32 preset)
    index.html, vite.config.ts, tsconfig.json, package.json
    src/
      main.tsx, App.tsx, router
      components/ui/           # shadcn primitives (from preset) + ported bb ui/* (conversation, detail-card, …)
      components/timeline/     # ported/adapted bb timeline renderers
      features/
        runs/                  # RunListSidebar, useRuns()
        run/                   # RunDetail (phase tree), useRunStream()
        agent/                 # AgentChatFeed (the bb-style conversation), useAgentStream()
      lib/                     # api client, sse hook, formatters, cn()
    dist/                      # vite build output (static)
  src/server/serve.ts          # serves viewer/dist instead of the hand-written web/
```

- **Build:** `viewer` is its own Vite app. `agent-workflows build` runs `vite build` (output
  `viewer/dist`) and the existing tsup `onSuccess` copies `viewer/dist` → `dist/web` (so
  `node dist/cli.js serve` serves it, same as today). `serve.ts`'s `WEB_DIR` points at the built assets;
  its `/api/*` + SSE routes are unchanged.
- **Dev:** `agent-workflows serve` keeps serving the API; `vite dev` (in `viewer/`) runs the UI with a
  proxy: `server.proxy` forwards `/api` to the API server (default `:4123`) so SSE + fetch work in dev
  with HMR. A `viewer:dev` script wires this.
- **Offline:** no CDNs/remote fonts — bundle Inter + Fira Code (or bb's fonts) as assets (Tailwind v4 +
  Vite handle this); everything ships in `dist/web`.
- **Packaging note:** the repo currently uses npm; the preset uses pnpm. Decide once (M0): either make
  the root a pnpm workspace with `viewer` as a member, or keep `viewer` a standalone pnpm sub-project the
  root build shells into. Recommended: **pnpm workspace** (matches bb, one lockfile, clean `--filter`).

## 4. shadcn setup (preset bH32)

1. `cd viewer && pnpm dlx shadcn@latest init --preset bH32 --template vite` — scaffolds Vite+React+TS,
   Tailwind v4, `components.json`, `lib/utils.ts` (`cn()`), and the preset's theme tokens/style.
2. Reconcile the theme with bb: copy bb's `src/components/ui/theme.css` token values (the OKLch
   palette, `--radius`, spacing, **`--ansi-0..15`** for terminal output, `--diff-added/removed`,
   `--success/--destructive/--attention`, `--subtle-foreground`) so colors match exactly. Keep dark mode
   (we're dark today); bb ships both — adopt its light+dark.
3. Add the primitives we need: `pnpm dlx shadcn@latest add button badge card dialog drawer separator
   tooltip dropdown-menu scroll-area collapsible resizable` (resizable = `react-resizable-panels`
   wrapper for the 3-pane layout). Match bb's icon choice (**hugeicons**) for visual identity.
4. Port bb's higher-level `components/ui/*` that aren't stock shadcn: `conversation.tsx`,
   `detail-card.tsx`, `event-code-block.tsx`, `bottom-anchored-scroll-body.tsx`, `disclosure.tsx`,
   `expandable-line.tsx`, `markdown-preview.*`, `diff-stats-tally.tsx`, `copy-button.tsx` — adjust only
   their imports/props to our data. (These are the load-bearing "look like bb" pieces.)

## 5. The three views (all using ported bb components)

- **RunListSidebar** (`features/runs`): bb sidebar/list idiom — status glyph + bold name + dim
  `N agents · duration · time-ago`; active row highlight. `useRuns()` via react-query (poll or the
  runs-stream from §6).
- **RunDetail / phase tree** (`features/run`): reuse bb's `WorkflowWorkRowBody` structure (phase
  group-boxes via `detail-card`, agent rows via the timeline row + `TimelineStatusIndicator` /
  `TimelineWorkingIndicator`). `useRunStream()` folds the `events.jsonl` SSE into the snapshot.
- **AgentChatFeed** (`features/agent`) — *the headline*: render the agent transcript exactly like a bb
  thread conversation:
  - `meta.prompt` → a user/instruction message (bb `ConversationMessageContent`, user style).
  - `text` → assistant message via `markdown-preview` (`react-markdown` — code fences in Fira Code,
    links, lists), wrapped in bb's `conversation.tsx` row.
  - `reasoning` → `disclosure` "Thinking" section, dimmed/italic, with the left guide-line.
  - `tool` + matched `tool-result` → bb `ToolCallDetailBlock` (args clamped + "Show more") paired with
    `TerminalOutputBlock` (ANSI→themed HTML via `--ansi-*`); `fileChange` → `TimelineFileDiffBlock` +
    `diff-stats-tally`.
  - streaming → `bottom-anchored-scroll-body` for sticky-bottom autoscroll + `TimelineWorkingIndicator`
    shimmer while `status:running`.
  - Layout: `react-resizable-panels` three-pane on wide screens; `drawer`/`dialog` on narrow.
  - Routing: `react-router` `#/run/:id/agent/:index` (keep current hash routes).

## 6. Data layer (React) + the streaming refinement

- **react-query** for all snapshot fetches (`/api/runs`, `/api/runs/:id`, `/api/runs/:id/agents/:index`)
  — caching, dedupe, `staleTime`, `invalidate` on SSE events (bb's pattern: fetch state, subscribe to
  changes, refetch/patch).
- **`useSse(url, onEvent)` hook** wrapping `EventSource` with auto-reconnect + cleanup.
- Adopt the **snapshot-then-stream-from-cursor** change we already scoped: the agent/run SSE takes
  `?since=<cursor>` (line count) and sets `id:` per event so reconnects resume via `Last-Event-ID` and
  never re-replay history. React flow: `useQuery(snapshot)` → render → `useSse(stream?since=count)` →
  append deltas. (Do this as part of M4 so the React data layer is built on it from the start.)
- Optionally replace the run-list 5s poll with a `runs`-dir watch SSE so new runs appear instantly.

## 7. Milestones

- **M0 — scaffold + workspace.** Create `viewer/`, run the bH32 preset, decide pnpm-workspace, wire
  `viewer:dev` (vite + `/api` proxy to `:4123`) and `build` (vite build → tsup copies to `dist/web`).
  *Exit:* `vite dev` shows a placeholder hitting the real API; `node dist/cli.js serve` serves the built
  app.
- **M1 — theme + primitives parity.** Copy bb's `theme.css` tokens (incl. ANSI + diff colors), fonts,
  and `cn()`; add the stock shadcn primitives; verify a styled button/card/badge matches bb.
- **M2 — port bb ui/* components.** `conversation`, `detail-card`, `event-code-block`,
  `bottom-anchored-scroll-body`, `disclosure`, `markdown-preview`, `diff-stats-tally`, `copy-button`,
  status/working indicators — compiling in isolation (a small stories/preview page like bb's Ladle).
- **M3 — run list + phase tree.** RunListSidebar + RunDetail with react-query; static (snapshot-only)
  first. *Exit:* lists runs and renders the parity-audit phase tree like bb's workflow row.
- **M4 — agent chat feed (the bb conversation look) + streaming.** AgentChatFeed with the full message
  taxonomy (§5), `useSse` + snapshot-from-cursor (§6), sticky-bottom, working indicator. *Exit:* opening
  a Codex agent shows a bb-style conversation that streams live; ANSI command output is colored; file
  changes render as diffs.
- **M5 — layout + routing + polish.** `react-resizable-panels` 3-pane, drawer on narrow, hash routes,
  empty states, light/dark toggle. Visual diff against bb screenshots.
- **M6 — serve integration + retire the old SPA.** `serve.ts` serves `viewer/dist`; delete the
  hand-written `web/{app.js,style.css,index.html}`; `doctor`/README updated.

## 8. Risks / open questions

1. **Two build systems** (tsup for the CLI, Vite for the viewer) + npm→pnpm. Mitigate with a pnpm
   workspace and a single `build` that runs both; keep the CLI bundle dependency-free (the viewer's React
   deps live only in `viewer/`, shipped as static `dist/web` — they never enter the CLI bundle).
2. **What exactly does preset `bH32` ship?** Verify after `init` (style, tokens, base color, icon lib).
   If it diverges from bb's `radix-mira`/hugeicons/neutral, reconcile in M1 by overwriting `theme.css` +
   `components.json` to bb's values.
3. **Porting bb components** — these are the user's own project, so reuse is fine; the work is swapping
   bb's domain types (`ThreadEventItem`/`TimelineRow`) for ours (`ChatChunk`/`WorkflowEvent`). Keep a
   thin adapter (`lib/to-timeline.ts`) mapping our chunks → the props bb's components expect, so the
   components stay close to upstream and easy to re-sync.
4. **ANSI rendering** needs an ANSI→HTML step (bb has one in `TerminalOutputBlock`); port it with the
   `--ansi-*` tokens. (This also closes the "ANSI" gap from the earlier bb-learnings list.)
5. **Bundle size / offline** — bundle fonts locally; tree-shake hugeicons; the static `dist/web` must
   work with no network. Confirm size is reasonable (it's a local tool, so lenient).
6. **Markdown safety** — `react-markdown` with a safe config (no raw HTML) since content is model-authored.
7. **Keeping it read-only** — no mutations; react-query is purely for reads + SSE-driven invalidation.

## 9. Validation

- **Visual parity:** screenshot the new RunDetail + AgentChatFeed and compare side-by-side with bb's
  thread timeline (same run shapes). Iterate until a reviewer can't easily tell them apart.
- **Streaming:** a live Codex run shows text streaming, the working shimmer, tool cards + colored output,
  with sticky-bottom autoscroll; reconnect (kill/restore network) resumes via `Last-Event-ID` without
  re-replaying.
- **Build/serve:** `agent-workflows build && node dist/cli.js serve` serves the React app from
  `dist/web`; offline (airplane mode) still renders.
- **No regressions:** all existing API endpoints unchanged; `runs`/`doctor`/`run --open` still work.

Delete this file when the migration lands.
