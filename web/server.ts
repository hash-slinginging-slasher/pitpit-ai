import { createServer } from 'http';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CONFIG_PATH, readApiKey, readDatabaseUrl, saveSecrets, readAgents, saveAgentChain, localBaseUrl, readNvidiaKey, readGithubToken, readGeminiApiKey, readJulesApiKey, nvidiaBaseUrl, githubBaseUrl, AGENT_KINDS, type AgentKind } from '../src/config.js';
import { testConnection, listProjects, listSessions, getSessionWithMessages } from '../src/db.js';
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
      if (!AGENT_KINDS.includes(agent)) return json(res, 400, { error: 'agent must be coder|image|doc' });
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

    json(res, 404, { error: 'not found' });
  } catch (err: any) {
    json(res, 500, { error: err.message });
  }
});

// Bind to localhost only — secrets are readable via /api/settings/reveal, so the
// server must not be reachable from other machines on the network.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Agent model picker running at http://localhost:${PORT}`);
  console.log(`  Chains are written to ${CONFIG_PATH}`);
  if (!apiKeyNow()) console.log(`  (no API key yet — open Settings, top-right, and paste your OpenRouter key)`);
  console.log();
});
