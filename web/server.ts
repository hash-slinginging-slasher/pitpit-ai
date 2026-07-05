import { createServer } from 'http';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CONFIG_PATH, readApiKey, readDatabaseUrl, saveSecrets, readAgents, saveAgentChain, localBaseUrl, AGENT_KINDS, type AgentKind } from '../src/config.js';
import { testConnection, listProjects, listSessions, getSessionWithMessages } from '../src/db.js';

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
      json(res, 200, {
        hasKey: !!key,
        keyMasked: maskKey(key),
        fromEnv: !!process.env.OPENROUTER_API_KEY,
        hasDb: !!dbUrl,
        dbMasked: maskDbUrl(dbUrl),
        dbFromEnv: !!process.env.DATABASE_URL,
        localBaseUrl: localBaseUrl(),
      });
      return;
    }

    // Settings: save the OpenRouter API key and/or Postgres URL (written to secrets.json).
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { openrouterApiKey, databaseUrl } = JSON.parse(body || '{}');
      const patch: Record<string, string> = {};
      if (typeof openrouterApiKey === 'string') patch.openrouterApiKey = openrouterApiKey.trim();
      if (typeof databaseUrl === 'string') patch.databaseUrl = databaseUrl.trim();
      if (!Object.keys(patch).length) return json(res, 400, { error: 'nothing to save' });
      saveSecrets(patch);
      const key = apiKeyNow();
      json(res, 200, { ok: true, hasKey: !!key, keyMasked: maskKey(key), hasDb: !!readDatabaseUrl(), dbMasked: maskDbUrl(readDatabaseUrl()) });
      return;
    }

    // Settings: reveal the full secrets so the user can copy/verify them.
    // Safe because the server binds to 127.0.0.1 only (see server.listen below).
    if (req.method === 'GET' && url.pathname === '/api/settings/reveal') {
      json(res, 200, { openrouterApiKey: apiKeyNow(), databaseUrl: readDatabaseUrl() });
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
