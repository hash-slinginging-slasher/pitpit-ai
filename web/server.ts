import { createServer } from 'http';
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, rmSync, statSync, watch } from 'fs';
import { resolve, dirname, basename, join, sep, relative } from 'path';
import { fileURLToPath } from 'url';
import { CONFIG_PATH, readApiKey, readDatabaseUrl, saveSecrets, readAgents, saveAgentChain, demoteModelInChain, localBaseUrl, readNvidiaKey, readGithubToken, readGroqKey, readGeminiApiKey, readJulesApiKey, nvidiaBaseUrl, githubBaseUrl, groqBaseUrl, embeddingModel, loadConfig, providerOf, AGENT_KINDS, type AgentKind } from '../src/config.js';
import { testConnection, listProjects, listSessions, getSessionWithMessages, dbConfigured, upsertProject, createSession, addMessage, setSessionTitle } from '../src/db.js';
import { runResilientChain, isAbortError, needsUserAction, type ChatMessage } from '../src/agent.js';
import { hasGit, isRepo, commitAll, fileHistory, showFileAt, fileDirty, AGENT_AUTHOR, USER_AUTHOR } from '../src/git.js';
import { loadSkillsFor } from '../src/skills.js';
import { resolveMentions } from '../src/mentions.js';
import { WebSocketServer } from 'ws';
import * as pty from 'node-pty';
import { cliStatuses, cliInstall, cliLoginCmd, cliLogoutCmd, deleteCredFiles, CLI_NAMES, type CliName } from '../src/providers/credentials.js';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Launch `command` in a NEW visible terminal window so an interactive login
 * (browser OAuth or a TUI) can complete. Detached — we don't wait for it; the UI
 * polls /api/cli/status to see when the login lands. `command` is a fixed spec value
 * (no user input), so there is no injection surface.
 */
function openInTerminal(command: string): void {
  try {
    if (process.platform === 'win32') {
      // start "" cmd /k "<command>" → new console that stays open with the CLI running.
      spawn('cmd', ['/c', 'start', '""', 'cmd', '/k', command], { detached: true, windowsHide: false, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('osascript', ['-e', `tell app "Terminal" to do script "${command.replace(/"/g, '\\"')}"`], { detached: true, stdio: 'ignore' }).unref();
    } else {
      // Best-effort on Linux: try a couple of common terminals, else run detached.
      spawn('/bin/sh', ['-c', `x-terminal-emulator -e ${command} || gnome-terminal -- ${command} || ${command}`], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* non-fatal */
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, '..'); // project root (one level up from web/)
const PORT = Number(process.env.PORT) || 7000;

// Read the key live on each request so a key saved in Settings works immediately.
// It's only used server-side to call OpenRouter; never sent to the browser.
function apiKeyNow(): string {
  return readApiKey();
}

/** Mask a key for display: sk-or-v1-abcd…wxyz */
function maskKey(key: string): string {
  if (!key) return '';
  return key.length <= 12 ? key.slice(0, 4) + '…' : key.slice(0, 8) + '…' + key.slice(-4);
}

/** Mask the password in a Postgres URL for display. */
function maskDbUrl(url: string): string {
  if (!url) return '';
  return url.replace(/:\/\/([^:@/]+):([^@]+)@/, '://$1:***@');
}

function json(res: import('http').ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(data);
}

async function fetchModels() {
  const headers: Record<string, string> = {};
  const apiKey = apiKeyNow();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const r = await fetch('https://openrouter.ai/api/v1/models', { headers });
  if (!r.ok) throw new Error(`OpenRouter returned ${r.status}`);
  const body = (await r.json()) as { data: any[] };
  return body.data.map((m) => ({
    id: m.id,
    name: m.name,
    context: m.context_length,
    promptPrice: Number(m.pricing?.prompt ?? 0),
    completionPrice: Number(m.pricing?.completion ?? 0),
    inputModalities: m.architecture?.input_modalities ?? [],
    outputModalities: m.architecture?.output_modalities ?? [],
    description: m.description,
  }));
}

/** A model card in the shape the web grid expects, prefixed with its router id. */
function card(id: string, extra: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    name: id,
    context: 0,
    promptPrice: 0,
    completionPrice: 0,
    inputModalities: [] as string[],
    outputModalities: [] as string[],
    description: '',
    ...extra,
  };
}

/**
 * NVIDIA build catalog. Its OpenAI-compatible `GET /v1/models` lists model ids; we
 * prefix them with `nvidia/` so they route correctly. Needs the NVIDIA key.
 */
async function fetchNvidiaModels() {
  const key = readNvidiaKey();
  if (!key) throw new Error('No NVIDIA API key set — add it in Settings.');
  const r = await fetch(`${nvidiaBaseUrl()}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`NVIDIA returned ${r.status}`);
  const body = (await r.json()) as { data: any[] };
  return (body.data ?? []).map((m) => card(`nvidia-build/${m.id}`, { name: m.id, description: m.owned_by ? `owner: ${m.owned_by}` : '' }));
}

/**
 * GitHub Models catalog. `GET https://models.github.ai/catalog/models` returns the
 * marketplace list; ids route as `github/<publisher>/<name>`. Needs a GitHub token.
 */
async function fetchGithubModels() {
  const token = readGithubToken();
  if (!token) throw new Error('No GitHub token set — add it in Settings.');
  const base = githubBaseUrl().replace(/\/inference$/, '');
  const r = await fetch(`${base}/catalog/models`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!r.ok) throw new Error(`GitHub Models returned ${r.status}`);
  const list = (await r.json()) as any[];
  return (Array.isArray(list) ? list : []).map((m) => {
    const wire = m.id || (m.publisher && m.name ? `${m.publisher}/${m.name}` : m.name);
    return card(`github-models/${wire}`, {
      name: m.name || wire,
      description: m.summary || m.description || (m.publisher ? `by ${m.publisher}` : ''),
      inputModalities: m.supported_input_modalities ?? [],
      outputModalities: m.supported_output_modalities ?? [],
    });
  });
}

/**
 * Groq catalog. Its OpenAI-compatible `GET /openai/v1/models` lists model ids; we prefix
 * them with `groq/` so they route to Groq. Needs the Groq key.
 */
async function fetchGroqModels() {
  const key = readGroqKey();
  if (!key) throw new Error('No Groq API key set — add it in Settings.');
  const r = await fetch(`${groqBaseUrl()}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`Groq returned ${r.status}`);
  const body = (await r.json()) as { data: any[] };
  return (body.data ?? []).map((m) =>
    card(`groq/${m.id}`, {
      name: m.id,
      context: m.context_window ?? 0,
      description: m.owned_by ? `owner: ${m.owned_by}` : '',
    }),
  );
}

/**
 * System prompt for the Chat tab — a plain general assistant, NOT a project coder.
 * (The Projects-tab terminal is where the real project-scoped coder/orchestrator lives.)
 */
const GENERAL_SYSTEM = [
  'You are Codigo, a helpful, friendly general assistant.',
  'Answer questions directly, do math, explain things, write and format text, and help with coding when asked. Be concise.',
  'You have tools (file read/write, shell, etc.) but use them ONLY when the task clearly needs them —',
  'for example when the user explicitly asks you to create, edit, or save a file.',
  'For ordinary questions, math, or formatting text, just answer directly in your reply: do NOT explore the',
  'filesystem, do NOT assume the user is working on a coding project, and do NOT make a plan or checklist.',
].join(' ');

/** Read a request's JSON body. */
async function readBody(req: import('http').IncomingMessage): Promise<any> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

// ---- File explorer + versioning helpers ----

const TREE_IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.venv', '__pycache__']);
const MAX_FILE_BYTES = 1_000_000;

/** Resolve a project-relative path safely — null if it escapes the project dir. */
function safePath(cwd: string, rel: string): string | null {
  const base = resolve(cwd);
  const p = resolve(base, rel || '.');
  if (p !== base && !p.startsWith(base + sep)) return null;
  return p;
}

/** Build a nested file tree (dirs first), bounded so a huge repo can't stall the server. */
function buildTree(baseAbs: string, relPrefix: string, depth: number, budget: { n: number }): any[] {
  if (depth > 12 || budget.n > 5000) return [];
  let entries: import('fs').Dirent[];
  try {
    entries = readdirSync(join(baseAbs, relPrefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: any[] = [];
  const files: any[] = [];
  for (const e of entries) {
    if (TREE_IGNORE.has(e.name)) continue;
    budget.n++;
    const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
    if (e.isDirectory()) dirs.push({ name: e.name, path: rel, type: 'dir', children: buildTree(baseAbs, rel, depth + 1, budget) });
    else files.push({ name: e.name, path: rel, type: 'file' });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return [...dirs, ...files];
}

/** Looks binary if the first chunk has a NUL byte. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

    if (req.method === 'GET' && url.pathname === '/') {
      const html = readFileSync(resolve(__dirname, 'index.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/models') {
      const models = await fetchModels();
      json(res, 200, { models, agents: readAgents(), hasKey: !!apiKeyNow() });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      json(res, 200, { agents: readAgents(), hasKey: !!apiKeyNow() });
      return;
    }

    // NVIDIA build catalog (prefixed nvidia/…). Returns { error } if no key / fetch fails.
    if (req.method === 'GET' && url.pathname === '/api/models/nvidia') {
      try {
        json(res, 200, { models: await fetchNvidiaModels(), agents: readAgents(), hasKey: !!readNvidiaKey() });
      } catch (e: any) {
        json(res, 200, { models: [], agents: readAgents(), hasKey: !!readNvidiaKey(), error: e.message });
      }
      return;
    }

    // GitHub Models catalog (prefixed github/…). Returns { error } if no token / fetch fails.
    if (req.method === 'GET' && url.pathname === '/api/models/github') {
      try {
        json(res, 200, { models: await fetchGithubModels(), agents: readAgents(), hasKey: !!readGithubToken() });
      } catch (e: any) {
        json(res, 200, { models: [], agents: readAgents(), hasKey: !!readGithubToken(), error: e.message });
      }
      return;
    }

    // Groq catalog (prefixed groq/…). Returns { error } if no key / fetch fails.
    if (req.method === 'GET' && url.pathname === '/api/models/groq') {
      try {
        json(res, 200, { models: await fetchGroqModels(), agents: readAgents(), hasKey: !!readGroqKey() });
      } catch (e: any) {
        json(res, 200, { models: [], agents: readAgents(), hasKey: !!readGroqKey(), error: e.message });
      }
      return;
    }

    // Auth-CLI routers: install + login status (booleans only, never tokens).
    if (req.method === 'GET' && url.pathname === '/api/cli/status') {
      json(res, 200, { clis: cliStatuses(), agents: readAgents() });
      return;
    }

    // Auth-CLI routers: one-click global install of the CLI's npm package.
    if (req.method === 'POST' && url.pathname === '/api/cli/install') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { name } = JSON.parse(body || '{}');
      if (!CLI_NAMES.includes(name)) return json(res, 400, { error: 'unknown cli' });
      const { command } = cliInstall(name as CliName);
      try {
        const { stdout, stderr } = await execAsync(command, { timeout: 300000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
        json(res, 200, { ok: true, command, output: (stdout + stderr).trim().slice(-2000), clis: cliStatuses() });
      } catch (e: any) {
        json(res, 200, { ok: false, command, error: String(e.stderr || e.stdout || e.message || '').slice(-2000), clis: cliStatuses() });
      }
      return;
    }

    // Auth-CLI routers: open a terminal for the CLI's interactive login (browser OAuth).
    if (req.method === 'POST' && url.pathname === '/api/cli/login') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { name } = JSON.parse(body || '{}');
      if (!CLI_NAMES.includes(name)) return json(res, 400, { error: 'unknown cli' });
      const loginCmd = cliLoginCmd(name as CliName);
      openInTerminal(loginCmd);
      json(res, 200, { ok: true, loginCmd, note: 'A terminal window opened — complete the sign-in there.' });
      return;
    }

    // Auth-CLI routers: log out (delete the stored token, or run the CLI's logout).
    if (req.method === 'POST' && url.pathname === '/api/cli/logout') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { name } = JSON.parse(body || '{}');
      if (!CLI_NAMES.includes(name)) return json(res, 400, { error: 'unknown cli' });
      const removed = deleteCredFiles(name as CliName);
      const logoutCmd = cliLogoutCmd(name as CliName);
      // If there was no local token file to remove, fall back to the CLI's logout command.
      let ranLogout = false;
      if (!removed && logoutCmd) {
        openInTerminal(logoutCmd);
        ranLogout = true;
      }
      json(res, 200, { ok: true, removed, ranLogout, clis: cliStatuses() });
      return;
    }

    // Agents: return the failover chains for coder/image/doc.
    if (req.method === 'GET' && url.pathname === '/api/agents') {
      json(res, 200, { agents: readAgents() });
      return;
    }

    // Agents: save one agent's ordered failover chain (index 0 = primary).
    if (req.method === 'POST' && url.pathname === '/api/agents') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { agent, models } = JSON.parse(body || '{}');
      if (!AGENT_KINDS.includes(agent)) return json(res, 400, { error: `agent must be one of ${AGENT_KINDS.join('|')}` });
      if (!Array.isArray(models) || !models.every((m) => typeof m === 'string'))
        return json(res, 400, { error: 'models must be an array of strings' });
      const agents = saveAgentChain(agent as AgentKind, models);
      json(res, 200, { ok: true, agents });
      return;
    }

    // Settings: report what's configured (masked only — never send secrets in full).
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      const key = apiKeyNow();
      const dbUrl = readDatabaseUrl();
      const nvidia = readNvidiaKey();
      const github = readGithubToken();
      json(res, 200, {
        hasKey: !!key,
        keyMasked: maskKey(key),
        fromEnv: !!process.env.OPENROUTER_API_KEY,
        hasDb: !!dbUrl,
        dbMasked: maskDbUrl(dbUrl),
        dbFromEnv: !!process.env.DATABASE_URL,
        localBaseUrl: localBaseUrl(),
        hasNvidia: !!nvidia,
        nvidiaMasked: maskKey(nvidia),
        nvidiaFromEnv: !!process.env.NVIDIA_API_KEY,
        hasGithub: !!github,
        githubMasked: maskKey(github),
        githubFromEnv: !!process.env.GITHUB_MODELS_TOKEN,
        hasGroq: !!readGroqKey(),
        groqMasked: maskKey(readGroqKey()),
        groqFromEnv: !!process.env.GROQ_API_KEY,
        hasGemini: !!readGeminiApiKey(),
        geminiMasked: maskKey(readGeminiApiKey()),
        geminiFromEnv: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
        hasJules: !!readJulesApiKey(),
        julesMasked: maskKey(readJulesApiKey()),
        julesFromEnv: !!process.env.JULES_API_KEY,
        embedModel: embeddingModel(),
      });
      return;
    }

    // Settings: save the OpenRouter/NVIDIA/GitHub keys and/or Postgres URL (secrets.json).
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { openrouterApiKey, databaseUrl, nvidiaApiKey, githubToken, groqApiKey, geminiApiKey, julesApiKey, embeddingModel: embedModelInput } = JSON.parse(body || '{}');
      const patch: Record<string, string> = {};
      if (typeof openrouterApiKey === 'string') patch.openrouterApiKey = openrouterApiKey.trim();
      if (typeof databaseUrl === 'string') patch.databaseUrl = databaseUrl.trim();
      if (typeof nvidiaApiKey === 'string') patch.nvidiaApiKey = nvidiaApiKey.trim();
      if (typeof githubToken === 'string') patch.githubToken = githubToken.trim();
      if (typeof groqApiKey === 'string') patch.groqApiKey = groqApiKey.trim();
      if (typeof geminiApiKey === 'string') patch.geminiApiKey = geminiApiKey.trim();
      if (typeof julesApiKey === 'string') patch.julesApiKey = julesApiKey.trim();
      if (typeof embedModelInput === 'string') patch.embeddingModel = embedModelInput.trim();
      if (!Object.keys(patch).length) return json(res, 400, { error: 'nothing to save' });
      saveSecrets(patch);
      const key = apiKeyNow();
      json(res, 200, {
        ok: true,
        hasKey: !!key,
        keyMasked: maskKey(key),
        hasDb: !!readDatabaseUrl(),
        dbMasked: maskDbUrl(readDatabaseUrl()),
        hasNvidia: !!readNvidiaKey(),
        nvidiaMasked: maskKey(readNvidiaKey()),
        hasGithub: !!readGithubToken(),
        githubMasked: maskKey(readGithubToken()),
        hasGroq: !!readGroqKey(),
        groqMasked: maskKey(readGroqKey()),
        hasGemini: !!readGeminiApiKey(),
        geminiMasked: maskKey(readGeminiApiKey()),
        hasJules: !!readJulesApiKey(),
        julesMasked: maskKey(readJulesApiKey()),
      });
      return;
    }

    // Settings: reveal the full secrets so the user can copy/verify them.
    // Safe because the server binds to 127.0.0.1 only (see server.listen below).
    if (req.method === 'GET' && url.pathname === '/api/settings/reveal') {
      json(res, 200, {
        openrouterApiKey: apiKeyNow(),
        databaseUrl: readDatabaseUrl(),
        nvidiaApiKey: readNvidiaKey(),
        githubToken: readGithubToken(),
        groqApiKey: readGroqKey(),
        geminiApiKey: readGeminiApiKey(),
        julesApiKey: readJulesApiKey(),
      });
      return;
    }

    // Database: test the connection (also creates the schema on success).
    if (req.method === 'POST' && url.pathname === '/api/db/test') {
      json(res, 200, await testConnection());
      return;
    }

    // The server's working directory (the folder the GUI agent edits by default).
    if (req.method === 'GET' && url.pathname === '/api/cwd') {
      json(res, 200, { cwd: process.cwd(), name: basename(process.cwd()) || process.cwd() });
      return;
    }

    // --- File explorer + versioning (all scoped to a project `cwd` query param) ---

    // File tree for a project directory.
    if (req.method === 'GET' && url.pathname === '/api/files') {
      const cwd = url.searchParams.get('cwd') || process.cwd();
      if (!existsSync(cwd)) return json(res, 404, { error: 'directory not found' });
      json(res, 200, { cwd, tree: buildTree(resolve(cwd), '', 0, { n: 0 }) });
      return;
    }

    // Read one file's content (+ git dirty flag).
    if (req.method === 'GET' && url.pathname === '/api/file') {
      const cwd = url.searchParams.get('cwd') || process.cwd();
      const rel = url.searchParams.get('path') || '';
      const abs = safePath(cwd, rel);
      if (!abs || !existsSync(abs) || !statSync(abs).isFile()) return json(res, 404, { error: 'file not found' });
      const buf = readFileSync(abs);
      if (buf.length > MAX_FILE_BYTES) return json(res, 200, { path: rel, tooLarge: true, size: buf.length });
      if (looksBinary(buf)) return json(res, 200, { path: rel, binary: true, size: buf.length });
      const dirty = (await isRepo(cwd)) ? await fileDirty(cwd, rel) : false;
      json(res, 200, { path: rel, content: buf.toString('utf-8'), dirty });
      return;
    }

    // Write a file (your edit) → commit as "you".
    if (req.method === 'POST' && url.pathname === '/api/file') {
      const { cwd, path: rel, content } = await readBody(req);
      const abs = safePath(cwd || process.cwd(), rel || '');
      if (!abs || !rel) return json(res, 400, { error: 'bad path' });
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, typeof content === 'string' ? content : '');
      let hash: string | undefined;
      if ((await hasGit()) && (await isRepo(cwd))) {
        const c = await commitAll(cwd, `edit ${rel}`, undefined, USER_AUTHOR);
        hash = c.hash;
      }
      json(res, 200, { ok: true, hash });
      return;
    }

    // Delete a file → commit as "you".
    if (req.method === 'POST' && url.pathname === '/api/file/delete') {
      const { cwd, path: rel } = await readBody(req);
      const abs = safePath(cwd || process.cwd(), rel || '');
      if (!abs || !rel || !existsSync(abs)) return json(res, 404, { error: 'file not found' });
      rmSync(abs, { recursive: true, force: true });
      if ((await hasGit()) && (await isRepo(cwd))) await commitAll(cwd, `delete ${rel}`, undefined, USER_AUTHOR);
      json(res, 200, { ok: true });
      return;
    }

    // Version history for a file.
    if (req.method === 'GET' && url.pathname === '/api/file/history') {
      const cwd = url.searchParams.get('cwd') || process.cwd();
      const rel = url.searchParams.get('path') || '';
      if (!(await isRepo(cwd))) return json(res, 200, { versions: [], noGit: true });
      json(res, 200, { versions: await fileHistory(cwd, rel) });
      return;
    }

    // A file's content at a specific version (for viewing/diffing).
    if (req.method === 'GET' && url.pathname === '/api/file/version') {
      const cwd = url.searchParams.get('cwd') || process.cwd();
      const rel = url.searchParams.get('path') || '';
      const hash = url.searchParams.get('hash') || '';
      try {
        json(res, 200, { content: await showFileAt(cwd, rel, hash) });
      } catch (e: any) {
        json(res, 200, { error: e.message, content: '' });
      }
      return;
    }

    // Restore a file to an old version → writes it back and commits as "you".
    if (req.method === 'POST' && url.pathname === '/api/file/restore') {
      const { cwd, path: rel, hash } = await readBody(req);
      const abs = safePath(cwd || process.cwd(), rel || '');
      if (!abs || !rel || !hash) return json(res, 400, { error: 'bad request' });
      try {
        const content = await showFileAt(cwd, rel, hash);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
        const c = await commitAll(cwd, `restore ${rel} to ${String(hash).slice(0, 7)}`, undefined, USER_AUTHOR);
        json(res, 200, { ok: true, hash: c.hash });
      } catch (e: any) {
        json(res, 200, { ok: false, error: e.message });
      }
      return;
    }

    // Projects registry + session history.
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      try {
        json(res, 200, { projects: await listProjects() });
      } catch (e: any) {
        json(res, 200, { projects: [], error: e.message });
      }
      return;
    }
    let mm: RegExpMatchArray | null;
    if (req.method === 'GET' && (mm = url.pathname.match(/^\/api\/projects\/(\d+)\/sessions$/))) {
      json(res, 200, { sessions: await listSessions(Number(mm[1])) });
      return;
    }
    if (req.method === 'GET' && (mm = url.pathname.match(/^\/api\/sessions\/(\d+)$/))) {
      json(res, 200, await getSessionWithMessages(Number(mm[1])));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/projects') {
      const html = readFileSync(resolve(__dirname, 'projects.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/chat') {
      const html = readFileSync(resolve(__dirname, 'chat.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }

    // xterm.js assets (served from node_modules for the Projects-tab terminal).
    if (req.method === 'GET' && url.pathname.startsWith('/vendor/')) {
      const VENDOR: Record<string, [string, string]> = {
        '/vendor/xterm.js': ['node_modules/@xterm/xterm/lib/xterm.js', 'application/javascript'],
        '/vendor/xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', 'text/css'],
        '/vendor/addon-fit.js': ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'application/javascript'],
      };
      const entry = VENDOR[url.pathname];
      if (entry) {
        res.writeHead(200, { 'Content-Type': entry[1] });
        res.end(readFileSync(resolve(appRoot, entry[0])));
        return;
      }
    }

    // Streaming chat: run the coder chain and stream AgentEvents to the browser over SSE.
    // Body: { message, history?: ChatMessage[], sessionId?: number }. The client keeps the
    // conversation and sends it back each turn; the server persists to the DB if configured.
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const body = await readBody(req);
      const message: string = (body.message ?? '').toString();
      const history: ChatMessage[] = Array.isArray(body.history) ? body.history : [];
      let sessionId: number | null = body.sessionId ?? null;
      if (!message.trim()) {
        json(res, 400, { error: 'empty message' });
        return;
      }
      const chain = readAgents().coder;
      if (!chain.length) {
        json(res, 400, { error: 'No coder model configured. Add one on the Code tab.' });
        return;
      }

      const cwd = process.cwd();
      // SSE headers. Each event is one `data: {json}\n\n` line.
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

      // Client stop / disconnect aborts the run (this is the GUI's Esc).
      const ac = new AbortController();
      req.on('close', () => ac.abort());

      try {
        // Only demand the OpenRouter key if the chain actually contains an OpenRouter model.
        const needsKey = chain.some((m) => providerOf(m) === 'openrouter');
        const config = loadConfig({}, { skipApiKey: !needsKey });
        // Chat is a general assistant, not a project coder — give it a light prompt + the
        // current date/time so "what day is it?" works.
        config.systemPrompt = `${GENERAL_SYSTEM}\n\nThe current date and time is ${new Date().toString()}.`;

        // Expand @mentions (skills + files) exactly like the CLI.
        const resolved = await resolveMentions(message, cwd, loadSkillsFor(cwd));
        if (resolved.skills.length) send({ type: 'skills', skills: resolved.skills });
        if (resolved.matched.length) send({ type: 'files', files: resolved.matched.flatMap((m) => m.files) });

        // Persist the user turn + ensure a session exists (best-effort; needs a DB).
        if (dbConfigured()) {
          try {
            if (sessionId == null) {
              const proj = await upsertProject(cwd, basename(cwd) || cwd);
              sessionId = await createSession(proj.id, chain[0]);
              await setSessionTitle(sessionId, message.slice(0, 80)).catch(() => {});
              send({ type: 'session', sessionId });
            }
            await addMessage(sessionId, 'user', resolved.text);
          } catch {
            /* history disabled for this run */
          }
        }

        // Chat runs the coder chain directly (resilient failover), NOT the orchestrator —
        // the orchestrator's plan/delegate flow is for project tasks in the Projects terminal.
        const handlers = {
          signal: ac.signal,
          onEvent: (e: any) => send(e),
          onFailover: ({ from, to, index, error }: { from: string; to: string; index: number; error: string }) => {
            send({ type: 'failover', from, to, index, error, action: needsUserAction(error), orchestrated: false });
            demoteModelInChain('coder', from); // deprioritize the failed coder for next tasks
            send({ type: 'demote', model: from });
          },
          onContinue: ({ model, reason }: { model: string; reason: string }) => send({ type: 'continue', model, reason }),
        };
        const fullMessages: ChatMessage[] = [...history, { role: 'user', content: resolved.text }];
        const result = await runResilientChain(config, chain, fullMessages.length > 1 ? fullMessages : resolved.text, handlers);

        if (dbConfigured() && sessionId != null) {
          await addMessage(sessionId, 'assistant', result.text).catch(() => {});
        }
        // Version the agent's file changes (so the file panel's history captures GUI runs,
        // not just terminal runs). Best-effort; committed as "Codigo (agent)".
        try {
          if ((await hasGit()) && (await isRepo(cwd))) {
            await commitAll(cwd, message.split('\n')[0].slice(0, 72) || 'agent changes', undefined, AGENT_AUTHOR);
          }
        } catch {
          /* non-fatal */
        }
        send({
          type: 'done',
          text: result.text,
          usage: result.usage ?? null,
          model: result.model,
          failedOver: result.failedOver,
          sessionId,
        });
      } catch (err: any) {
        if (isAbortError(err, ac.signal)) send({ type: 'stopped' });
        else {
          const message = err?.message ?? String(err);
          send({ type: 'error', message, action: needsUserAction(message) });
        }
      } finally {
        res.end();
      }
      return;
    }

    json(res, 404, { error: 'not found' });
  } catch (err: any) {
    json(res, 500, { error: err.message });
  }
});

// Two WebSocket endpoints share the HTTP server via noServer routing:
//   /ws/term  — a PTY running the real coder REPL in a project dir
//   /ws/files — a filesystem watcher pushing live file-tree changes
const termWss = new WebSocketServer({ noServer: true });
const filesWss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  if (pathname === '/ws/term') termWss.handleUpgrade(req, socket, head, (ws) => termWss.emit('connection', ws, req));
  else if (pathname === '/ws/files') filesWss.handleUpgrade(req, socket, head, (ws) => filesWss.emit('connection', ws, req));
  else socket.destroy();
});

// Live file tree: watch the project dir and push a (debounced) list of changed paths.
filesWss.on('connection', (ws, req) => {
  const u = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const cwd = u.searchParams.get('cwd') || process.cwd();
  const changed = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const paths = [...changed];
    changed.clear();
    try { ws.send(JSON.stringify({ type: 'change', paths })); } catch { /* client gone */ }
  };
  let watcher: import('fs').FSWatcher | null = null;
  try {
    watcher = watch(cwd, { recursive: true }, (_event, filename) => {
      if (filename) {
        const f = filename.toString().replace(/\\/g, '/');
        if (f.split('/').some((seg) => TREE_IGNORE.has(seg))) return; // skip node_modules/.git/…
        changed.add(f);
      }
      if (!timer) timer = setTimeout(flush, 250);
    });
  } catch {
    /* recursive watch unsupported on this FS — tree just won't auto-refresh */
  }
  ws.on('close', () => {
    if (watcher) { try { watcher.close(); } catch { /* ignore */ } }
    if (timer) clearTimeout(timer);
  });
});

// Embedded terminal: a WebSocket per terminal that runs the real coder REPL via a PTY
// in a client-chosen project directory, so /init, /skills, @mentions etc. all work for
// real. Localhost-only (same trust boundary as the rest of the server).
termWss.on('connection', (ws, req) => {
  const u = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const cwd = u.searchParams.get('cwd') || process.cwd();
  const tsxEntry = resolve(appRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const cliEntry = resolve(appRoot, 'src', 'cli.ts');
  let term: import('node-pty').IPty;
  try {
    term = pty.spawn(process.execPath, [tsxEntry, cliEntry], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd,
      env: { ...process.env, FORCE_COLOR: '1' } as Record<string, string>,
    });
  } catch (e: any) {
    try { ws.send(`\r\n[could not start terminal: ${e.message}]\r\n`); ws.close(); } catch { /* ignore */ }
    return;
  }
  term.onData((d) => { try { ws.send(d); } catch { /* client gone */ } });
  term.onExit(() => { try { ws.close(); } catch { /* ignore */ } });
  ws.on('message', (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'in') term.write(msg.d);
    else if (msg.t === 'resize' && msg.cols && msg.rows) { try { term.resize(msg.cols, msg.rows); } catch { /* ignore */ } }
  });
  ws.on('close', () => { try { term.kill(); } catch { /* ignore */ } });
});

// Bind to localhost only — secrets are readable via /api/settings/reveal, so the
// server must not be reachable from other machines on the network.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Agent model picker running at http://localhost:${PORT}`);
  console.log(`  Chains are written to ${CONFIG_PATH}`);
  if (!apiKeyNow()) console.log(`  (no API key yet — open Settings, top-right, and paste your OpenRouter key)`);
  console.log();
});
