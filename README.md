# OpenRouter Coding Agent

A CLI coding agent that runs on **any OpenRouter model**, plus a small **web UI** to pick
which model it uses. Built on the [`@openrouter/agent`](https://www.npmjs.com/package/@openrouter/agent)
SDK (tool loop, streaming, cost/step limits).

```
[ Web model picker ]  ──writes──▶  agent.config.json  ──reads──▶  [ CLI coding agent ]
```

## Setup

On Windows, just run:

```bat
setup.bat
```

`setup.bat` installs everything that isn't already present and skips whatever is — so it's safe
to run once or re-run anytime. Each step is guarded by an "already installed?" check:

| Step | Installs if missing |
| --- | --- |
| **Node.js** | LTS build via `winget` (`OpenJS.NodeJS.LTS`) |
| **Dependencies** | `npm install` |
| **`coder` CLI** | `npm link` (global `coder` command) |
| **GitHub CLI** | `winget install GitHub.cli` |
| **GitHub auth** | `gh auth login` (opens a browser) + `gh auth setup-git` so `git push` works |

<details>
<summary>Manual setup (or non-Windows)</summary>

```bash
npm install
npm link          # installs a global `coder` command
```

GitHub CLI/auth are only needed if you plan to push; install `gh` and run `gh auth login`.
</details>

Then start the web UI (`start.bat`) and click **Settings** (top-right) to paste your API key
from https://openrouter.ai/keys. It's saved locally to `secrets.json` (gitignored) and used by
both the web UI and the CLI — no `.env` needed.

> An `OPENROUTER_API_KEY` environment variable, if set, overrides the saved key.

## Use it in any project

The model and API key live in **this app's** config, but the agent works on **whatever
directory you launch it from**. So:

```bash
cd D:\projects\project-a
coder                     # agent edits project-a, using the active model

cd D:\projects\project-b
coder                     # same agent + model, now editing project-b
```

`coder` is the global command created by `npm link`. Switching the model in the web UI
applies everywhere — no per-project config needed.

The model is chosen **only in the web UI**. The CLI always uses whatever is active there —
you never type or need to know model ids in the CLI.

## 1. Pick a model (web UI)

```bat
start.bat
```

`start.bat` frees port **7000** (kills whatever is on it), opens the browser, and starts the
server. (Equivalent manual command: `npm run web`; override the port with `set PORT=7001`.)

Open **http://localhost:7000**. First time: click **Settings** (top-right) and paste your
OpenRouter key. Then search/filter the ~340 models (toggle *free only*), click **Use this
model** — that becomes the **active** model (written to `agent.config.json`).

## Routers (providers)

The agent can reach several backends ("routers"). A model id's **prefix** decides where it goes,
so a single **failover chain can mix routers** — put a free model first and a paid one as backup,
across different providers. Pick the router with the source selector above the model grid.

| Prefix | Router | Auth | Example id |
|--------|--------|------|------------|
| *(none)* | **OpenRouter** | OpenRouter key | `qwen/qwen3-coder` |
| `local/` | **Local llama.cpp** | none | `local/Ornith-1.0-9B` |
| `nvidia-build/` | **NVIDIA build** ([build.nvidia.com](https://build.nvidia.com/)) | NVIDIA key | `nvidia-build/moonshotai/kimi-k2-instruct` |
| `github-models/` | **GitHub Models** ([marketplace/models](https://github.com/marketplace/models)) | GitHub token | `github-models/openai/gpt-4o` |
| `cli/claude` | **Claude Code** subscription | its own login | `cli/claude` or `cli/claude/claude-opus-4-1` |
| `cli/codex` | **OpenAI Codex** | its own login | `cli/codex` |
| `cli/gemini` | **Gemini** | API key or CLI login | `cli/gemini` |
| `cli/jules` | **Jules** (async, opens a PR) | Jules API key | `cli/jules` |

- **NVIDIA / GitHub** are OpenAI-compatible APIs. Add the key in **Settings** (or `NVIDIA_API_KEY`
  / `GITHUB_MODELS_TOKEN` env), then browse their catalog under the source selector, or paste a
  model id into the manual add-by-id box. Their prefixes are `nvidia-build/` and `github-models/`
  (deliberately distinct: OpenRouter namespaces models by author, so a plain `nvidia/…` or
  `cohere/…` id is an **OpenRouter** model and routes there, not to NVIDIA build).
- **Auth CLIs** reuse the CLI's *own* subscription login — no API key. Select the **Auth CLI**
  source to see install/login status per CLI. `cli/claude` reads the Claude Code OAuth token from
  `~/.claude/.credentials.json` (refreshing it as needed) and drives the agent's tools against the
  Anthropic Messages API. `cli/codex` works when Codex is logged in with an API key. `cli/gemini`
  uses a **Gemini API key** ([aistudio.google.com/apikey](https://aistudio.google.com/apikey), set
  in Settings or `GEMINI_API_KEY`) when present — the reliable path — otherwise the Gemini CLI's own
  Code Assist login.
- **`cli/jules` is different from every other router.** [Jules](https://jules.google) is an *async*
  agent that works on a **connected GitHub repo in its own VM and opens a pull request** — it does
  **not** edit your local files or use the agent's tools. If the **`jules` CLI is installed**,
  `cli/jules` shells out to it and reuses your own `jules login` (Google OAuth) — no API key. Run
  `coder` inside a repo connected to Jules and a turn runs `jules new` to submit the task; bring the
  result back later with `jules remote pull --session <id> --apply` or `jules teleport <id>`. If the
  CLI isn't installed, it falls back to the **Jules API** (key from jules.google → Settings, or
  `JULES_API_KEY`; pin a repo with `JULES_SOURCE=sources/github-<owner>-<repo>`).
- **Pin a model** on the CLI routers with a suffix: `cli/claude/claude-opus-4-1`,
  `cli/gemini/gemini-2.0-flash`, `cli/codex/gpt-4o`. Without a suffix a sensible default is used.

> ⚠️ **Note on the Auth-CLI routers.** Using a subscription's OAuth token to drive a different
> client against the vendor's private API is undocumented, can break when the vendor changes
> things, and **may violate the product's Terms of Service** (accounts can be rate-limited or
> flagged). It's your own account and your call. Reading the CLI credential file is sensitive, so
> the first run may prompt you to approve it.

## 2. Code with it (CLI)

```bash
cd <your project>
coder            # or, from the app dir: npm start
```

An interactive REPL that runs on the active model, editing the current directory. The prompt shows it, e.g. `qwen3-coder ›`,
and you just type your task in plain English.

**Switching models is live:** click a different model in the UI (e.g. Gemma) and the running
CLI immediately follows it — `▶ active model → gemma-3-27b-it (set from UI)` — no restart, no
typing. The next message uses the new model.

**Tools the agent can use:**

- **Files:** `file_read`, `file_write`, `file_edit`, `multi_edit` (several edits in one call),
  `delete_file`, `move_file`, `copy_file`, `make_dir` — all cross-platform, no shell.
  `delete_file` guards against deleting a drive root or the working directory (dirs need `recursive: true`).
- **Search:** `glob`, `grep` (ripgrep), `list_dir`.
- **Shell:** `shell` (OS-aware; asks before running — `y` once, `a` for the whole session).
- **Media & docs:** `view_image` (screenshots/images), `view_document` (pdf, xlsx/xls, csv, and
  text formats), `generate_image` (creates an image using the **Image agent's** configured model).
- **Web:** `web_fetch` (read a specific URL as text), `web_search` (OpenRouter server-side).

**Screenshots / images:** the agent can look at images via `view_image`. Just point it at a
file — e.g. `look at bug.png and fix the layout` or `implement the UI in mockup.jpg`. This
needs a **vision-capable** model selected in the UI (Claude, Gemini, GPT-4o, Qwen-VL, etc.);
with a text-only model the agent will say it can't see the image. Supported: png, jpg, gif,
webp, bmp.

**Slash commands:** `/init` (explore this project and write `AGENTS.md`), `/active` (show the
coder chain), `/rename <name>` (rename the CLI), `/theme [name]` (list or switch color theme —
`default`, `ocean`, `matrix`, `sunset`, `mono`, `grape`), `/think` (toggle the model's reasoning
— off by default so reasoning models don't flood the terminal), `/new` (clear conversation),
`/help`, `/exit`. `/rename` and `/theme` persist to `agent.config.json`.

**Project context (`/init`):** run `/init` in a project and the agent explores it (structure,
stack, how to run/test) and writes a concise `AGENTS.md` at the project root. On every later
launch the CLI auto-loads `AGENTS.md` into the system prompt, so the agent already knows the
project without re-exploring. `/init` skips if `AGENTS.md` already exists; use `/init force` to
regenerate it.

By default the model's chain-of-thought is collapsed to a single animated `thinking` line that
erases itself when the model acts — so reasoning models don't flood the terminal. Turn the full
reasoning on with `/think`. Quit with `/exit` or `Ctrl+C`.

**Terminal tip:** the classic `cmd.exe` console auto-scrolls to the bottom while output streams
(you can only scroll freely once it's idle at the prompt) and lacks some Unicode glyphs. For a
much better experience — smooth scrollback, search, proper glyphs — run `coder` in **Windows
Terminal** or the VS Code integrated terminal. The CLI uses ASCII-only output so it stays
readable even in the legacy console.

## Projects & memory (Postgres)

Optionally connect a local PostgreSQL database to track the projects you work in, save full
conversation history, and keep an auto-maintained per-project memory.

### 1. Get a PostgreSQL server

You need an actual Postgres **server** running (pgAdmin alone is only a GUI client — it does not
include a server). On Windows the simplest route is winget:

```powershell
winget install -e --id PostgreSQL.PostgreSQL.17 --override "--mode unattended --unattendedmodeui minimal --superpassword YOUR_PASSWORD --serverport 5432 --enable-components server,commandlinetools"
```

This installs Postgres 17 as a Windows service (`postgresql-x64-17`) that auto-starts on boot and
listens on `localhost:5432`. Then create the database:

```powershell
$env:PGPASSWORD = 'YOUR_PASSWORD'
& 'C:\Program Files\PostgreSQL\17\bin\psql.exe' -U postgres -h localhost -c "CREATE DATABASE openrouter_agent"
```

(You can also use a Docker container or a hosted provider like Neon/Supabase — anything that gives
you a connection URL works.)

### 2. Point the app at it

Set the connection URL one of two ways (either works; `DATABASE_URL` takes precedence):

- **`.env` file** (gitignored) in the app directory:
  ```
  DATABASE_URL=postgres://postgres:YOUR_PASSWORD@localhost:5432/openrouter_agent
  ```
- **Web UI Settings** — paste the same URL and click **Test connection**.

Either way, the first successful connection **creates the tables automatically**. Clicking
**Test connection** in the UI is the easiest way to verify.

### 3. Use it

- Every time you run `coder` in a folder, that project is registered, and each conversation is
  saved as a session. In the CLI: `/sessions` lists this project's saved sessions and
  `/resume <id>` reloads one to continue it.
- Browse everything in the web UI: click **📁 Projects** (top of the page) to see projects →
  sessions → full transcripts.

The DB is optional — without it the CLI works exactly as before, just without saved history.
Tables (created automatically): `projects`, `sessions`, `messages`, `project_memory`.

## How it fits together

| File | Role |
| --- | --- |
| `src/config.ts` | Loads `.env` + `agent.config.json` + env overrides into one `AgentConfig` |
| `src/agent.ts` | Wraps `@openrouter/agent` — runs the model, streams events, retries 429/5xx |
| `src/tools/*` | The client-side tools (file, search, shell) |
| `src/cli.ts` | Interactive REPL; watches `agent.config.json` to live-follow the UI's active model |
| `web/server.ts` | Dependency-free server: proxies OpenRouter's model list, writes selection |
| `web/index.html` | The model browser |
| `agent.config.json` | Shared source of truth for the selected model |

## Notes

- **Windows-ready:** the `shell` tool uses `cmd.exe` on Windows and `/bin/sh` elsewhere.
- **`grep`** shells out to [ripgrep (`rg`)](https://github.com/BurntSushi/ripgrep); if it isn't
  installed the tool returns a clear message and the agent falls back to `glob`/`shell`.
- The API key stays server-side — it's never sent to the browser.

## Roadmap: benchmarking

The agent runner (`runAgent`) already returns `{ text, usage, output }`, so a benchmark harness
can drive a fixed set of coding tasks across multiple models and compare tokens/cost/pass-fail.
That's the planned next layer on top of this MVP.
