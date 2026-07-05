# Automatic Project Memory + Auto-Git — Design

Date: 2026-07-05
Status: Approved

## Goal

Make the `coder` CLI automatically remember a project across sessions, and keep a
deep, exact record of file changes — without the user manually `/resume`-ing or
running git by hand.

Two complementary layers:

- **Distilled memory** — a compact, evolving summary (decisions, conventions, file
  locations, unfinished tasks, user preferences) auto-injected into the system
  prompt each session. The high-level "what/why".
- **Auto-git** — automatic per-turn commits in the working project, giving an exact
  file-change history (`git log` / `git diff`). The deep "what changed".

## Part A — Distilled project memory

- **Storage:** DB table `project_memory(project_id PK REFERENCES projects ON DELETE
  CASCADE, content TEXT, updated_at)`. One row per project.
- **Injection:** on startup (DB configured), load the project's memory and append it
  to the system prompt as `# Project memory (auto-maintained across sessions)`,
  next to the existing `AGENTS.md` context. Recent git commit subjects (last ~5) are
  appended under it as "Recent changes" so the model sees concrete file history.
- **Update timing:** on `/clear`, `/new`, `/exit`. Summarize (existing memory + the
  just-finished conversation) via one model call with **tools disabled** and a
  dedicated summarizer instruction, save to DB, re-inject. Guarded by a `memoryDirty`
  flag (only when there were new assistant turns) and a non-empty coder chain.
  Best-effort: any failure is swallowed and never blocks the user.
- **Commands:** `/memory` (view), `/memory clear` (wipe row), `/memory save` (force
  an update now).
- **No DB:** memory is unavailable; `/memory` explains how to configure Postgres.

## Part B — Auto-git

- **Target:** `process.cwd()` — the project being coded in, never the app dir.
- **Init:** on startup, if enabled and cwd is not a repo, `git init` and note it.
- **Per-turn commit:** after a request where a mutating tool ran (`file_write`,
  `file_edit`, `multi_edit`, `delete_file`, `move_file`, `copy_file`, `make_dir`,
  `generate_image`), run `git add -A` then `git commit`. Subject = the user's request
  (first line, truncated ~72 chars); body lists changed files (`git diff --cached
  --name-status`). Mutations detected from the tool-call event stream.
- **Never fails:** commit with fallback `-c user.name=... -c user.email=...` when git
  has no identity, so commits always succeed. If git isn't installed, disable
  auto-git with a single warning.
- **Toggle:** `/autocommit on|off` (status when no arg); `autoCommit` flag in
  `agent.config.json`, default **on**.

## Agent changes

`runAgent` / `runLocalAgent` / `runAgentWithRetry` / `runAgentChain` gain two options:
- `noTools?: boolean` — send no tools (used for summarization).
- `instructions?: string` — override the system prompt for this call (summarizer
  prompt) without mutating shared config.

## Files

- `src/db.ts` — table + `getProjectMemory` / `saveProjectMemory` / `clearProjectMemory`.
- `src/git.ts` (new) — `hasGit`, `isRepo`, `initRepo`, `commitAll`, `recentCommits`.
- `src/agent.ts`, `src/local-agent.ts` — `noTools` + `instructions` options.
- `src/cli.ts` — orchestration: load/inject/flush memory, git init + per-turn commit,
  `/memory` + `/autocommit`, mutation tracking, `/help`.

## Testing

- `src/git.ts` against a temp dir (init, commit, recentCommits, fallback identity).
- `noTools` plumbing (no tool specs sent).
- Memory flush guards (dirty flag, empty chain, no DB).
- `tsc --noEmit`.

## Out of scope (YAGNI)

- Auto-resume of full transcripts (rejected in favor of distilled memory).
- Per-turn memory summarization (too costly with slow local models).
- Committing on Ctrl+C (immediate exit stays immediate; `/exit` saves).
