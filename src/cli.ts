import { createInterface, emitKeypressEvents, type Interface } from 'readline';
import { watch, readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, basename } from 'path';
import { loadConfig, readAgents, updateConfigFile, providerOf, demoteModelInChain, removeModelFromChain, CONFIG_PATH, type AgentConfig } from './config.js';
import { runAgentChain, runResilientChain, isAbortError, needsUserAction, type ChatMessage, type AgentEvent } from './agent.js';
import { runConversationalOrchestrator, ORCHESTRATOR_CHAT_SYSTEM, orchestratorAskContext } from './orchestrator.js';
import { retrieveBrain, formatBrainContext } from './brain.js';
import { setShellApproval } from './tools/shell.js';
import { dbConfigured, upsertProject, createSession, addMessage, setSessionTitle, listSessions, getSessionWithMessages, getProjectMemory, saveProjectMemory, clearProjectMemory } from './db.js';
import { hasGit, isRepo, initRepo, commitAll, recentCommits, AGENT_AUTHOR } from './git.js';
import { resolveMentions, mentionCompletions } from './mentions.js';
import { loadSkillsFor, skillIndex } from './skills.js';
import { loadBoard, cleanBoard } from './board.js';
import { projectMap } from './projectmap.js';

/** Tools that change files on disk — a turn using any of these triggers an auto-commit. */
const MUTATING_TOOLS = new Set([
  'file_write', 'file_edit', 'multi_edit', 'delete_file', 'move_file', 'copy_file', 'make_dir', 'generate_image',
]);

/** System instruction for the memory-summarizer call (tools disabled). */
const MEMORY_SYSTEM = [
  'You update a long-term MEMORY for an AI assistant. You are given the EXISTING MEMORY and a NEW',
  'CONVERSATION. Write the complete, updated memory file.',
  'Keep every fact from the existing memory that is still true, add any new durable facts from the',
  'conversation, and correct anything the user changed.',
  "Durable facts include: the user's name and personal details they share (people, pets, preferences,",
  'how they like to work), and project facts (tech stack, decisions, conventions, key file locations,',
  'open tasks). Ignore greetings and small talk.',
  'Format as short markdown bullets grouped under headings such as "## User" and "## Project".',
  'Respond with ONLY the contents of the memory file — no commentary about the task itself.',
].join(' ');

/**
 * Reject non-answers / reasoning leakage some models return instead of a real memory,
 * so junk never overwrites good memory.
 */
function isJunkMemory(text: string): boolean {
  const trimmed = text.trim();
  const stripped = trimmed.replace(/^[#\-*\s]+/, '');
  if (stripped.length < 12) return true;
  if (/^\(?\s*(no output|none|n\/?a|nothing( to (record|remember))?|empty)\s*\)?\.?$/i.test(trimmed)) return true;
  // Meta-commentary the model sometimes emits about the instruction rather than the memory.
  if (/\(no output\)|leave (it )?blank|output nothing|is not allowed|we output/i.test(trimmed)) return true;
  return false;
}

/** File where /init writes the project summary; auto-loaded as context on startup. */
const CONTEXT_FILE = 'AGENTS.md';

const INIT_PROMPT = [
  'Analyze this project so future sessions have context. First EXPLORE the working directory',
  'with your tools (list_dir, glob, grep, file_read) — do not guess. Then write a file named',
  `${CONTEXT_FILE} at the project root containing:`,
  '- A one-paragraph summary of what the project is and does.',
  '- The tech stack and key dependencies.',
  '- The directory structure (important files/folders and their purpose).',
  '- How to install, build, run, and test it.',
  '- Notable conventions or entry points.',
  `Keep it concise (under ~150 lines) and accurate to what you actually found. If ${CONTEXT_FILE}`,
  'already exists, update it. When done, briefly confirm what you wrote.',
].join('\n');

/** Read the project context file from the current working directory, if present. */
function readProjectContext(): string {
  const p = resolve(process.cwd(), CONTEXT_FILE);
  try {
    if (existsSync(p)) return readFileSync(p, 'utf-8').slice(0, 12000);
  } catch {
    /* ignore */
  }
  return '';
}

// Colors. reset/dim/bold are fixed; the five accent slots are swapped by the theme.
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m', // primary — model name, prompt label
  green: '\x1b[32m', // accent — prompt marker, success
  yellow: '\x1b[33m', // warnings, errors
  gray: '\x1b[90m', // muted — tool output, thinking
  magenta: '\x1b[35m', // tool-call marker
  red: '\x1b[91m', // action-required (fixed; not themed)
};

// Orchestrator accent = Codigo brand pink (#c1447e). Rendered as a filled "pill" badge
// via truecolor bg + white fg with padding. Rounded caps would need powerline glyphs
// from a Nerd Font (terminal font is Consolas), so we use a solid block. Not themed —
// the orchestrator keeps its brand color across themes.
const orchPill = (text: string): string => `\x1b[48;2;193;68;126m\x1b[38;2;255;255;255m${C.bold} ${text} ${C.reset}`;

/** Named color themes: each maps the five accent slots. */
const THEMES: Record<string, Pick<typeof C, 'cyan' | 'green' | 'yellow' | 'gray' | 'magenta'>> = {
  default: { cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', gray: '\x1b[90m', magenta: '\x1b[35m' },
  ocean: { cyan: '\x1b[38;5;39m', green: '\x1b[38;5;44m', yellow: '\x1b[38;5;214m', gray: '\x1b[38;5;244m', magenta: '\x1b[38;5;69m' },
  matrix: { cyan: '\x1b[38;5;46m', green: '\x1b[38;5;40m', yellow: '\x1b[38;5;190m', gray: '\x1b[38;5;28m', magenta: '\x1b[38;5;35m' },
  sunset: { cyan: '\x1b[38;5;208m', green: '\x1b[38;5;203m', yellow: '\x1b[38;5;220m', gray: '\x1b[38;5;244m', magenta: '\x1b[38;5;205m' },
  mono: { cyan: '\x1b[38;5;253m', green: '\x1b[38;5;250m', yellow: '\x1b[38;5;245m', gray: '\x1b[38;5;240m', magenta: '\x1b[38;5;248m' },
  grape: { cyan: '\x1b[38;5;177m', green: '\x1b[38;5;120m', yellow: '\x1b[38;5;222m', gray: '\x1b[38;5;96m', magenta: '\x1b[38;5;170m' },
};

/** Apply a theme by mutating C in place. Returns the theme name actually applied. */
function applyTheme(name: string): string {
  const t = THEMES[name] ?? THEMES.default;
  Object.assign(C, t);
  return THEMES[name] ? name : 'default';
}

/** The coder failover chain from the shared config (written by the web UI). */
function readCoderChain(): string[] {
  return readAgents().coder;
}

/** Short label for the prompt, e.g. "qwen/qwen3-coder" → "qwen3-coder". */
function shortName(model: string): string {
  if (!model) return '(no model)';
  const m = model.replace(/\/+$/, ''); // tolerate trailing slashes (e.g. local URL ids)
  const local = m.match(/^local\/https?:\/\/(.+)$/i);
  if (local) return `local (${local[1]})`; // local/http://127.0.0.1:8080 → "local (127.0.0.1:8080)"
  const slash = m.lastIndexOf('/');
  return (slash === -1 ? m : m.slice(slash + 1)).replace(/:free$/, ' (free)') || m;
}

function banner(config: AgentConfig, chain: string[], activeIndex = 0) {
  const width = Math.min(process.stdout.columns || 60, 60);
  const line = C.gray + '-'.repeat(width) + C.reset;
  console.log();
  console.log(line);
  console.log(`  ${C.bold}${config.name}${C.reset}`);
  if (chain.length) {
    chain.forEach((m, i) => {
      const active = i === activeIndex;
      const mark = active ? `${C.green}▶${C.reset}` : ' ';
      console.log(`  ${mark} ${C.dim}coder ${i + 1}${C.reset}  ${active ? C.cyan : C.gray}${m}${C.reset}`);
    });
  } else {
    console.log(`  ${C.yellow}no coder model configured - add one in the web UI (start.bat)${C.reset}`);
  }
  // Show the orchestrator (if configured) so you know which one plans/delegates.
  const orch = readAgents().orchestrator;
  if (orch.length) {
    const rest = orch.length > 1 ? ` ${C.dim}+${orch.length - 1} failover${C.reset}` : '';
    console.log(`  ${C.magenta}▣ orchestrator${C.reset}  ${C.magenta}${shortName(orch[0])}${C.reset}${rest}`);
  }
  console.log(line);
  console.log(`  ${C.dim}Models are set from the web UI. /coder-<n> to switch, /help, /exit.${C.reset}`);
  console.log();
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * Set the terminal window/tab title via the OSC escape sequence, so /rename
 * actually renames the window (cmd.exe, Windows Terminal, iTerm, etc.). No-op
 * when stdout isn't a TTY (piped/redirected) to avoid leaking escape codes.
 */
function setWindowTitle(name: string): void {
  if (!name || !process.stdout.isTTY) return;
  process.stdout.write(`\x1b]0;${name}\x07`);
}

function question(rl: Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

/**
 * Renders streamed agent events. By default the model's chain-of-thought
 * (reasoning) is collapsed to a single animated "thinking" line that erases
 * itself the moment the model produces real output — so reasoning models don't
 * flood the terminal. Toggle full reasoning with `showReasoning`. Uses ASCII
 * glyphs so it renders cleanly in the classic Windows console.
 */
/** Whimsical "still working" words that rotate under the spinner on long turns. */
const THINKING_WORDS = [
  'thinking', 'goblinating', 'reticulating splines', 'summoning daemons',
  'herding electrons', 'buttering the bits', 'consulting the oracle',
  'untangling the yarn', 'brewing tokens', 'bamboozling the CPU',
  'spelunking the codebase', 'negotiating with the model', 'polishing pixels',
  'wrangling gremlins', 'percolating', 'noodling', 'conjuring', 'vibing',
  'poking the hamster wheel', 'aligning the flux', 'greasing the gears',
  'counting to potato', 'rerouting the tubes', 'feeding the goblins',
  'pondering', 'crunching', 'brewing', 'marinating the logic', 'whisking bytes',
];
const pickWord = () => THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];

function makeRenderer(showReasoning: () => boolean) {
  let atLineStart = true;
  const frames = ['-', '\\', '|', '/'];
  let frame = 0;
  let spinner: ReturnType<typeof setInterval> | null = null;

  function stopSpinner() {
    if (spinner) {
      clearInterval(spinner);
      spinner = null;
      process.stdout.write('\r\x1b[K'); // erase the thinking line
      atLineStart = true;
    }
  }
  function startSpinner() {
    if (spinner) return;
    if (!atLineStart) {
      process.stdout.write('\n');
      atLineStart = true;
    }
    const started = Date.now();
    let word = pickWord();
    let tick = 0;
    const paint = () => {
      const secs = Math.floor((Date.now() - started) / 1000);
      const elapsed = secs >= 2 ? ` ${C.dim}(${secs}s)${C.reset}` : '';
      // \x1b[K clears to end of line so a shorter word doesn't leave stale characters.
      process.stdout.write(`\r\x1b[K${C.gray}${frames[frame]} ${word}…${C.reset}${elapsed}`);
    };
    paint();
    spinner = setInterval(() => {
      frame = (frame + 1) % frames.length;
      // Swap to a new word roughly every ~3.6s (30 frames × 120ms) so it stays lively.
      if (++tick % 30 === 0) word = pickWord();
      paint();
    }, 120);
  }

  return {
    reset() {
      stopSpinner();
      atLineStart = true;
    },
    done() {
      stopSpinner();
    },
    // Start the whimsical spinner while waiting for the model (any real output clears it).
    think() {
      startSpinner();
    },
    // Clear the spinner before printing a status line, without ending the turn.
    clearThinking() {
      stopSpinner();
    },
    handle(e: AgentEvent) {
      if (e.type === 'reasoning') {
        if (showReasoning()) {
          stopSpinner();
          process.stdout.write(`${C.gray}${e.delta}${C.reset}`);
          atLineStart = e.delta.endsWith('\n');
        } else {
          startSpinner();
        }
        return;
      }
      stopSpinner(); // clear the thinking line before printing anything real
      if (e.type === 'text') {
        process.stdout.write(e.delta);
        atLineStart = e.delta.endsWith('\n');
      } else if (e.type === 'tool_call') {
        if (!atLineStart) process.stdout.write('\n');
        const args = Object.entries(e.args)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(' ');
        process.stdout.write(`${C.magenta}> ${e.name}${C.reset} ${C.dim}${args}${C.reset}\n`);
        atLineStart = true;
      } else if (e.type === 'tool_result') {
        process.stdout.write(`${C.gray}  -> ${e.output.replace(/\n/g, '\n     ')}${C.reset}\n`);
        atLineStart = true;
      }
    },
  };
}

async function main() {
  const config = loadConfig({}, { skipApiKey: true }); // key checked per-turn so UI edits apply live
  let chain = readCoderChain();
  // Which model in the chain to start from this session (0 = primary). /coder-<n>
  // switches it; the turn runs chain.slice(activeIndex) so the rest stay as failover.
  let activeIndex = 0;
  const clampActive = () => {
    if (activeIndex >= chain.length) activeIndex = 0;
  };
  // While a turn is running we still track UI chain changes, but silently — no prompt
  // redraw or "set from UI" spam interleaved with the model's response.
  let turnActive = false;
  // Set for the duration of a turn; Esc aborts it (stop the current task, not the app).
  let activeAbort: AbortController | null = null;
  applyTheme(config.theme || 'default');
  setWindowTitle(config.name); // name the terminal window on launch

  const workDir = process.cwd();
  let autoCommit = config.autoCommit !== false; // default on
  let gitEnabled = false; // true once we've confirmed git + a repo in workDir

  // Distilled, cross-session project memory (loaded from the DB) + recent git subjects.
  let projectMemory = '';
  let recentChanges: string[] = [];

  // Build the system prompt from: base + project memory (+ recent changes) + AGENTS.md.
  // Returns whether AGENTS.md context was found (for the startup tip line).
  const baseSystemPrompt = config.systemPrompt;
  function rebuildSystemPrompt(): boolean {
    const ctx = readProjectContext();
    let sp = baseSystemPrompt;
    const mem: string[] = [];
    if (projectMemory) mem.push(projectMemory);
    if (recentChanges.length) mem.push('Recent changes (git commits):\n' + recentChanges.map((s) => `- ${s}`).join('\n'));
    if (mem.length) {
      sp +=
        `\n\n# Project memory (auto-maintained across sessions)\n` +
        `These are facts you already know about this user and project. Use them to answer directly — ` +
        `do NOT search files or say you lack the information when the answer is here.\n\n${mem.join('\n\n')}`;
    }
    if (ctx) sp += `\n\n# Project context (from ${CONTEXT_FILE})\n${ctx}`;
    // File map: enumerate the project's files up front so the coder knows what exists and
    // doesn't burn turns re-listing/globbing to discover them (a common frustration).
    const map = projectMap(workDir);
    if (map) sp += `\n\n${map}`;
    // Brain: durable project knowledge the agent maintains + reads (relevant notes are
    // injected per turn/step when present). Nudge the agent to keep it up to date.
    sp +=
      `\n\n# Project brain\n` +
      `This project has a long-term knowledge base at .codigo/brain/ (markdown notes). Relevant notes ` +
      `are given to you automatically when they exist. When you make a lasting decision, learn a durable ` +
      `fact, or hit a gotcha worth remembering, record it with the save_note tool so future sessions and ` +
      `other coders benefit. Don't note transient/step-by-step progress — only durable knowledge.`;
    // Advertise available skills (name + description). The full instructions are inlined
    // only when the user invokes one with @<name>, keeping the prompt small.
    const skills = loadSkillsFor(workDir);
    if (skills.length) {
      sp +=
        `\n\n# Skills available\n` +
        `Reusable instruction sets for specific tasks. When a task matches one, tell the user to load it ` +
        `with ${'`@<name>`'} (e.g. @${skills[0].name}); its full instructions are then inserted and you must follow them.\n\n` +
        skillIndex(skills);
    }
    config.systemPrompt = sp;
    return !!ctx;
  }
  async function refreshRecentChanges() {
    if (gitEnabled) recentChanges = await recentCommits(workDir, 5);
  }
  const hasContext = rebuildSystemPrompt();

  // Tab completes @mentions (skills + files under the working dir). The completer is async
  // (globs the tree), so use readline's callback form; non-mention lines complete to nothing.
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: (line: string, cb: (err: null, result: [string[], string]) => void) => {
      mentionCompletions(line, workDir, loadSkillsFor(workDir))
        .then((result) => cb(null, result))
        .catch(() => cb(null, [[], line]));
    },
  });

  // Ctrl+C quits cleanly (in addition to /exit).
  rl.on('SIGINT', () => {
    console.log(`\n${C.dim}Goodbye.${C.reset}\n`);
    process.exit(0);
  });

  // Esc stops the current task (but not the app). Only acts while a turn is running, so it
  // never interferes with line editing at the prompt. Ctrl+C remains the way to quit.
  if (process.stdin.isTTY) {
    emitKeypressEvents(process.stdin, rl);
    process.stdin.on('keypress', (_str, key) => {
      if (key?.name === 'escape' && activeAbort && !activeAbort.signal.aborted) {
        activeAbort.abort();
        process.stdout.write(`\n${C.yellow}  stopping…${C.reset}\n`);
      }
    });
  }

  // Wire the shell approval gate to an interactive y/n prompt.
  setShellApproval(async (command) => {
    const ans = await question(
      rl,
      `\n${C.red}⚠ Approve shell command?${C.reset} ${C.bold}${command}${C.reset}\n${C.red}[y = yes, a = always this session, anything else = no]${C.reset} `,
    );
    const a = ans.trim().toLowerCase();
    if (a === 'a') {
      setShellApproval(async () => true);
      return true;
    }
    return a === 'y' || a === 'yes';
  });

  /** Wipe the screen + scrollback like `cls`, so /clear returns to a blank slate. */
  function clearScreen() {
    if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  }

  /** Print the banner + the context/tip line, exactly as on initial load. */
  function printIntro(withContext: boolean) {
    banner(config, chain, activeIndex);
    if (withContext) {
      console.log(`  ${C.dim}Loaded project context from ${CONTEXT_FILE}.${C.reset}\n`);
    } else {
      console.log(`  ${C.dim}Tip: run ${C.reset}${C.cyan}/init${C.reset}${C.dim} to summarize this project into ${CONTEXT_FILE}.${C.reset}\n`);
    }
  }

  printIntro(hasContext);

  const promptText = () => {
    // When an orchestrator is configured, normal input goes to the conversational
    // orchestrator (it delegates to the coder chain), so label the prompt as a pink
    // pill badge. Otherwise show the active coder (cyan), who you talk to directly.
    const orch = readAgents().orchestrator;
    if (orch.length) {
      return `${orchPill(`orchestrator (${shortName(orch[0])})`)} ${C.green}>${C.reset} `;
    }
    const label = shortName(chain[activeIndex] ?? chain[0] ?? '');
    const pos = chain.length > 1 && activeIndex > 0 ? `${C.dim}[coder ${activeIndex + 1}]${C.reset} ` : '';
    return `${pos}${C.cyan}${label}${C.reset} ${C.green}>${C.reset} `;
  };

  // Follow the coder chain chosen in the web UI. The UI writes agent.config.json;
  // we watch it and update the chain live — no need to type model names here.
  // fs.watch fires a BURST of events per save on Windows, and a read can catch the
  // file mid-write (partial/empty JSON). So we debounce and ignore empty reads,
  // announcing only a genuine, settled change of the active model.
  let watchTimer: ReturnType<typeof setTimeout> | null = null;
  let orchLabel = readAgents().orchestrator[0] ?? '';
  const watcher = watch(CONFIG_PATH, () => {
    if (watchTimer) return;
    watchTimer = setTimeout(() => {
      watchTimer = null;
      const next = readCoderChain();
      const nextOrch = readAgents().orchestrator[0] ?? '';
      const coderChanged = next.length > 0 && next.join('|') !== chain.join('|');
      const orchChanged = nextOrch !== orchLabel;
      // A mid-write can momentarily clear the coder chain; keep the current one and only
      // react to a genuine, settled change of either the coder chain or the orchestrator.
      if (!coderChanged && !orchChanged) return;
      const prevActive = chain[activeIndex];
      if (coderChanged) {
        chain = next;
        clampActive();
      }
      orchLabel = nextOrch;
      if (turnActive) return; // update silently mid-turn; the next prompt reflects it
      const nowActive = chain[activeIndex];
      if (coderChanged && nowActive && nowActive !== prevActive) {
        process.stdout.write(
          `\n${C.magenta}>> coder model -> ${shortName(nowActive)}${C.reset} ${C.dim}(set from UI)${C.reset}\n`,
        );
      }
      if (orchChanged) {
        const msg = nextOrch ? `orchestrator -> ${shortName(nextOrch)}` : 'orchestrator removed — talking to the coder chain';
        process.stdout.write(`\n${C.magenta}>> ${msg}${C.reset} ${C.dim}(set from UI)${C.reset}\n`);
      }
      rl.setPrompt(promptText());
      rl.prompt(true);
    }, 250);
    watchTimer.unref?.();
  });
  watcher.unref?.(); // don't let the file watcher keep the process alive on exit

  const messages: ChatMessage[] = [];
  const total = { input: 0, output: 0 };
  let showReasoning = false;
  const renderer = makeRenderer(() => showReasoning);

  // Register this project in the DB (if configured) so sessions/history are saved.
  let projectId: number | null = null;
  let sessionId: number | null = null;
  if (dbConfigured()) {
    try {
      const cwd = process.cwd();
      const p = await upsertProject(cwd, basename(cwd) || cwd);
      projectId = p.id;
      const past = await listSessions(projectId);
      if (past.length) {
        console.log(
          `  ${C.dim}Project has ${past.length} saved session(s). ${C.reset}${C.cyan}/sessions${C.reset}${C.dim} to list, ${C.reset}${C.cyan}/resume <id>${C.reset}${C.dim} to continue.${C.reset}\n`,
        );
      }
    } catch (err: any) {
      console.log(`  ${C.yellow}DB unavailable: ${err.message} — history won't be saved.${C.reset}\n`);
    }
  }

  // Auto-git: make the working project a repo (if it isn't) so file changes are recorded.
  if (autoCommit) {
    if (await hasGit()) {
      if (!(await isRepo(workDir))) {
        if (await initRepo(workDir)) {
          console.log(
            `  ${C.dim}Initialized a git repo here to auto-record file changes. ${C.reset}${C.cyan}/autocommit off${C.reset}${C.dim} to disable.${C.reset}\n`,
          );
        }
      }
      gitEnabled = await isRepo(workDir);
      await refreshRecentChanges();
    } else {
      autoCommit = false;
      console.log(`  ${C.yellow}git not found on PATH — auto-commit disabled.${C.reset}\n`);
    }
  }

  // Load the distilled project memory and fold it (plus recent changes) into the prompt.
  if (projectId != null) {
    try {
      projectMemory = await getProjectMemory(projectId);
    } catch {
      /* memory optional */
    }
  }
  rebuildSystemPrompt();
  if (projectMemory) {
    console.log(`  ${C.dim}Loaded project memory. ${C.reset}${C.cyan}/memory${C.reset}${C.dim} to view.${C.reset}\n`);
  }

  // Set true after each assistant turn; drives whether flushMemory() does anything.
  let memoryDirty = false;

  /**
   * Summarize the current conversation into the persistent project memory.
   * Best-effort and non-fatal: needs a DB + a coder model + something new to learn.
   */
  async function flushMemory(_reason: 'clear' | 'exit' | 'manual') {
    if (projectId == null || !chain.length) return;
    if (!memoryDirty && _reason !== 'manual') return;
    const convo = messages.filter((m) => m.role !== 'system');
    if (convo.length < 2) return;
    const transcript = convo.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
    const bounded = transcript.length > 8000 ? transcript.slice(-8000) : transcript;
    const userInput = `# Existing memory\n${projectMemory || '(none yet)'}\n\n# New conversation to fold in\n${bounded}`;
    process.stdout.write(`  ${C.dim}Updating project memory…${C.reset}`);
    try {
      const res = await runAgentChain(config, chain, userInput, { noTools: true, instructions: MEMORY_SYSTEM });
      const next = res.text.trim();
      // Don't overwrite good memory with a non-answer (some models return "(No output)").
      if (next && !isJunkMemory(next)) {
        projectMemory = next;
        await saveProjectMemory(projectId, next);
        rebuildSystemPrompt();
        memoryDirty = false;
        process.stdout.write(`\r${C.dim}Project memory updated.${C.reset}\x1b[K\n`);
        return;
      }
      process.stdout.write(`\r${C.dim}(no new memory saved)${C.reset}\x1b[K\n`);
    } catch {
      process.stdout.write(`\r${C.dim}(memory update skipped)${C.reset}\x1b[K\n`);
    }
  }

  async function ensureSession() {
    if (projectId == null || sessionId != null) return;
    try {
      sessionId = await createSession(projectId, chain[0] ?? '');
    } catch {
      /* history disabled for this run */
    }
  }
  async function log(role: 'user' | 'assistant', content: string) {
    if (sessionId == null) return;
    try {
      await addMessage(sessionId, role, content);
    } catch {
      /* ignore logging failures */
    }
  }

  while (true) {
    chain = readCoderChain(); // always use whatever the UI has set
    clampActive(); // keep the /coder-<n> selection valid if the UI changed the chain
    let input: string;
    try {
      input = (await question(rl, promptText())).trim();
    } catch {
      break; // stdin closed (EOF / piped input ended) — exit cleanly instead of crashing
    }
    if (!input) continue;

    if (input === '/exit' || input.toLowerCase() === 'exit') {
      await flushMemory('exit'); // save project memory on a clean exit
      console.log(`\n${C.dim}Goodbye.${C.reset}\n`);
      break;
    }
    if (input === '/help') {
      console.log(
        `\n  ${C.bold}Commands${C.reset}\n` +
          `  ${C.cyan}/init${C.reset}          write ${CONTEXT_FILE} (skips if it exists; ${C.reset}${C.cyan}/init force${C.reset} regenerates)\n` +
          `  ${C.cyan}/active${C.reset}        show the coder model + failover chain (from the web UI)\n` +
          `  ${C.cyan}/coder-<n>${C.reset}     switch which model in the chain runs (e.g. ${C.reset}${C.cyan}/coder-2${C.reset}; failover continues from there)\n` +
          `  ${C.cyan}/sessions${C.reset}      list saved sessions for this project (needs DB)\n` +
          `  ${C.cyan}/resume <id>${C.reset}   reload a past session and continue it\n` +
          `  ${C.cyan}/rename <name>${C.reset} rename this CLI + terminal window (persists)\n` +
          `  ${C.cyan}/theme [name]${C.reset}  list or switch color theme (persists)\n` +
          `  ${C.cyan}/think${C.reset}         toggle showing the model's reasoning (currently ${showReasoning ? 'on' : 'off'})\n` +
          `  ${C.cyan}/memory${C.reset}        show project memory (${C.reset}${C.cyan}/memory save${C.reset}${C.dim} to update now, ${C.reset}${C.cyan}/memory clear${C.reset}${C.dim} to wipe)${C.reset}\n` +
          `  ${C.cyan}/autocommit${C.reset}    auto-commit file changes to git (currently ${autoCommit ? 'on' : 'off'}; ${C.reset}${C.cyan}/autocommit on|off${C.reset})\n` +
          `  ${C.cyan}/clear${C.reset}         clear the conversation context (alias: ${C.reset}${C.cyan}/new${C.reset})\n` +
          `  ${C.cyan}@<name>${C.reset}        load a skill, or attach files by fuzzy name (e.g. ${C.reset}${C.cyan}@prd${C.reset}${C.dim}) — inlined for the model${C.reset}\n` +
          `  ${C.cyan}@orchestrator${C.reset}  ${C.dim}<msg>${C.reset}  ask the orchestrator directly (status, priorities) — no plan/execute\n` +
          `  ${C.cyan}/board${C.reset}         show the Kanban board (${C.reset}${C.cyan}/board clean${C.reset}${C.dim} removes junk, ${C.reset}${C.cyan}/board clear${C.reset}${C.dim} wipes it)${C.reset}\n` +
          `  ${C.cyan}/skills${C.reset}        list available skills (from ${C.reset}${C.cyan}.skills/${C.reset}${C.dim})${C.reset}\n` +
          `  ${C.cyan}/dir${C.reset} ${C.dim}[path]${C.reset}    list files in the working dir (alias: ${C.reset}${C.cyan}/ls${C.reset}${C.dim})${C.reset}\n` +
          `  ${C.cyan}Esc${C.reset}            stop the current task (Ctrl+C quits the app)\n` +
          `  ${C.cyan}/help${C.reset}          show this help\n` +
          `  ${C.cyan}/exit${C.reset}          quit\n` +
          `\n  ${C.dim}To change models: open the web UI (start.bat), Coder tab.${C.reset}\n`,
      );
      continue;
    }
    if (input === '/think') {
      showReasoning = !showReasoning;
      console.log(`${C.dim}Reasoning display ${showReasoning ? 'on' : 'off'}.${C.reset}\n`);
      continue;
    }
    if (input === '/memory' || input.startsWith('/memory ')) {
      const arg = input.slice('/memory'.length).trim().toLowerCase();
      if (projectId == null) {
        console.log(`  ${C.yellow}Project memory needs a database. Add a Postgres URL in the web UI Settings.${C.reset}\n`);
      } else if (arg === 'clear') {
        await clearProjectMemory(projectId).catch(() => {});
        projectMemory = '';
        rebuildSystemPrompt();
        console.log(`  ${C.green}Project memory cleared.${C.reset}\n`);
      } else if (arg === 'save') {
        await flushMemory('manual');
        if (!projectMemory) console.log(`  ${C.dim}Nothing to summarize yet.${C.reset}\n`);
        else console.log();
      } else {
        console.log(
          projectMemory
            ? `\n${C.dim}# Project memory${C.reset}\n${projectMemory}\n`
            : `  ${C.dim}No project memory yet — it builds up as you work (saved on /clear and /exit).${C.reset}\n`,
        );
      }
      continue;
    }
    if (input === '/autocommit' || input.startsWith('/autocommit ')) {
      const arg = input.slice('/autocommit'.length).trim().toLowerCase();
      if (arg === 'on' || arg === 'off') {
        autoCommit = arg === 'on';
        updateConfigFile({ autoCommit });
        if (autoCommit && !gitEnabled) {
          if (await hasGit()) {
            if (!(await isRepo(workDir))) await initRepo(workDir);
            gitEnabled = await isRepo(workDir);
            await refreshRecentChanges();
          } else {
            autoCommit = false;
            console.log(`  ${C.yellow}git not found on PATH — cannot enable auto-commit.${C.reset}\n`);
            continue;
          }
        }
        console.log(`  ${C.green}Auto-commit ${autoCommit ? 'on' : 'off'}.${C.reset}\n`);
      } else {
        console.log(`  ${C.dim}Auto-commit is ${autoCommit ? 'on' : 'off'}. Usage: ${C.reset}${C.cyan}/autocommit on|off${C.reset}\n`);
      }
      continue;
    }
    if (input.startsWith('/rename')) {
      const name = input.slice('/rename'.length).trim();
      if (!name) {
        console.log(`  ${C.dim}current name:${C.reset} ${C.bold}${config.name}${C.reset}  ${C.dim}(usage: /rename <new name>)${C.reset}\n`);
      } else {
        config.name = name;
        updateConfigFile({ name });
        setWindowTitle(name); // update the terminal window title live
        console.log(`  ${C.green}renamed to${C.reset} ${C.bold}${name}${C.reset}\n`);
      }
      continue;
    }
    if (input === '/theme' || input.startsWith('/theme ')) {
      const arg = input.slice('/theme'.length).trim();
      if (!arg) {
        const list = Object.keys(THEMES)
          .map((n) => (n === config.theme ? `${C.green}${n}*${C.reset}` : `${C.cyan}${n}${C.reset}`))
          .join('  ');
        console.log(`  ${C.dim}themes:${C.reset} ${list}   ${C.dim}(usage: /theme <name>)${C.reset}\n`);
      } else if (THEMES[arg]) {
        applyTheme(arg);
        config.theme = arg;
        updateConfigFile({ theme: arg });
        banner(config, chain, activeIndex); // reprint in the new colors
        console.log(`  ${C.green}theme set to ${arg}.${C.reset}\n`);
      } else {
        console.log(`  ${C.yellow}unknown theme "${arg}".${C.reset} ${C.dim}options: ${Object.keys(THEMES).join(', ')}${C.reset}\n`);
      }
      continue;
    }
    if (input === '/new' || input === '/clear') {
      await flushMemory('clear'); // fold this conversation into project memory before wiping
      messages.length = 0;
      sessionId = null; // next message starts a fresh saved session
      total.input = 0;
      total.output = 0;
      clearScreen(); // wipe the terminal (like cls) and return to the initial view
      printIntro(rebuildSystemPrompt());
      continue;
    }
    if (input === '/sessions') {
      if (projectId == null) {
        console.log(`  ${C.yellow}No database configured. Add a Postgres URL in the web UI Settings.${C.reset}\n`);
      } else {
        try {
          const rows = await listSessions(projectId);
          if (!rows.length) console.log(`  ${C.dim}No saved sessions yet for this project.${C.reset}\n`);
          else {
            rows.slice(0, 20).forEach((s) => {
              const when = new Date(s.updated_at).toLocaleString();
              const mark = s.id === sessionId ? `${C.green} (current)${C.reset}` : '';
              console.log(`  ${C.cyan}#${s.id}${C.reset} ${s.title ?? '(untitled)'} ${C.dim}- ${s.messages} msgs, ${when}${C.reset}${mark}`);
            });
            console.log(`  ${C.dim}/resume <id> to continue one.${C.reset}\n`);
          }
        } catch (err: any) {
          console.log(`  ${C.yellow}${err.message}${C.reset}\n`);
        }
      }
      continue;
    }
    if (input.startsWith('/resume')) {
      const id = Number(input.slice('/resume'.length).trim());
      if (!id) {
        console.log(`  ${C.dim}usage: /resume <id> (see /sessions)${C.reset}\n`);
      } else {
        try {
          await flushMemory('clear'); // save the current conversation before switching
          const { session, messages: rows } = await getSessionWithMessages(id);
          if (!session) console.log(`  ${C.yellow}Session #${id} not found.${C.reset}\n`);
          else {
            messages.length = 0;
            rows.forEach((m) => messages.push({ role: m.role as ChatMessage['role'], content: m.content }));
            sessionId = id;
            memoryDirty = false; // loaded history isn't "new" to summarize
            console.log(`  ${C.green}Resumed session #${id}${C.reset} ${C.dim}(${rows.length} messages loaded).${C.reset}\n`);
          }
        } catch (err: any) {
          console.log(`  ${C.yellow}${err.message}${C.reset}\n`);
        }
      }
      continue;
    }
    if (input === '/dir' || input === '/ls' || input.startsWith('/dir ') || input.startsWith('/ls ')) {
      const arg = input.replace(/^\/(dir|ls)\s*/, '').trim();
      const target = arg ? resolve(workDir, arg) : workDir;
      try {
        const entries = readdirSync(target, { withFileTypes: true });
        const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
        const files = entries.filter((e) => !e.isDirectory()).map((e) => e.name).sort();
        console.log(`\n  ${C.dim}${target}${C.reset}`);
        for (const d of dirs) console.log(`  ${C.cyan}${d}/${C.reset}`);
        for (const f of files) console.log(`  ${f}`);
        console.log(
          `  ${C.dim}${dirs.length} dir${dirs.length === 1 ? '' : 's'}, ${files.length} file${files.length === 1 ? '' : 's'}${C.reset}\n`,
        );
      } catch (e: any) {
        console.log(`  ${C.yellow}${e.message}${C.reset}\n`);
      }
      continue;
    }
    if (input === '/skills') {
      const skills = loadSkillsFor(workDir);
      if (!skills.length) {
        console.log(
          `  ${C.dim}No skills yet. Add one at ${C.reset}${C.cyan}.skills/<name>/SKILL.md${C.reset}${C.dim} ` +
            `(a SkillOpt best_skill.md works too). Load one in a message with ${C.reset}${C.cyan}@<name>${C.reset}${C.dim}.${C.reset}\n`,
        );
      } else {
        console.log(`\n  ${C.bold}Skills${C.reset} ${C.dim}(load in a message with @<name>)${C.reset}`);
        skills.forEach((s) => {
          const tag = s.source === 'project' ? `${C.green}[project]${C.reset}` : `${C.gray}[global]${C.reset}`;
          console.log(`  ${C.cyan}@${s.name}${C.reset} ${tag}  ${C.dim}${s.description || '(no description)'}${C.reset}`);
        });
        console.log();
      }
      continue;
    }
    if (input === '/active') {
      if (!chain.length) {
        console.log(`  ${C.yellow}no coder model configured - add one in the web UI${C.reset}\n`);
      } else {
        chain.forEach((m, i) => {
          const active = i === activeIndex;
          console.log(`  ${active ? `${C.green}▶${C.reset}` : ' '} ${C.dim}coder ${i + 1}${C.reset}  ${active ? C.cyan : C.gray}${m}${C.reset}`);
        });
        console.log(`  ${C.dim}${C.reset}${C.cyan}/coder-<n>${C.reset}${C.dim} to switch which one runs.${C.reset}\n`);
      }
      continue;
    }
    // /coder, /coder-<n>, /coder <n>: switch which model in the chain runs (session only).
    const coderMatch = input.match(/^\/coder(?:[-\s]?(\d+))?$/i);
    if (coderMatch) {
      clampActive();
      if (!chain.length) {
        console.log(`  ${C.yellow}no coder model configured - add one in the web UI${C.reset}\n`);
      } else if (!coderMatch[1]) {
        chain.forEach((m, i) => {
          const active = i === activeIndex;
          console.log(`  ${active ? `${C.green}▶${C.reset}` : ' '} ${C.dim}coder ${i + 1}${C.reset}  ${active ? C.cyan : C.gray}${shortName(m)}${C.reset}`);
        });
        console.log(`  ${C.dim}usage: ${C.reset}${C.cyan}/coder-<n>${C.reset}${C.dim} (e.g. /coder-2)${C.reset}\n`);
      } else {
        const n = Number(coderMatch[1]);
        if (n < 1 || n > chain.length) {
          console.log(`  ${C.yellow}no coder ${n} — the chain has ${chain.length} model${chain.length === 1 ? '' : 's'}.${C.reset}\n`);
        } else {
          activeIndex = n - 1;
          rl.setPrompt(promptText());
          const rest = chain.length - activeIndex - 1;
          console.log(
            `  ${C.green}switched to coder ${n}${C.reset} ${C.cyan}${shortName(chain[activeIndex])}${C.reset}` +
              `${rest > 0 ? ` ${C.dim}(${rest} failover${rest === 1 ? '' : 's'} after it)${C.reset}` : ''}\n`,
          );
        }
      }
      continue;
    }

    // /board [clean|clear]: inspect or clean the Kanban board (self-heal a junk-filled board).
    if (input === '/board' || input.startsWith('/board ')) {
      const arg = input.slice('/board'.length).trim().toLowerCase();
      if (arg === 'clear' || arg === 'wipe') {
        const removed = cleanBoard(workDir, 'all');
        console.log(`  ${C.green}cleared the board — removed ${removed.length} card${removed.length === 1 ? '' : 's'}.${C.reset} ${C.dim}(recoverable via git)${C.reset}\n`);
      } else if (arg === 'clean') {
        const removed = cleanBoard(workDir, 'clean');
        if (!removed.length) console.log(`  ${C.green}board is clean — no junk cards found.${C.reset}\n`);
        else {
          console.log(`  ${C.green}removed ${removed.length} junk card${removed.length === 1 ? '' : 's'}:${C.reset}`);
          removed.slice(0, 25).forEach((t) => console.log(`  ${C.dim}- ${t.slice(0, 72)}${C.reset}`));
          if (removed.length > 25) console.log(`  ${C.dim}…and ${removed.length - 25} more${C.reset}`);
          console.log();
        }
      } else {
        const b = loadBoard(workDir);
        const by = { todo: 0, pending: 0, done: 0 } as Record<string, number>;
        for (const t of b.tasks) by[t.status] = (by[t.status] || 0) + 1;
        console.log(`\n  ${C.bold}Kanban board${C.reset} ${C.dim}(${b.tasks.length} cards — ${by.todo} todo, ${by.pending} in-progress, ${by.done} done)${C.reset}`);
        b.tasks.slice(0, 40).forEach((t) => {
          const mark = t.status === 'done' ? `${C.green}[x]` : t.status === 'pending' ? `${C.cyan}[~]` : `${C.dim}[ ]`;
          console.log(`  ${mark}${C.reset} ${t.title.slice(0, 72)}`);
        });
        if (b.tasks.length > 40) console.log(`  ${C.dim}…and ${b.tasks.length - 40} more${C.reset}`);
        console.log(`  ${C.dim}usage: ${C.reset}${C.cyan}/board clean${C.reset}${C.dim} (remove junk) · ${C.reset}${C.cyan}/board clear${C.reset}${C.dim} (wipe all)${C.reset}\n`);
      }
      continue;
    }

    // @orchestrator <message>: talk to the orchestrator/scrum master directly — it answers
    // conversationally about the plan/board/project WITHOUT planning or delegating to coders.
    const orchAsk = input.match(/^@orchestrator\b\s*([\s\S]*)$/i);
    if (orchAsk) {
      const question = orchAsk[1].trim() || 'What is the current status of the board and what should we do next?';
      const orchestratorChain = readAgents().orchestrator;
      if (!orchestratorChain.length) {
        console.log(`  ${C.yellow}No orchestrator configured — add one in the web UI (Orchestrator agent).${C.reset}\n`);
        continue;
      }
      // Give it the board + relevant brain so it can actually reason about the kanban.
      const context = await orchestratorAskContext(workDir, question);
      console.log(`\n  ${C.magenta}▣ orchestrator${C.reset} ${C.dim}(${shortName(orchestratorChain[0])})${C.reset}`);
      console.log(`  ${C.dim}(Esc to stop)${C.reset}\n`);
      renderer.reset();
      renderer.think();
      turnActive = true;
      activeAbort = new AbortController();
      try {
        const res = await runAgentChain(config, orchestratorChain, context, {
          noTools: true,
          instructions: ORCHESTRATOR_CHAT_SYSTEM,
          signal: activeAbort.signal,
          onEvent: (e: AgentEvent) => renderer.handle(e),
        });
        renderer.done();
        messages.push({ role: 'user', content: input });
        messages.push({ role: 'assistant', content: res.text });
        await ensureSession();
        await log('user', input);
        await log('assistant', res.text);
      } catch (err: any) {
        renderer.done();
        if (isAbortError(err, activeAbort?.signal)) console.log(`\n  ${C.dim}(stopped)${C.reset}\n`);
        else console.log(`\n  ${C.yellow}orchestrator error: ${err?.message ?? err}${C.reset}\n`);
      } finally {
        turnActive = false;
        activeAbort = null;
      }
      continue;
    }

    // /init: skip if the project is already initialized, unless forced.
    const wantInit = input === '/init' || input.startsWith('/init ');
    const initForced = /(^|\s)(force|--force|-f)(\s|$)/.test(input);
    if (wantInit && !initForced && readProjectContext()) {
      console.log(
        `  ${C.dim}${CONTEXT_FILE} already exists and is loaded as context. Use ${C.reset}${C.cyan}/init force${C.reset}${C.dim} to regenerate it.${C.reset}\n`,
      );
      continue;
    }

    if (!chain.length) {
      console.log(`\n${C.yellow}  No coder model configured. Open the web UI (start.bat) and add one.${C.reset}\n`);
      continue;
    }
    // Run from the /coder-<n> selection: the active model is primary, later models
    // remain as failover. (Default activeIndex 0 = the whole chain.)
    const activeChain = chain.slice(activeIndex);
    // Ensure a key is available (may have just been added in Settings). Only demand the
    // OpenRouter key if the active chain contains an OpenRouter model — a chain of only
    // local/NVIDIA/GitHub/cli models resolves its own auth per provider.
    const needsOpenRouterKey = activeChain.some((m) => providerOf(m) === 'openrouter');
    try {
      config.apiKey = loadConfig({}, { skipApiKey: !needsOpenRouterKey }).apiKey;
    } catch (err: any) {
      console.log(`\n${C.yellow}  ${err.message}${C.reset}\n`);
      continue;
    }

    // /init runs a one-off "analyze the project" task (not added to the chat history).
    const isInit = wantInit;
    // What actually gets sent to the model this turn. For /init it's the analyze prompt;
    // otherwise the user input with any @mentions (e.g. @prd) expanded to inlined files.
    let turnContent = INIT_PROMPT;
    if (isInit) {
      console.log(`\n${C.dim}Analyzing project and writing ${CONTEXT_FILE}...${C.reset}`);
    } else {
      const { text: expanded, skills, matched, unmatched, truncated } = await resolveMentions(
        input,
        workDir,
        loadSkillsFor(workDir),
      );
      turnContent = expanded;
      for (const s of skills) console.log(`  ${C.magenta}[skill loaded: ${s}]${C.reset}`);
      if (matched.length) {
        const files = matched.flatMap((m) => m.files);
        console.log(
          `  ${C.dim}@mention -> attached ${files.length} file${files.length === 1 ? '' : 's'}: ${files.join(', ')}${truncated ? ' (truncated to fit context)' : ''}${C.reset}`,
        );
      }
      for (const t of unmatched) console.log(`  ${C.yellow}no skill or file matched @${t}${C.reset}`);
      messages.push({ role: 'user', content: expanded });
      await ensureSession();
      await log('user', expanded);
      if (sessionId != null) await setSessionTitle(sessionId, input.slice(0, 80)).catch(() => {});
    }
    console.log();
    renderer.reset();
    // Refresh the system prompt (incl. the project file map) so this turn reflects any files
    // created/renamed since the last turn — the coder stays aware without re-listing.
    if (!isInit) rebuildSystemPrompt();

    // Track which mutating tools ran this turn — if any, we auto-commit afterward.
    const mutated = new Set<string>();

    turnActive = true; // suppress live "set from UI" chain announcements during the turn
    activeAbort = new AbortController(); // Esc aborts this turn
    console.log(`  ${C.dim}(Esc to stop)${C.reset}`);
    renderer.think(); // whimsical spinner until the first real output arrives
    // Print a status line without stomping the spinner: clear it, log, then re-arm (work continues).
    const statusLine = (msg: string) => { renderer.clearThinking(); console.log(msg); renderer.think(); };
    try {
      const agentInput = isInit ? turnContent : messages.length > 1 ? messages : turnContent;
      // If an orchestrator model is configured, it plans the task and delegates to the
      // coder chain; otherwise the coder chain runs directly (resiliently).
      const orchestratorChain = readAgents().orchestrator;
      const useOrchestrator = orchestratorChain.length > 0 && !isInit;
      const sharedHandlers = {
        signal: activeAbort.signal,
        onEvent: (e: AgentEvent) => {
          if (e.type === 'plan') {
            renderer.clearThinking();
            const prov = e.source ? `${C.dim} · from ${e.source}${C.reset}` : '';
            const verb = e.resumed ? 'resuming plan' : 'plan';
            console.log(`\n  ${C.magenta}▣ ${verb}${C.reset} ${C.dim}(orchestrator: ${shortName(e.orchestrator)})${C.reset}${prov}`);
            if (e.resumed) console.log(`  ${C.dim}continuing ${e.steps.length} open board card(s)${C.reset}`);
            e.steps.forEach((s, i) => console.log(`  ${C.dim}${i + 1}.${C.reset} ${s}`));
            renderer.think();
            return;
          }
          if (e.type === 'step') {
            if (e.phase === 'start') statusLine(`\n  ${C.cyan}▶ step ${e.index + 1}/${e.total}${C.reset} ${C.dim}${e.title}${C.reset}`);
            else statusLine(`  ${e.phase === 'failed' ? `${C.yellow}✗` : `${C.green}✓`} step ${e.index + 1}${C.reset}${e.note ? ` ${C.dim}${e.note}${C.reset}` : ''}`);
            return;
          }
          if (e.type === 'coder') {
            // Show which coder model is actually doing the work.
            statusLine(`  ${C.gray}⟢ coder ${activeIndex + e.index + 1}: ${C.reset}${C.cyan}${shortName(e.model)}${C.reset}`);
            return;
          }
          if (e.type === 'delegate') {
            // The orchestrator handing a task to a coder subagent.
            statusLine(`\n  ${C.magenta}⇢ delegating to a coder${C.reset} ${C.dim}${e.task}${C.reset}`);
            return;
          }
          if (e.type === 'tool_call' && MUTATING_TOOLS.has(e.name)) mutated.add(e.name);
          renderer.handle(e);
        },
        onFailover: ({ from, to, index, error, permanent }: { from: string; to: string; index: number; error: string; permanent?: boolean }) => {
          renderer.clearThinking();
          const why = permanent ? 'permanent error' : needsUserAction(error) ? 'rate-limited/needs action' : 'failed';
          // index is the source's 1-based position in the active sub-chain; offset by
          // activeIndex for the absolute coder number.
          console.log(
            `\n${C.yellow}  ! coder ${activeIndex + index} ${shortName(from)} ${why} — ${useOrchestrator ? 'orchestrator ' : ''}reassigning to coder ${activeIndex + index + 1} ${shortName(to)}${C.reset} ${C.dim}(${error})${C.reset}`,
          );
          if (permanent) {
            // 403/404/413 — the model is inaccessible/invalid and fails every time. Remove it
            // from the chain entirely rather than demoting (which would just retry it later).
            removeModelFromChain('coder', from);
            console.log(`  ${C.yellow}✂ removed ${shortName(from)} from the coder chain (permanent error — fix the id or access to re-add)${C.reset}`);
          } else {
            // Deprioritize the failed coder so the next task skips it until the chain cycles back.
            demoteModelInChain('coder', from);
            console.log(`  ${C.dim}↓ moved ${shortName(from)} to the bottom of the coder list${C.reset}`);
          }
          renderer.think(); // resume the spinner while the next model spins up
        },
        onContinue: ({ model, reason }: { model: string; reason: 'step-cap' | 'handoff' }) => {
          if (reason === 'step-cap')
            statusLine(`\n${C.dim}  … ${shortName(model)} hit the step cap — continuing the task (not done yet)${C.reset}`);
        },
      };
      // Non-orchestrated coder turn: fold the relevant project-brain notes into the input.
      // (The orchestrator does its own brain retrieval per plan + per step.)
      let resilientInput: string | ChatMessage[] = agentInput;
      if (!useOrchestrator && !isInit) {
        const notes = await retrieveBrain(workDir, turnContent);
        if (notes.length) {
          const brain = formatBrainContext(notes);
          console.log(`  ${C.magenta}🧠 brain: ${notes.length} relevant note(s) in context${C.reset}`);
          resilientInput = Array.isArray(agentInput)
            ? [{ role: 'system', content: brain }, ...agentInput]
            : `${brain}\n\n---\n\n${turnContent}`;
        }
      }
      // Orchestrated turns run the CONVERSATIONAL orchestrator: you talk to it and it delegates
      // coding to coder subagents (streaming their work), keeping context across turns.
      const result: any = useOrchestrator
        ? await runConversationalOrchestrator(config, orchestratorChain, activeChain, agentInput, sharedHandlers)
        : await runResilientChain(config, activeChain, resilientInput, sharedHandlers);
      renderer.done();
      if (isInit) {
        const ok = rebuildSystemPrompt();
        console.log(
          `\n${C.green}[ok]${C.reset} ${ok ? `${CONTEXT_FILE} written and loaded as context.` : `Done (no ${CONTEXT_FILE} found - did the model write it?).`}`,
        );
      } else {
        // The conversational orchestrator already streamed its messages as text events, so don't
        // reprint (result.conversational). Coder-only runs also streamed their text.
        if (useOrchestrator && !result.conversational && result.text) console.log(`\n${result.text}\n`);
        messages.push({ role: 'assistant', content: result.text });
        await log('assistant', result.text);
        memoryDirty = true; // new exchange worth folding into project memory
      }

      // Auto-commit any file changes this turn made, tagged with the request.
      if (autoCommit && gitEnabled && mutated.size) {
        const subject = (isInit ? `init: ${CONTEXT_FILE}` : input).split('\n')[0].slice(0, 72);
        const c = await commitAll(workDir, subject, undefined, AGENT_AUTHOR);
        if (c.committed) {
          await refreshRecentChanges();
          rebuildSystemPrompt();
          console.log(`  ${C.gray}committed ${c.hash} (${c.files} file${c.files === 1 ? '' : 's'})${C.reset}`);
        }
      }

      const inT = result.usage?.inputTokens ?? 0;
      const outT = result.usage?.outputTokens ?? 0;
      total.input += inT;
      total.output += outT;
      const usedNote = result.failedOver ? `${C.yellow}(via ${shortName(result.model)})${C.reset}  ` : '';
      console.log(
        `\n${usedNote}${C.gray}${formatTokens(inT)} in | ${formatTokens(outT)} out  |  session ${formatTokens(total.input)}/${formatTokens(total.output)}${C.reset}\n`,
      );
    } catch (err: any) {
      renderer.done();
      if (isAbortError(err, activeAbort?.signal)) {
        // User pressed Esc. Keep the user message in history (they can retry/continue),
        // but record a short assistant marker so the transcript stays coherent.
        console.log(`\n${C.yellow}  ⓧ stopped${C.reset}\n`);
        if (!isInit) {
          messages.push({ role: 'assistant', content: '[stopped by user]' });
          await log('assistant', '[stopped by user]');
        }
      } else if (needsUserAction(err.message)) {
        console.log(`\n${C.red}  ⚠ Action needed: ${err.message}${C.reset}\n`);
      } else {
        console.log(`\n${C.red}  ✗ All coders failed: ${err.message}${C.reset}\n`);
      }
    } finally {
      turnActive = false;
      activeAbort = null;
    }
  }

  watcher.close();
  rl.close();
  process.exit(0); // ensure a clean exit even if a handle is still open
}

main();
