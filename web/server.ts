import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { CONFIG_PATH, readApiKey, readDatabaseUrl, saveSecrets, readAgents, saveAgentChain, localBaseUrl, readNvidiaKey, readGithubToken, readGeminiApiKey, readJulesApiKey, nvidiaBaseUrl, githubBaseUrl, loadConfig, providerOf, AGENT_KINDS, type AgentKind } from '../src/config.js';
import { testConnection, listProjects, listSessions, getSessionWithMessages, dbConfigured, upsertProject, createSession, addMessage, setSessionTitle } from '../src/db.js';
import { runResilientChain, isAbortError, type ChatMessage } from '../src/agent.js';
import { runOrchestrated } from '../src/orchestrator.js';
import { loadSkillsFor, skillIndex } from '../src/skills.js';
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

/** Read the project's AGENTS.md (if any) from the working dir — same context the CLI loads. */
function readAgentsContext(cwd: string): string {
  const p = resolve(cwd, 'AGENTS.md');
  try {
    if (existsSync(p)) return readFileSync(p, 'utf-8').slice(0, 12000);
  } catch {
    /* ignore */
  }
  return '';
}

/**
 * Build the chat system prompt for the web app: base prompt + available skills +
 * AGENTS.md project context. Mirrors what the CLI assembles (minus DB project memory,
 * added later), so the GUI agent behaves like the terminal one.
 */
function buildChatSystemPrompt(cwd: string): string {
  const base = loadConfig({}, { skipApiKey: true }).systemPrompt;
  let sp = base;
  const skills = loadSkillsFor(cwd);
  if (skills.length) {
    sp +=
      `\n\n# Skills available\n` +
      `Reusable instruction sets. When the user references one by name, follow its instructions.\n\n` +
      skillIndex(skills);
  }
  const ctx = readAgentsContext(cwd);
  if (ctx) sp += `\n\n# Project context (from AGENTS.md)\n${ctx}`;
  return sp;
}

/** Read a request's JSON body. */
async function readBody(req: import('http').IncomingMessage): Promise<any> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
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
        hasGemini: !!readGeminiApiKey(),
        geminiMasked: maskKey(readGeminiApiKey()),
        geminiFromEnv: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
        hasJules: !!readJulesApiKey(),
        julesMasked: maskKey(readJulesApiKey()),
        julesFromEnv: !!process.env.JULES_API_KEY,
      });
      return;
    }

    // Settings: save the OpenRouter/NVIDIA/GitHub keys and/or Postgres URL (secrets.json).
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { openrouterApiKey, databaseUrl, nvidiaApiKey, githubToken, geminiApiKey, julesApiKey } = JSON.parse(body || '{}');
      const patch: Record<string, string> = {};
      if (typeof openrouterApiKey === 'string') patch.openrouterApiKey = openrouterApiKey.trim();
      if (typeof databaseUrl === 'string') patch.databaseUrl = databaseUrl.trim();
      if (typeof nvidiaApiKey === 'string') patch.nvidiaApiKey = nvidiaApiKey.trim();
      if (typeof githubToken === 'string') patch.githubToken = githubToken.trim();
      if (typeof geminiApiKey === 'string') patch.geminiApiKey = geminiApiKey.trim();
      if (typeof julesApiKey === 'string') patch.julesApiKey = julesApiKey.trim();
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
        config.systemPrompt = buildChatSystemPrompt(cwd);

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

        const handlers = {
          signal: ac.signal,
          onEvent: (e: any) => send(e),
          onFailover: ({ to, index, error }: { to: string; index: number; error: string }) => send({ type: 'failover', to, index, error }),
          onContinue: ({ model, reason }: { model: string; reason: string }) => send({ type: 'continue', model, reason }),
        };
        // If an orchestrator model is configured, it plans + delegates; else run coders directly.
        const orchestratorChain = readAgents().orchestrator;
        const fullMessages: ChatMessage[] = [...history, { role: 'user', content: resolved.text }];
        const result = orchestratorChain.length
          ? await runOrchestrated(config, orchestratorChain, chain, resolved.text, handlers)
          : await runResilientChain(config, chain, fullMessages.length > 1 ? fullMessages : resolved.text, handlers);

        if (dbConfigured() && sessionId != null) {
          await addMessage(sessionId, 'assistant', result.text).catch(() => {});
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
        else send({ type: 'error', message: err?.message ?? String(err) });
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

// Embedded terminal: a WebSocket per terminal that runs the real coder REPL via a PTY
// in a client-chosen project directory, so /init, /skills, @mentions etc. all work for
// real. Localhost-only (same trust boundary as the rest of the server).
const wss = new WebSocketServer({ server, path: '/ws/term' });
wss.on('connection', (ws, req) => {
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
