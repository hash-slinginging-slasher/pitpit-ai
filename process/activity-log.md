## 2026-07-06

### Git repo initialized and pushed to GitHub
**Files Changed:** none (repo setup only)

- Initialized git in `D:\openrouter\app`, added remote `origin` → https://github.com/hash-slinginging-slasher/pitpit-ai.git
- Initial commit (40 files) pushed to `main`; `secrets.json`, `.env`, `node_modules/` excluded via existing `.gitignore`

**Deployment:** Not deployed (repo setup)

---

## 2026-07-05

### Fix: memory prompt trap (reasoning leakage) + answer-from-memory
**Files Changed:** `src/cli.ts`

- Follow-up to the memory fix below: the reasoning model (nemotron) fixated on the instruction "never emit placeholders like '(No output)'" and saved meta-commentary ("(No output) is not allowed; we output nothing. So just leave blank.") as the memory — the classic "don't think about elephants" trap.
- Rewrote `MEMORY_SYSTEM` to be positive/clean (no mention of placeholder strings); it now just says to write the updated memory file with user + project facts.
- Hardened `isJunkMemory()` to also reject reasoning leakage ("output nothing", "leave blank", "is not allowed", "(No output)", "we output").
- Added a header to the injected `# Project memory` block instructing the agent to answer from memory directly and NOT search files / claim ignorance when the answer is present (the agent had been running list_dir for "what's my dog's name?").
- Cleared the leaked memory row for project 5.

**Deployment:** Not deployed (local dev)
**Test Results:** typecheck 0 errors; 3/3 real nemotron summarization runs now yield clean "## User - Dogs: Crystal, Chip, Dale" with no leakage. End-to-end recall verified with nemotron (tools enabled): asked "whats my dogs name?" with the memory block injected → answered "Crystal, Chip, and Dale" with ZERO tool calls (no list_dir/file search).

---

### Fix: project memory dropped personal facts + saved junk
**Files Changed:** `src/cli.ts`

- Symptom: user told the agent their dogs' names, `/exit` saved memory, but on the next session the agent didn't recall them and searched files instead. Root causes: (1) the summarizer prompt was scoped to project/coding facts only and explicitly dropped "one-off details," so personal facts were filtered out; (2) the nemotron model returned the literal string `(No output)` for a chit-chat-only conversation and we saved it, overwriting memory with junk.
- Broadened `MEMORY_SYSTEM` to preserve existing memory and capture user-shared personal facts (name, people/pets, preferences) alongside project details/TODOs; instructs the model to echo existing memory unchanged when nothing new and never emit placeholders.
- Added `isJunkMemory()` guard in `flushMemory()` — non-answers ("(No output)", "none", "n/a", too-short) no longer overwrite good memory; prints "(no new memory saved)".
- Cleared the bad `(No output)` memory row already saved for the "diferent test" project.

**Deployment:** Not deployed (local dev)
**Test Results:** typecheck 0 errors; isJunkMemory 12/12; real summarization against nemotron free now yields "Dog names: Crystal, Chip, Dale"

---

### Automatic project memory + auto-git
**Files Changed:** `src/db.ts`, `src/git.ts` (new), `src/agent.ts`, `src/local-agent.ts`, `src/config.ts`, `src/cli.ts`, `docs/plans/2026-07-05-project-memory-autogit-design.md` (new)

- Added two linked "memory" layers to the coder CLI (design doc in docs/plans):
  - **Distilled project memory** — new `project_memory` DB table (per project). Loaded on startup and injected into the system prompt as `# Project memory`, so the agent remembers across sessions automatically. Updated on `/clear`, `/new`, `/exit` (and `/memory save`) by summarizing the conversation via one model call with tools disabled. Commands: `/memory`, `/memory save`, `/memory clear`.
  - **Auto-git** — new `src/git.ts` helper. On startup, `git init`s the working project if needed; after any turn where a mutating tool ran (file_write/edit/multi_edit/delete/move/copy/make_dir/generate_image), auto-commits `git add -A` with the user's request as the subject and changed files as the body. Commits use a fallback `-c user.name/email` so they never fail on unconfigured git. Disables itself (with a warning) if git isn't installed. Toggle: `/autocommit on|off` + `autoCommit` flag in agent.config.json (default on). Last ~5 commit subjects are surfaced into the project-memory prompt block as "Recent changes".
- Agent plumbing: `runAgent`/`runLocalAgent`/`runAgentWithRetry`/`runAgentChain` gained `noTools` and `instructions` options (used for clean summarization without mutating shared config).
- Updated `/help`.

**Deployment:** Not deployed (local dev)
**Test Results:** typecheck 0 errors. git helper 11/11 (init/commit/fallback-identity/recentCommits against a temp repo); summarizer plumbing 3/3 (noTools sends no tools, instructions override applied); project_memory DB round-trip 4/4 against live Postgres

---

### Add /clear command to CLI (wipes screen like cls)
**Files Changed:** `src/cli.ts`

- Added `/clear` to clear the conversation context (matches Claude Code's `/clear`). Implemented as an alias of the existing `/new` — both reset the message history, start a fresh saved session, and reset the session token counter. Updated `/help`.
- `/clear` and `/new` now also wipe the terminal screen + scrollback (ESC[2J ESC[3J ESC[H, the `cls` equivalent) and reprint the banner + context/tip line, returning to the initial-load view. Extracted `printIntro()`/`clearScreen()` and reused them for startup so the two stay in sync; the context/tip line is recomputed from AGENTS.md on each clear.

**Deployment:** Not deployed (local dev)
**Test Results:** typecheck 0 errors; verified clear/new reset messages/session/totals, the cls escape byte sequence, and that unrelated commands are unaffected

---

### /rename now sets the terminal window title
**Files Changed:** `src/cli.ts`

- `/rename <name>` previously only updated the saved `name` (shown once in the banner) — the terminal window title (e.g. `C:\Windows\system32\cmd.exe`) never changed. Added `setWindowTitle()` which emits the OSC `ESC ]0;<name> BEL` sequence, so the window/tab is renamed live on `/rename` and also on launch (uses the persisted name). No-ops when stdout isn't a TTY so piped/redirected runs don't leak escape codes.
- Updated `/help` text accordingly.

**Deployment:** Not deployed (local dev)
**Test Results:** typecheck 0 errors; verified OSC byte sequence (`1b 5d 30 3b … 07`) and non-TTY no-op

---

### Add local llama.cpp model support
**Files Changed:** `src/local-agent.ts` (new), `src/agent.ts`, `src/config.ts`, `src/cli.ts`, `web/server.ts`, `web/index.html`

- Added support for running the coder agent against a local `llama-server` (llama.cpp, OpenAI-compatible). Models prefixed `local/` (e.g. `local/Ornith-1.0-9B`) route to a new chat/completions tool loop instead of OpenRouter — because llama.cpp does NOT implement the `/responses` API the `@openrouter/agent` SDK uses (feature request ggml-org/llama.cpp#19138 is still open).
- `src/local-agent.ts`: streams `/v1/chat/completions`, assembles streamed tool-call fragments, executes the existing client tools (server tools like OpenRouter web_search are skipped), and emits the same `AgentEvent` stream. Handles reasoning via both `delta.reasoning_content` and inline `<think>…</think>` tags (chunk-boundary-safe splitter).
- `config.ts`: `isLocalModel()`, `LOCAL_MODEL_PREFIX`, and `localBaseUrl()` (env `LLAMA_BASE_URL` → secrets.json `localBaseUrl` → default `http://localhost:8080/v1`).
- `agent.ts`: `runAgent()` branches to the local runner for `local/*` models, so failover chains and retries work unchanged and mixed local/remote chains are allowed.
- `cli.ts`: a chain of only-local models no longer requires an OpenRouter API key.
- Web UI: "+ Add local" input in the chain panel to append a `local/<name>` model; Settings now reports the configured local base URL.

**Deployment:** Not deployed (local dev)
**Test Results:** typecheck 0 errors; validated the runner end-to-end against a mock OpenAI streaming server — 9/9 checks (SSE parse, tool-call fragment assembly, tool execution, both reasoning paths, usage summing)

---

## 2026-07-04

### /init skips when already initialized
**Files Changed:** `src/cli.ts`, `README.md`

- `/init` re-ran the full exploration every time even when AGENTS.md already existed. Now it skips with a note ("already exists ... use /init force to regenerate") if AGENTS.md is present, and only runs when absent or when `/init force` (`--force`/`-f`) is given.
- Verified: in a dir with AGENTS.md, `/init` prints the skip note and makes no model call.

**Deployment:** Not deployed (local dev)
**Test Results:** typecheck 0 errors; skip behavior confirmed

---

### Fix: assistant text empty (outputText fallback)
**Files Changed:** `src/agent.ts`

- Some models (e.g. nemotron) return an empty `response.outputText` even though they stream text via message items, so `result.text` was empty — assistant replies saved as blank in the DB and conversation history lost prior answers.
- `runAgent` now reconstructs the assistant text from `response.output` message items when `outputText` is empty.
- Verified live: free nemotron model now returns `result.text` = "PONG" (was empty). Typecheck clean.

**Deployment:** Not deployed (local dev)
**Test Results:** typecheck 0 errors; live model call returns non-empty text

---

### Settings: reveal + copy secrets; server localhost-only
**Files Changed:** `web/server.ts`, `web/index.html`

- Added `GET /api/settings/reveal` returning the full OpenRouter key + Postgres URL so the user can view/copy/verify them.
- Settings UI: "show key" now reveals the real key; added Copy-key and Copy-URL buttons (clipboard).
- Security: bound the HTTP server to `127.0.0.1` only (was all interfaces) since secrets are now readable — prevents network access to the reveal endpoint.
- Verified: reveal returns the saved 73-char key (…3bf4) + db URL; typecheck clean.

**Deployment:** Not deployed (local dev)
**Test Results:** typecheck 0 errors; reveal endpoint verified

---

### Local Postgres: projects registry + session history
**Files Changed:** `src/db.ts` (new), `src/config.ts`, `web/server.ts`, `web/index.html`, `web/projects.html` (new), `src/cli.ts`, `package.json`

- Added a Postgres data layer (`pg`, 0 vulns) storing `projects`, `sessions`, `messages` (schema auto-created). Connection URL comes from the web Settings panel (secrets.json) or `DATABASE_URL` env; `readDatabaseUrl()` in config.
- Set up a dedicated `openrouter_agent` database on the user's local Postgres 18.3 (trust auth) and saved the URL to secrets.json.
- CLI: registers the cwd as a project on startup, saves each turn's user/assistant messages to a session (titled from the first message); `/sessions` lists, `/resume <id>` reloads a past session. DB is optional — failures are caught and history is just skipped.
- Web: Settings gained a Postgres URL field + Test-connection button; new `/api/db/test`, `/api/projects`, `/api/projects/:id/sessions`, `/api/sessions/:id`; new **Projects** page (📁 link) browsing projects → sessions → transcript.
- Verified end-to-end against live Postgres: create DB, schema, upsert project, create session, add messages, read back, cleanup — all pass; web endpoints return correct data; `/api/db/test` → PostgreSQL 18.3. Typecheck clean.

**Deployment:** Not deployed (local dev)
**Test Results:** typecheck 0 errors; 0 dependency vulnerabilities; DB CRUD + web APIs verified live

---

### CLI: /rename and /theme commands
**Files Changed:** `src/cli.ts`, `src/config.ts`, `README.md`

- Added `/rename <name>` (persists `name`) and `/theme [name]` (lists or switches theme, reprints banner, persists `theme`).
- 6 themes: default, ocean, matrix, sunset, mono, grape — each remaps the 5 accent color slots (256-color ANSI); `applyTheme()` mutates the shared color object. Theme applied at startup from config.
- config.ts: added `theme` field (default 'default') and `updateConfigFile(patch)` helper that merges into agent.config.json preserving other fields.
- Verified: `/theme` lists with current marked, `/theme matrix` reprints + persists, `/rename` persists; config values confirmed on disk. Typecheck clean.

**Deployment:** Not deployed (local dev)
**Test Results:** typecheck 0 errors; persistence confirmed

---

### Fix: CLI hung after /exit (fs.watch kept process alive)
**Files Changed:** `src/cli.ts`

- The config file watcher (live model-follow) was never closed, so its open handle kept Node's event loop alive — after "Goodbye." the process hung instead of returning to the shell.
- Fix: `watcher.unref()`, `watcher.close()` on exit, and explicit `process.exit(0)` at end of main.
- Verified: piping `/exit` exits with code 0 in ~0ms (no hang).

**Deployment:** Not deployed (local dev)
**Test Results:** clean exit confirmed; typecheck 0 errors

---

### CLI: self-erasing thinking spinner, ASCII glyphs, Ctrl+C
**Files Changed:** `src/cli.ts`, `README.md`

- Reasoning now shows as a single animated `thinking` line that erases itself the instant the model produces output (via `\r` + `\x1b[K`), instead of one `thinking…` line per step — fixes terminal flooding on reasoning models.
- Replaced all user-facing Unicode glyphs (⏺ ↳ ⋯ ▶ ⚠ ✓ › · — …) with ASCII so the classic Windows cmd.exe console stops rendering them as `□` boxes.
- Added `Ctrl+C` (rl SIGINT) to quit cleanly in addition to `/exit`. `renderer.done()` stops the spinner before usage/error output.
- README: note that cmd.exe auto-scrolls during output; recommend Windows Terminal / VS Code terminal for scrollback.
- Verified: banner + prompt render as clean ASCII. Typecheck clean.

**Deployment:** Not deployed (local dev)
**Test Results:** typecheck 0 errors; ASCII banner confirmed

---

### /init command + auto-loaded project context (AGENTS.md)
**Files Changed:** `src/cli.ts`, `README.md`

- Added `/init`: runs a one-off task telling the agent to explore the working dir (list_dir/glob/grep/file_read) and write a concise `AGENTS.md` (summary, stack, structure, run/test, conventions).
- On startup the CLI reads `AGENTS.md` from the cwd and appends it to the system prompt as "Project context", so later sessions already know the project. Banner shows "Loaded project context" or a `/init` tip. `/init` refreshes the context after it writes the file. Init task is not added to chat history.
- Verified: launching in a dir containing AGENTS.md prints "Loaded project context from AGENTS.md." Typecheck clean. (Live /init generation not run — needs a model turn.)

**Deployment:** Not deployed (local dev)
**Test Results:** typecheck 0 errors; context auto-load confirmed

---

### generate_image honors the Image failover chain
**Files Changed:** `src/tools/generate-image.ts`

- `generate_image` now iterates the full Image agent chain (not just the primary): tries each model in order, failing over to the next on HTTP error / no-image / bad-format, and reports the model used (+ `failedOver`). Returns a combined error listing all attempts if every model fails.
- Typecheck clean. (Live generation not run — paid image models; awaiting user go-ahead.)

**Deployment:** Not deployed (local dev)
**Test Results:** typecheck 0 errors

---

### Image Agent tab: show only image-output models
**Files Changed:** `web/index.html`

- Narrowed the Image tab filter from "image input OR output" to output-only (`outputModalities.includes('image')`), so it lists just the ~10 image-generation models (Gemini image, GPT image, openrouter/auto). Matches the Image agent's create purpose. Hint updated to "image generation".

**Deployment:** Not deployed (local dev)
**Test Results:** verified 10 image-output models via API

---

### Add 8 tools: file ops, web_fetch, multi_edit, doc/image
**Files Changed:** `src/tools/{make-dir,copy-file,move-file,multi-edit,web-fetch,view-document,generate-image}.ts`, `src/tools/index.ts`, `src/config.ts`, `package.json`, `README.md`

- File ops: `make_dir`, `copy_file`, `move_file` (cross-drive EXDEV fallback), `multi_edit` (atomic multi find/replace on one file).
- `web_fetch`: fetch a URL, strip HTML to text, 12k cap, 20s timeout; rejects non-http.
- `view_document`: read PDF (pdf-parse v2 `PDFParse`), spreadsheets (SheetJS → CSV per sheet), CSV/TSV, and text formats; 20k cap.
- `generate_image`: creates an image via the Image agent's configured model (OpenRouter chat completions, `modalities:['image','text']`), saves the returned data URL to a file.
- Deps: added `pdf-parse`; replaced vulnerable npm `xlsx` with SheetJS's secure CDN build (`xlsx-0.20.3.tgz`) → `npm audit` clean (0 vulns).
- System prompt updated with the fuller tool list + usage guidance.
- Verified: make_dir/copy/move/multi_edit; view_document on real PDF, generated XLSX, and CSV; web_fetch on example.com; generate_image reaches OpenRouter authenticated (errors correctly when the Image model isn't image-output). Typecheck clean.

**Deployment:** Not deployed (local dev)
**Test Results:** typecheck 0 errors; 0 dependency vulnerabilities; all tools exercised

---

### Add cross-platform delete_file tool
**Files Changed:** `src/tools/delete-file.ts`, `src/tools/index.ts`, `src/config.ts`, `README.md`

- Added `delete_file` so deletions don't depend on the shell (no `rm`/`del`, no approval prompt). Directories require `recursive: true`; guards refuse deleting a filesystem/drive root or the current working directory.
- Registered in the tool list; system prompt now tells the agent to use it instead of shell rm/del.
- Verified: root guard, cwd guard, missing-file, dir-without-recursive all error correctly; file delete and recursive dir delete succeed. Typecheck clean.

**Deployment:** Not deployed (local dev)
**Test Results:** typecheck 0 errors; all delete_file cases confirmed

---

### Collapse reasoning output (stop CLI flooding)
**Files Changed:** `src/cli.ts`, `README.md`

- Reasoning models (e.g. nemotron) were streaming their full chain-of-thought to the terminal, flooding scrollback. The renderer now collapses reasoning to a single `⋯ thinking…` line per step by default.
- Added `/think` to toggle full reasoning display; `renderer.reset()` per turn re-arms the thinking indicator. Text and tool output render as before.
- Typecheck clean.

**Deployment:** Not deployed (local dev)
**Test Results:** typecheck 0 errors

---

### OS-aware agent (Windows commands, not Unix)
**Files Changed:** `src/config.ts`, `src/tools/shell.ts`

- The agent was emitting Unix commands (`rm`, `ls`) that fail in cmd.exe on Windows. Added `osInfo()` to detect the host OS (e.g. "Windows 11 Pro") and shell, and injected `{os}` + `{shellGuidance}` into the system prompt so the model uses native commands (`del`, `dir`, `type`, `rmdir /s /q`) and prefers the cross-platform file tools.
- Made the `shell` tool's own description OS-specific (cmd syntax vs POSIX).
- Verified: detects "Windows 11 Pro" / cmd.exe; resolved system prompt contains the OS line and Windows guidance. Typecheck clean.

**Deployment:** Not deployed (local dev)
**Test Results:** typecheck 0 errors; OS detection + prompt injection confirmed

---

### Redesign: 3 agents (Coder/Image/Doc) with failover chains
**Files Changed:** `src/config.ts`, `src/agent.ts`, `src/cli.ts`, `web/server.ts`, `web/index.html`, `agent.config.json`

- Replaced the single active model with three agent kinds — coder / image / doc — each an ordered failover chain (index 0 = primary, rest are backups).
- Web UI: three tabs; each shows its chain (reorder ↑↓, remove ✕) and a `+ Add` on each model card. Image tab filters to vision/image-gen models (input/output modality = image, 168); Doc tab filters to file-capable models (input modality = file, 91); Coder = all.
- Server: `GET/POST /api/agents` read/write chains; `/api/models` now returns modalities; removed `/api/select`.
- config.ts: `AgentChains` type, `readAgents`/`saveAgentChain`/`primaryModel`, legacy single-`model` migration, BOM-tolerant JSON reads.
- agent.ts: `runAgentChain` tries each model, failing over on hard errors (`onFailover` callback). CLI uses the coder chain, shows the chain in the banner/`/active`, live-follows UI edits, and reports failovers. Image/doc chains are stored (CLI wiring for them pending).
- Verified: 340 models; migration; 3-model coder chain + image chain persist; typecheck clean.

**Deployment:** Not deployed (local dev)
**Test Results:** typecheck 0 errors; chain persistence + modality filters confirmed

---

### API key via web Settings panel (no .env)
**Files Changed:** `src/config.ts`, `web/server.ts`, `web/index.html`, `.gitignore`, `README.md`

- Added a Settings panel (top-right gear) in the web UI to paste the OpenRouter API key; saved to `secrets.json` (gitignored) via new `GET/POST /api/settings`. Key is masked in responses, never sent back in full; env var still overrides.
- `config.ts`: added `readSecrets`/`saveSecrets`/`readApiKey`; `loadConfig` now sources the key from secrets.json (env override), and the "no key" error points to Settings instead of .env.
- Server reads the key live per-request so a newly-saved key works without restart.
- Verified: `/api/settings` GET→POST→GET persists and masks; `secrets.json` written; `loadConfig()` reads the key with no env/.env and doesn't throw. Typecheck clean.

**Deployment:** Not deployed (local dev)
**Test Results:** typecheck 0 errors; settings persistence + CLI key-read confirmed

---

### Web UI on port 7000 + start.bat (auto-frees the port)
**Files Changed:** `web/server.ts`, `start.bat`, `README.md`

- Changed the web server default port from 5173 to **7000** (still overridable via `PORT` env var) to avoid conflicts with the user's other apps.
- Added `start.bat`: kills any process listening on port 7000 (`netstat -ano` + `taskkill /F`), opens the browser, then runs `npm run web`. Prevents `EADDRINUSE`.
- Verified: server binds 7000 and responds; the netstat/taskkill loop finds the listening PID and frees the port. taskkill errors suppressed in the batch.

**Deployment:** Not deployed (local dev)
**Test Results:** server-on-7000 + port-free-on-kill confirmed

---

### Agent can view screenshots/images (view_image tool)
**Files Changed:** `src/tools/view-image.ts`, `src/tools/index.ts`, `src/config.ts`, `README.md`

- Added a `view_image` tool: reads an image file, base64-encodes it, and uses the SDK's `toModelOutput` to hand the pixels to the model as an `input_image` content part (Responses-API format the `@openrouter/agent` SDK supports).
- Registered it in the tool list; updated the system prompt so the agent uses it when the user mentions a screenshot/image.
- Requires a vision-capable model (selected via the UI). Supported types: png, jpg/jpeg, gif, webp, bmp.
- Verified: tool reads a real PNG, emits `data:image/png;base64,…`, and `toModelOutput` returns `[input_text, input_image]` with `detail:auto`; missing-file and bad-extension paths return clean errors. Typecheck clean.

**Deployment:** Not deployed (local dev)
**Test Results:** typecheck 0 errors; execute + toModelOutput verified against a real PNG

---

### Global `coder` command — run the agent in any project
**Files Changed:** `src/config.ts`, `bin/coder.mjs`, `package.json`, `README.md`

- Config + `.env` now resolve from the app install dir (`APP_DIR` via `import.meta.url`), not `process.cwd()`, so the shared model + API key are found no matter where the CLI is launched.
- Added `bin/coder.mjs` launcher (spawns tsx on `src/cli.ts` with `cwd = user's dir`) and a `bin` entry in package.json; `npm link` installs a global `coder` command.
- Result: `cd D:\project-a; coder` edits project-a; `cd D:\project-b; coder` edits project-b — same agent, same UI-selected model, no per-project config.
- Verified: launched `coder` from a separate dir; it found the app-dir config (model `claude-haiku-4.5`) and `/active` reported correctly. Typecheck clean, `npm link` succeeded.

**Deployment:** Not deployed (local dev)
**Test Results:** typecheck 0 errors; cross-directory launch confirmed

---

### CLI live-follows the UI's active model
**Files Changed:** `src/cli.ts`, `README.md`

- Reworked the model UX so the web UI is the single switch: the CLI no longer takes typed model ids.
- CLI now watches `agent.config.json` (`fs.watch`) and re-reads before each prompt, so switching a model in the UI updates the running CLI live (prints `▶ active model → <name> (set from UI)`).
- Prompt shows the active model as a short label, e.g. `qwen3-coder ›`. Replaced `/model <id>` with read-only `/active`.
- Verified via a harness that flips the config mid-session: prompt + live-follow notice + `/active` all reflect the change. Typecheck clean.

**Deployment:** Not deployed (local dev)
**Test Results:** typecheck 0 errors; live-follow behavior confirmed

---

### MVP: OpenRouter coding agent CLI + web model picker
**Files Changed:** `package.json`, `tsconfig.json`, `.env.example`, `.gitignore`, `agent.config.json`, `src/config.ts`, `src/agent.ts`, `src/cli.ts`, `src/tools/*.ts`, `web/server.ts`, `web/index.html`, `README.md`

- Scaffolded a TypeScript coding agent on the `@openrouter/agent` SDK (v0.4.0), grounded in OpenRouter's official `create-agent-tui` sample.
- CLI (`src/cli.ts`): interactive REPL, streaming renderer, token/cost readout, slash commands (`/model`, `/new`, `/help`, `/exit`), and an interactive shell approval gate.
- Tools: `file_read`, `file_write`, `file_edit`, `glob`, `grep` (ripgrep), `list_dir`, `shell` (made cross-platform — `cmd.exe` on Windows, `/bin/sh` elsewhere), plus OpenRouter server-side `web_search`.
- Web UI (`web/server.ts` + `index.html`): dependency-free Node server that proxies OpenRouter's model list and writes the chosen model to `agent.config.json`, which the CLI reads. API key stays server-side.
- Config layering: `.env` → `agent.config.json` → env overrides.
- Verified: `tsc --noEmit` clean; web `/api/models` returns 340 models; `/api/select` persists model preserving other fields; CLI boots and exits cleanly. Full agent turn not run (needs a real OPENROUTER_API_KEY).

**Deployment:** Not deployed (local dev)
**Test Results:** typecheck 0 errors; web API + CLI boot smoke-tested OK
