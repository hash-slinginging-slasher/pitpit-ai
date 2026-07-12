import pg from 'pg';
import { readDatabaseUrl } from './config.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;
let schemaReady: Promise<void> | null = null;

/** True if a Postgres connection string is configured (env or Settings). */
export function dbConfigured(): boolean {
  return !!readDatabaseUrl();
}

function getPool(): pg.Pool {
  if (!pool) {
    const url = readDatabaseUrl();
    if (!url) throw new Error('No database configured. Set the Postgres URL in the web UI Settings.');
    pool = new Pool({ connectionString: url, max: 4 });
  }
  return pool;
}

/** Create the tables if they don't exist (runs once per process). */
function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = getPool()
      .query(`
        CREATE TABLE IF NOT EXISTS projects (
          id SERIAL PRIMARY KEY,
          path TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS sessions (
          id SERIAL PRIMARY KEY,
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          title TEXT,
          model TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS messages (
          id SERIAL PRIMARY KEY,
          session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS project_memory (
          project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
          content TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `)
      .then(() => undefined)
      .catch((e) => {
        schemaReady = null; // allow retry after a transient failure
        throw e;
      });
  }
  return schemaReady;
}

export async function testConnection(): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const r = await getPool().query('SELECT version() AS v');
    await ensureSchema();
    return { ok: true, version: r.rows[0].v };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

export interface Project { id: number; path: string; name: string; created_at: string; last_used_at: string; sessions?: number; }
export interface Session { id: number; project_id: number; title: string | null; model: string | null; created_at: string; updated_at: string; messages?: number; }
export interface Message { id: number; session_id: number; role: string; content: string; created_at: string; }

export async function upsertProject(path: string, name: string): Promise<Project> {
  await ensureSchema();
  const r = await getPool().query(
    `INSERT INTO projects(path, name) VALUES($1, $2)
     ON CONFLICT(path) DO UPDATE SET last_used_at = now(), name = EXCLUDED.name
     RETURNING *`,
    [path, name],
  );
  return r.rows[0];
}

export async function createSession(projectId: number, model: string): Promise<number> {
  await ensureSchema();
  const r = await getPool().query('INSERT INTO sessions(project_id, model) VALUES($1, $2) RETURNING id', [projectId, model]);
  return r.rows[0].id;
}

export async function addMessage(sessionId: number, role: string, content: string): Promise<void> {
  const p = getPool();
  await p.query('INSERT INTO messages(session_id, role, content) VALUES($1, $2, $3)', [sessionId, role, content]);
  await p.query('UPDATE sessions SET updated_at = now() WHERE id = $1', [sessionId]);
}

export async function setSessionTitle(sessionId: number, title: string): Promise<void> {
  await getPool().query("UPDATE sessions SET title = $1 WHERE id = $2 AND (title IS NULL OR title = '')", [title, sessionId]);
}

/** Delete a project (and its sessions/messages/memory via ON DELETE CASCADE) by path. */
export async function deleteProjectByPath(path: string): Promise<boolean> {
  await ensureSchema();
  const r = await getPool().query('DELETE FROM projects WHERE path = $1', [path]);
  return (r.rowCount ?? 0) > 0;
}

export async function listProjects(): Promise<Project[]> {
  await ensureSchema();
  const r = await getPool().query(
    `SELECT p.*, (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id)::int AS sessions
     FROM projects p ORDER BY last_used_at DESC`,
  );
  return r.rows;
}

export async function listSessions(projectId: number): Promise<Session[]> {
  await ensureSchema();
  const r = await getPool().query(
    `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id)::int AS messages
     FROM sessions s WHERE project_id = $1 ORDER BY updated_at DESC`,
    [projectId],
  );
  return r.rows;
}

export async function getSessionWithMessages(sessionId: number): Promise<{ session: Session | null; messages: Message[] }> {
  await ensureSchema();
  const s = await getPool().query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
  const m = await getPool().query('SELECT * FROM messages WHERE session_id = $1 ORDER BY id', [sessionId]);
  return { session: s.rows[0] ?? null, messages: m.rows };
}

/** The distilled, auto-maintained memory for a project (empty string if none). */
export async function getProjectMemory(projectId: number): Promise<string> {
  await ensureSchema();
  const r = await getPool().query('SELECT content FROM project_memory WHERE project_id = $1', [projectId]);
  return r.rows[0]?.content ?? '';
}

/** Upsert the project's distilled memory. */
export async function saveProjectMemory(projectId: number, content: string): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO project_memory(project_id, content) VALUES($1, $2)
     ON CONFLICT(project_id) DO UPDATE SET content = EXCLUDED.content, updated_at = now()`,
    [projectId, content],
  );
}

/** Wipe the project's distilled memory. */
export async function clearProjectMemory(projectId: number): Promise<void> {
  await ensureSchema();
  await getPool().query('DELETE FROM project_memory WHERE project_id = $1', [projectId]);
}
