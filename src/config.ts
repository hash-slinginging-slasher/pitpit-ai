import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { release, version } from 'os';
import { createHash } from 'crypto';

/**
 * Write a file atomically: write a temp file then rename over the target, so a
 * concurrent reader (e.g. the CLI's fs.watch on agent.config.json) never sees a
 * half-written / empty file. Falls back to a direct write if rename is blocked.
 */
function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch {
    try {
      writeFileSync(path, data);
    } finally {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Detect the host OS + shell so the agent generates commands that actually run
 * here. On Windows the shell tool uses cmd.exe, so the model must use `del`/`dir`
 * rather than `rm`/`ls`.
 */
export function osInfo(): { os: string; shell: string; guidance: string } {
  if (process.platform === 'win32') {
    const shell = process.env.COMSPEC || 'cmd.exe';
    let label = 'Windows';
    try {
      const v = version(); // e.g. "Windows 11 Pro"
      const build = Number(release().split('.')[2] || 0);
      label = v && /windows/i.test(v) ? v : build >= 22000 ? 'Windows 11' : 'Windows 10';
    } catch {
      /* keep default */
    }
    return {
      os: label,
      shell,
      guidance:
        `You are on ${label}. The shell tool runs commands through cmd.exe, so use native ` +
        'Windows commands: `dir` (not ls), `del` (not rm), `rmdir /s /q` to remove a folder, ' +
        '`type` (not cat), `copy`, `move`, `ren`, `mkdir`, `findstr` (not grep). Do NOT use Unix ' +
        'commands like rm, ls, cat, touch, or grep — they are not recognized in cmd. Paths use ' +
        'backslashes. For reading, writing, editing, searching, or listing files, prefer the ' +
        'built-in tools (file_read, file_write, file_edit, list_dir, glob, grep) — they are ' +
        'cross-platform and do not depend on the shell.',
    };
  }
  const shell = process.env.SHELL || '/bin/sh';
  const label = process.platform === 'darwin' ? 'macOS' : 'Linux';
  return {
    os: label,
    shell,
    guidance:
      `You are on ${label} using a POSIX shell (${shell}); standard Unix commands apply ` +
      '(ls, rm, cat, grep, etc.). For file reads/writes/edits/search, prefer the built-in tools.',
  };
}

/** The agent kinds, each with its own ordered failover chain of models. The
 * orchestrator plans/manages a task and delegates to the coder chain. */
export type AgentKind = 'orchestrator' | 'coder' | 'image' | 'doc';
export const AGENT_KINDS: AgentKind[] = ['orchestrator', 'coder', 'image', 'doc'];

/** Ordered model chains per agent: index 0 is primary, the rest are failovers. */
export type AgentChains = Record<AgentKind, string[]>;

export interface AgentConfig {
  apiKey: string;
  agents: AgentChains;
  name: string;
  theme: string;
  systemPrompt: string;
  maxSteps: number;
  maxCost: number;
  sessionDir: string;
  /** Auto-commit file changes to git after each turn (per project). Default true. */
  autoCommit: boolean;
}

/** Merge a patch into agent.config.json, preserving all other fields. */
export function updateConfigFile(patch: Record<string, unknown>): void {
  let file: any = {};
  try {
    if (existsSync(CONFIG_PATH)) file = readJsonFile(CONFIG_PATH);
  } catch {
    /* start fresh */
  }
  Object.assign(file, patch);
  writeFileAtomic(CONFIG_PATH, JSON.stringify(file, null, 2) + '\n');
}

/** The primary (first) model of an agent's chain, or '' if none configured. */
export function primaryModel(config: AgentConfig, kind: AgentKind = 'coder'): string {
  return config.agents[kind]?.[0] ?? '';
}

/**
 * The app's install directory (one level up from src/). Config and .env are
 * resolved from here — NOT from process.cwd() — so you can launch the agent
 * from inside any project directory and it still finds the shared model + key.
 */
export const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** Path to the config file the web UI reads/writes. Shared source of truth for the model. */
export const CONFIG_PATH = resolve(APP_DIR, 'agent.config.json');

/** Path to the secrets file (API keys) written by the web UI's Settings panel. Gitignored. */
export const SECRETS_PATH = resolve(APP_DIR, 'secrets.json');

/** Parse a JSON file, tolerating a UTF-8 BOM (Windows editors/PowerShell add one). */
function readJsonFile(path: string): any {
  let text = readFileSync(path, 'utf-8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  return JSON.parse(text);
}

/** Read all stored secrets (API keys). Missing/invalid file → {}. */
export function readSecrets(): Record<string, string> {
  try {
    if (existsSync(SECRETS_PATH)) return readJsonFile(SECRETS_PATH);
  } catch {
    /* ignore malformed file */
  }
  return {};
}

/** Merge and persist secrets written from the Settings UI. Values may be arrays (e.g. multiple keys). */
export function saveSecrets(patch: Record<string, unknown>): void {
  const next = { ...readSecrets(), ...patch };
  writeFileAtomic(SECRETS_PATH, JSON.stringify(next, null, 2) + '\n');
}

/**
 * Resolve ALL configured OpenRouter API keys, in try-order. The runtime rotates through
 * these when one is rate-limited / out of credit (see runAgent). Precedence:
 * OPENROUTER_API_KEY env var first (if set), then the keys saved via the Settings UI —
 * the `openrouterApiKeys` array when present, else the legacy single `openrouterApiKey`.
 * Deduped, trimmed, empties removed.
 */
export function readApiKeys(): string[] {
  const s = readSecrets() as { openrouterApiKey?: string; openrouterApiKeys?: unknown };
  const stored = Array.isArray(s.openrouterApiKeys)
    ? (s.openrouterApiKeys as unknown[]).map(String)
    : s.openrouterApiKey
      ? [s.openrouterApiKey]
      : [];
  const env = process.env.OPENROUTER_API_KEY ? [process.env.OPENROUTER_API_KEY] : [];
  return [...new Set([...env, ...stored].map((k) => (k || '').trim()).filter(Boolean))];
}

/** The primary OpenRouter API key (first in try-order). Empty string if none configured. */
export function readApiKey(): string {
  return readApiKeys()[0] || '';
}

/**
 * Per-key cooldowns. When an OpenRouter key hits a daily/rate limit we record when it
 * becomes usable again (epoch ms), keyed by a fingerprint of the key (never the raw key).
 * Persisted next to secrets.json so a key that's "done for the day" stays skipped across
 * tasks and restarts, not just within one request.
 */
const COOLDOWN_PATH = resolve(APP_DIR, '.key-cooldowns.json');

/** Stable, non-reversible fingerprint of a key (so the cooldown file holds no real keys). */
function keyId(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** Read the cooldown map, dropping entries whose cooldown has already elapsed. */
export function readKeyCooldowns(): Record<string, number> {
  let raw: Record<string, number> = {};
  try {
    if (existsSync(COOLDOWN_PATH)) raw = readJsonFile(COOLDOWN_PATH);
  } catch {
    /* ignore malformed file */
  }
  const now = Date.now();
  const live: Record<string, number> = {};
  for (const [id, until] of Object.entries(raw)) if (typeof until === 'number' && until > now) live[id] = until;
  return live;
}

/** Mark a key as unusable until `untilMs` (epoch ms). No-op if the timestamp is in the past. */
export function markKeyCooldown(key: string, untilMs: number): void {
  if (!key || !(untilMs > Date.now())) return;
  const map = readKeyCooldowns();
  map[keyId(key)] = untilMs;
  writeFileAtomic(COOLDOWN_PATH, JSON.stringify(map, null, 2) + '\n');
}

/** Cooldown expiry for a key (epoch ms), or 0 if it's currently usable. */
export function keyCooldownUntil(key: string): number {
  return readKeyCooldowns()[keyId(key)] ?? 0;
}

/**
 * OpenRouter keys in the order the runtime should try them: keys currently in cooldown
 * (rate-limited "for the day") are skipped while any usable key remains, so we don't keep
 * hammering a key that's done until midnight. If EVERY key is cooling down, return them all
 * ordered by soonest reset (so we still attempt something and surface a fresh error).
 */
export function orderedApiKeys(): string[] {
  const keys = readApiKeys();
  if (keys.length <= 1) return keys;
  const cd = readKeyCooldowns();
  const active = keys.filter((k) => !cd[keyId(k)]);
  if (active.length) return active;
  return keys.slice().sort((a, b) => (cd[keyId(a)] ?? 0) - (cd[keyId(b)] ?? 0));
}

/** Resolve the Postgres connection string: DATABASE_URL env overrides the Settings-saved value. */
export function readDatabaseUrl(): string {
  return process.env.DATABASE_URL || readSecrets().databaseUrl || '';
}

/**
 * Prefix that marks a model as a local llama.cpp (OpenAI-compatible) server rather
 * than an OpenRouter model. e.g. "local/Ornith-1.0-9B". Local models are routed to
 * runLocalAgent (chat/completions) instead of the OpenRouter Responses API.
 */
export const LOCAL_MODEL_PREFIX = 'local/';

/**
 * The "router" a model id targets, decided by its prefix. A failover chain is just an
 * array of model ids, so a single chain can mix routers — routing is per-model.
 *   (bare id) / openrouter/  -> OpenRouter Responses SDK (default; back-compat)
 *   local/<name>             -> local llama.cpp (OpenAI-compatible), no key
 *   nvidia-build/<model>     -> build.nvidia.com (OpenAI-compatible), NVIDIA key
 *   github-models/<model>    -> GitHub Models (OpenAI-compatible), GitHub token
 *   cli/claude|codex|gemini|jules -> a subscription CLI's backend via its OAuth token
 *
 * NOTE: the build.nvidia.com and GitHub routers use DISTINCT prefixes
 * ("nvidia-build/", "github-models/") on purpose — OpenRouter namespaces its models
 * by author, and "nvidia"/"cohere"/etc. are real OpenRouter authors. So a plain
 * "nvidia/nemotron-..." is an OpenRouter model and must route there, not to NVIDIA build.
 */
export type ProviderId =
  | 'openrouter'
  | 'local'
  | 'nvidia'
  | 'github'
  | 'groq'
  | 'cli-claude'
  | 'cli-codex'
  | 'cli-gemini'
  | 'cli-jules'
  | 'cli-opencode';

/** Resolve the router for a model id from its prefix. Unknown/bare ids default to OpenRouter. */
export function providerOf(model: string): ProviderId {
  if (model.startsWith('local/')) return 'local';
  if (model.startsWith('nvidia-build/')) return 'nvidia';
  if (model.startsWith('github-models/')) return 'github';
  if (model.startsWith('groq/')) return 'groq';
  if (model.startsWith('cli/claude')) return 'cli-claude';
  if (model.startsWith('cli/codex')) return 'cli-codex';
  if (model.startsWith('cli/gemini')) return 'cli-gemini';
  if (model.startsWith('cli/jules')) return 'cli-jules';
  if (model.startsWith('cli/opencode')) return 'cli-opencode';
  if (model.startsWith('openrouter/')) return 'openrouter';
  return 'openrouter';
}

/** Strip a known provider prefix, yielding the wire model name the backend expects. */
export function stripPrefix(model: string): string {
  const slash = model.indexOf('/');
  const provider = providerOf(model);
  // Bare OpenRouter ids (e.g. "qwen/qwen3-coder") keep their slash — only strip a
  // leading, explicit router prefix.
  if (provider === 'openrouter') return model.replace(/^openrouter\//, '');
  return slash === -1 ? model : model.slice(slash + 1);
}

/** True if this model id targets the local llama.cpp server. */
export function isLocalModel(model: string): boolean {
  return providerOf(model) === 'local';
}

/** True if this model id targets a subscription-CLI router (cli/*). */
export function isCliModel(model: string): boolean {
  return providerOf(model).startsWith('cli-');
}

/** Base URL of the NVIDIA build OpenAI-compatible API (no trailing slash). */
export function nvidiaBaseUrl(): string {
  const raw = process.env.NVIDIA_BASE_URL || readSecrets().nvidiaBaseUrl || 'https://integrate.api.nvidia.com/v1';
  return raw.replace(/\/+$/, '');
}

/** Base URL of the GitHub Models OpenAI-compatible inference API (no trailing slash). */
export function githubBaseUrl(): string {
  const raw = process.env.GITHUB_MODELS_BASE_URL || readSecrets().githubBaseUrl || 'https://models.github.ai/inference';
  return raw.replace(/\/+$/, '');
}

/** Resolve the NVIDIA API key: NVIDIA_API_KEY env overrides the Settings-saved value. */
export function readNvidiaKey(): string {
  return process.env.NVIDIA_API_KEY || readSecrets().nvidiaApiKey || '';
}

/** Resolve the GitHub Models token: GITHUB_MODELS_TOKEN env overrides the Settings-saved value. */
export function readGithubToken(): string {
  return process.env.GITHUB_MODELS_TOKEN || readSecrets().githubToken || '';
}

/** Base URL of the Groq OpenAI-compatible API (no trailing slash). */
export function groqBaseUrl(): string {
  const raw = process.env.GROQ_BASE_URL || readSecrets().groqBaseUrl || 'https://api.groq.com/openai/v1';
  return raw.replace(/\/+$/, '');
}

/** Resolve the Groq API key: GROQ_API_KEY env overrides the Settings-saved value. */
export function readGroqKey(): string {
  return process.env.GROQ_API_KEY || readSecrets().groqApiKey || '';
}

/**
 * The embedding model id used for the project brain's semantic search (prefixed like any
 * model, e.g. local/nomic-embed-text, github-models/text-embedding-3-small). Empty = brain
 * uses keyword retrieval. CODIGO_EMBED_MODEL env overrides the Settings-saved value.
 */
export function embeddingModel(): string {
  return process.env.CODIGO_EMBED_MODEL || readSecrets().embeddingModel || '';
}

/**
 * Resolve a Gemini API key (Google AI Studio). Precedence: GEMINI_API_KEY →
 * GOOGLE_API_KEY env → secrets.json `geminiApiKey`. When present, cli/gemini uses the
 * public Generative Language API instead of the CLI's Code Assist OAuth backend.
 */
export function readGeminiApiKey(): string {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || readSecrets().geminiApiKey || '';
}

/** Resolve the Jules API key (jules.google → Settings). Env JULES_API_KEY overrides secrets. */
export function readJulesApiKey(): string {
  return process.env.JULES_API_KEY || readSecrets().julesApiKey || '';
}

/**
 * Optional explicit Jules source (a `sources/github-owner-repo` resource name). When
 * unset, cli/jules matches the current project's GitHub origin against your Jules
 * sources. Env JULES_SOURCE overrides the Settings value.
 */
export function readJulesSource(): string {
  return process.env.JULES_SOURCE || readSecrets().julesSource || '';
}

/**
 * Does this model id require a secret key that isn't currently available? Used by the
 * CLI to decide whether to demand a key before a turn. Local + cli/* need no key here
 * (cli/* resolve their own OAuth token at call time); OpenRouter/NVIDIA/GitHub do.
 */
export function modelMissingKey(model: string): boolean {
  switch (providerOf(model)) {
    case 'openrouter':
      return !readApiKey();
    case 'nvidia':
      return !readNvidiaKey();
    case 'github':
      return !readGithubToken();
    case 'groq':
      return !readGroqKey();
    default:
      return false; // local + cli/* handle their own auth
  }
}

/**
 * Base URL of the local OpenAI-compatible server (llama.cpp `llama-server`).
 * Precedence: LLAMA_BASE_URL env → secrets.json `localBaseUrl` → default :8080.
 * Always normalized to end at the `/v1` root (no trailing slash).
 */
export function localBaseUrl(): string {
  const raw = process.env.LLAMA_BASE_URL || readSecrets().localBaseUrl || 'http://localhost:8080/v1';
  return raw.replace(/\/+$/, '');
}

const DEFAULTS: AgentConfig = {
  apiKey: '',
  agents: { orchestrator: [], coder: [], image: [], doc: [] },
  name: 'OpenRouter Coding Agent',
  theme: 'default',
  systemPrompt: [
    'You are a coding assistant with tools to read, write, edit (file_edit / multi_edit),',
    'delete, move, copy files and make directories; search (glob, grep, list_dir); run shell',
    'commands; read documents (view_document: pdf, xlsx, csv, text) and images (view_image);',
    'fetch web pages (web_fetch), search the web, and generate images (generate_image).',
    '',
    'Current working directory: {cwd}',
    'Operating system: {os}',
    '{shellGuidance}',
    '',
    'Guidelines:',
    '- Use your tools proactively. Explore the codebase to find answers instead of asking the user.',
    '- Keep working until the task is fully resolved before responding.',
    '- Do not guess or make up information — use your tools to verify.',
    '- Be concise and direct.',
    '- Show file paths clearly when working with files.',
    '- Prefer the grep and glob tools over shell commands for file search.',
    '- When editing code, make minimal targeted changes consistent with the existing style.',
    '- Use the dedicated file tools (delete_file, move_file, copy_file, make_dir) instead of shell.',
    '- For several edits to one file, use multi_edit in a single call.',
    '- To read a PDF, spreadsheet, or CSV, use view_document; for a screenshot/image use view_image.',
    '- To read a specific web page or docs, use web_fetch; to search the web, use web_search.',
  ].join('\n'),
  maxSteps: 25,
  maxCost: 1.0,
  sessionDir: '.sessions',
  autoCommit: true,
};

/** Load a minimal .env file (KEY=VALUE lines) into process.env if present. */
function loadDotEnv() {
  const envPath = resolve(APP_DIR, '.env');
  if (!existsSync(envPath)) return;
  for (const raw of readFileSync(envPath, 'utf-8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

export function loadConfig(
  overrides: Partial<AgentConfig> = {},
  opts?: { skipApiKey?: boolean },
): AgentConfig {
  loadDotEnv(); // optional legacy support; not required
  let config: AgentConfig = { ...DEFAULTS, agents: { orchestrator: [], coder: [], image: [], doc: [] } };

  if (existsSync(CONFIG_PATH)) {
    const file = readJsonFile(CONFIG_PATH);
    config = { ...config, ...file, agents: normalizeAgents(file) };
  }

  // API key comes from the Settings UI (secrets.json), or an env var override.
  config.apiKey = readApiKey();
  if (process.env.AGENT_MODEL) config.agents.coder = [process.env.AGENT_MODEL];
  if (process.env.AGENT_MAX_STEPS) config.maxSteps = Number(process.env.AGENT_MAX_STEPS);
  if (process.env.AGENT_MAX_COST) config.maxCost = Number(process.env.AGENT_MAX_COST);

  config = { ...config, ...overrides };

  // Make the agent OS-aware: substitute the detected OS + shell guidance.
  const info = osInfo();
  config.systemPrompt = config.systemPrompt.replace('{os}', info.os).replace('{shellGuidance}', info.guidance);

  if (!config.apiKey && !opts?.skipApiKey) {
    throw new Error(
      'No OpenRouter API key set. Run the web UI (start.bat), open Settings (top-right), and paste your key from https://openrouter.ai/keys',
    );
  }
  return config;
}

/** Build the agent chains from a raw config file, migrating the legacy single `model`. */
function normalizeAgents(file: any): AgentChains {
  const out: AgentChains = { orchestrator: [], coder: [], image: [], doc: [] };
  const a = file?.agents ?? {};
  for (const kind of AGENT_KINDS) {
    if (Array.isArray(a[kind])) out[kind] = a[kind].filter((m: unknown): m is string => typeof m === 'string');
  }
  // Legacy: a single `model` string becomes the coder primary if no coder chain yet.
  if (out.coder.length === 0 && typeof file?.model === 'string' && file.model) out.coder = [file.model];
  return out;
}

/** Read just the agent chains from the config file on disk (used by the web server + CLI watch). */
export function readAgents(): AgentChains {
  try {
    if (existsSync(CONFIG_PATH)) return normalizeAgents(readJsonFile(CONFIG_PATH));
  } catch {
    /* ignore */
  }
  return { orchestrator: [], coder: [], image: [], doc: [] };
}

/**
 * Move a model to the BOTTOM of its chain (persisted). Used to deprioritize a coder that
 * just failed / hit a rate limit, so the next task starts with a working model and we don't
 * keep hitting the dead one until the chain cycles back. No-op if it's missing or already last.
 */
export function demoteModelInChain(kind: AgentKind, model: string): string[] {
  const chain = readAgents()[kind];
  const idx = chain.indexOf(model);
  if (idx === -1 || idx === chain.length - 1) return chain;
  const reordered = [...chain.slice(0, idx), ...chain.slice(idx + 1), model];
  saveAgentChain(kind, reordered);
  return reordered;
}

/**
 * Remove a model from its chain entirely (persisted). Used to auto-prune a model that returns
 * a PERMANENT error (403/404/413 — inaccessible/invalid id), which demotion can't fix since it
 * fails every time it's reached. Returns the new chain. No-op if the model isn't present.
 */
export function removeModelFromChain(kind: AgentKind, model: string): string[] {
  const chain = readAgents()[kind];
  if (!chain.includes(model)) return chain;
  const pruned = chain.filter((m) => m !== model);
  saveAgentChain(kind, pruned);
  return pruned;
}

/** Persist one agent's ordered model chain to the config file, preserving other fields. */
export function saveAgentChain(kind: AgentKind, models: string[]): AgentChains {
  let file: any = {};
  try {
    if (existsSync(CONFIG_PATH)) file = readJsonFile(CONFIG_PATH);
  } catch {
    /* start fresh */
  }
  const agents = normalizeAgents(file);
  agents[kind] = models.filter((m) => typeof m === 'string' && m.length > 0);
  file.agents = agents;
  delete file.model; // drop the legacy field once migrated
  writeFileAtomic(CONFIG_PATH, JSON.stringify(file, null, 2) + '\n');
  return agents;
}
