import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { resolve, delimiter } from 'path';
import { readJulesApiKey, readGeminiApiKey } from '../config.js';

/**
 * Credential resolution for the subscription-CLI routers (cli/claude, cli/codex,
 * cli/gemini, cli/jules). Each of those CLIs stores an OAuth token on disk after you
 * log in; this module locates the CLI, reports whether you're logged in, and (in later
 * phases) reads + refreshes the token so we can call the vendor's backend directly.
 *
 * Reading these token files is sensitive — the Claude Code runtime may prompt for
 * permission the first time. Nothing here is ever sent to the browser; the web UI only
 * receives boolean {installed, loggedIn} flags via cliStatuses().
 */

export type CliName = 'claude' | 'codex' | 'gemini' | 'jules';
export const CLI_NAMES: CliName[] = ['claude', 'codex', 'gemini', 'jules'];

/** Static description of where each CLI lives and stores its login. */
interface CliSpec {
  /** Executable base name to look for on PATH. */
  command: string;
  /** Candidate credential file paths (first existing one wins), relative to $HOME. */
  credFiles: string[];
  /** Human label. */
  label: string;
}

const HOME = homedir();
const h = (...p: string[]) => resolve(HOME, ...p);

const CLI_SPECS: Record<CliName, CliSpec> = {
  claude: { command: 'claude', label: 'Claude Code', credFiles: [h('.claude', '.credentials.json')] },
  codex: { command: 'codex', label: 'OpenAI Codex', credFiles: [h('.codex', 'auth.json')] },
  gemini: {
    command: 'gemini',
    label: 'Gemini CLI',
    credFiles: [h('.gemini', 'oauth_creds.json'), h('.config', 'gcloud', 'application_default_credentials.json')],
  },
  jules: { command: 'jules', label: 'Jules', credFiles: [h('.jules', 'auth.json'), h('.config', 'jules', 'auth.json')] },
};

/** Does `command` resolve on PATH? Scans PATH with PATHEXT so it works on Windows + POSIX. */
function commandExists(command: string): boolean {
  const paths = (process.env.PATH || '').split(delimiter).filter(Boolean);
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())
      : [''];
  for (const dir of paths) {
    for (const ext of exts) {
      try {
        if (existsSync(resolve(dir, command + ext))) return true;
      } catch {
        /* ignore unreadable PATH entries */
      }
    }
  }
  return false;
}

/** The first credential file that exists for a CLI, or '' if none. */
export function credFileFor(name: CliName): string {
  for (const p of CLI_SPECS[name].credFiles) {
    try {
      if (existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return '';
}

export interface CliStatus {
  name: CliName;
  label: string;
  installed: boolean;
  loggedIn: boolean;
}

/** Report install + login state for every CLI router (booleans only — no tokens). */
export function cliStatuses(): CliStatus[] {
  return CLI_NAMES.map((name) => {
    // Jules is API-key based (no local CLI); Gemini can use an API key too.
    if (name === 'jules') {
      const hasKey = !!readJulesApiKey();
      return { name, label: CLI_SPECS[name].label, installed: hasKey, loggedIn: hasKey };
    }
    const installed = commandExists(CLI_SPECS[name].command);
    const loggedIn = !!credFileFor(name) || (name === 'gemini' && !!readGeminiApiKey());
    return { name, label: CLI_SPECS[name].label, installed: installed || (name === 'gemini' && !!readGeminiApiKey()), loggedIn };
  });
}

/** Parse a JSON credential file, tolerating a UTF-8 BOM. Throws if missing/invalid. */
export function readCredJson(name: CliName): any {
  const path = credFileFor(name);
  if (!path) {
    throw new Error(`${CLI_SPECS[name].label} is not logged in (no credentials file found). Run \`${CLI_SPECS[name].command}\` and sign in first.`);
  }
  let text = readFileSync(path, 'utf-8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Claude Code OAuth (cli/claude). The `claude` CLI stores a subscription OAuth
// token in ~/.claude/.credentials.json. We read it, refresh it when near expiry,
// and hand back a bearer token the Anthropic Messages API accepts.
// ---------------------------------------------------------------------------

/** Public OAuth client id used by Claude Code (needed to refresh the token). */
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
/** anthropic-beta header value that authorizes OAuth (non-API-key) requests. */
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';

export interface ClaudeAuth {
  accessToken: string;
  /** anthropic-beta header value to send. */
  beta: string;
}

/** Write the rotated token back to ~/.claude/.credentials.json (best-effort). */
function persistClaudeToken(tok: { access_token: string; refresh_token?: string; expires_in?: number }): void {
  const path = credFileFor('claude');
  if (!path) return;
  try {
    const data = readCredJson('claude');
    const o = (data.claudeAiOauth ??= {});
    o.accessToken = tok.access_token;
    if (tok.refresh_token) o.refreshToken = tok.refresh_token;
    if (tok.expires_in) o.expiresAt = Date.now() + tok.expires_in * 1000;
    writeFileSync(path, JSON.stringify(data, null, 2));
  } catch {
    /* non-fatal — we still have the fresh token in memory for this run */
  }
}

/** Exchange the refresh token for a new access token (and persist the rotation). */
async function refreshClaudeToken(refreshToken: string): Promise<string> {
  const r = await fetch('https://console.anthropic.com/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLAUDE_CLIENT_ID }),
  });
  if (!r.ok) {
    throw new Error(`Claude token refresh failed (${r.status}). Run \`claude\` to sign in again.`);
  }
  const j = (await r.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  persistClaudeToken(j);
  return j.access_token;
}

/**
 * Resolve a usable Claude Code OAuth bearer token, refreshing if it is expired or
 * within 60s of expiry. Throws a clear error if not logged in / refresh fails.
 */
export async function readClaudeOAuth(): Promise<ClaudeAuth> {
  const data = readCredJson('claude');
  const o = data.claudeAiOauth ?? data; // tolerate a flat or nested shape
  let accessToken: string = o.accessToken || o.access_token || '';
  const refreshToken: string = o.refreshToken || o.refresh_token || '';
  const expiresAt: number = Number(o.expiresAt || o.expires_at || 0); // ms epoch
  if (!accessToken && !refreshToken) {
    throw new Error('Claude Code credentials found but no token — run `claude` and sign in again.');
  }
  const nearExpiry = expiresAt && Date.now() > expiresAt - 60_000;
  if ((!accessToken || nearExpiry) && refreshToken) {
    accessToken = await refreshClaudeToken(refreshToken);
  }
  if (!accessToken) throw new Error('Could not resolve a Claude Code access token — run `claude` to sign in.');
  return { accessToken, beta: CLAUDE_OAUTH_BETA };
}

// ---------------------------------------------------------------------------
// Codex (cli/codex). The `codex` CLI stores ~/.codex/auth.json. When you log in
// with an API key it contains OPENAI_API_KEY (standard OpenAI API — fully
// supported here). A ChatGPT-subscription login instead stores OAuth `tokens`;
// that backend is not validated here, so we surface a clear guiding error.
// ---------------------------------------------------------------------------

export interface CodexAuth {
  /** Standard OpenAI API key, if the codex login used one. */
  apiKey?: string;
  /** True if only a ChatGPT-subscription OAuth session is present. */
  subscriptionOnly: boolean;
}

export function readCodexAuth(): CodexAuth {
  const data = readCredJson('codex');
  const apiKey: string = data.OPENAI_API_KEY || data.openai_api_key || '';
  const hasOAuth = !!(data.tokens?.access_token || data.tokens?.id_token);
  if (apiKey) return { apiKey, subscriptionOnly: false };
  return { subscriptionOnly: hasOAuth };
}

// ---------------------------------------------------------------------------
// Gemini (cli/gemini). The `gemini` CLI stores an OAuth token under
// ~/.gemini/oauth_creds.json and talks to Google Code Assist. That backend is
// not validated on this machine; readGeminiOAuth resolves the token so a future
// adapter can use it, and callers surface an "experimental" error until then.
// ---------------------------------------------------------------------------

export interface GeminiAuth {
  accessToken: string;
  expiryDate?: number;
}

export function readGeminiOAuth(): GeminiAuth {
  const data = readCredJson('gemini');
  const accessToken: string = data.access_token || data.accessToken || '';
  if (!accessToken) throw new Error('Gemini CLI credentials found but no access token — run `gemini` to sign in.');
  return { accessToken, expiryDate: Number(data.expiry_date || data.expiryDate || 0) || undefined };
}

/** Code Assist API base (the backend the Gemini CLI's free/personal tier talks to). */
export const CODE_ASSIST_BASE = 'https://cloudcode-pa.googleapis.com/v1internal';

/**
 * Discover the Code Assist project id for this account (the Gemini CLI calls
 * `:loadCodeAssist` on startup). Returns the project id, or '' if the account is a
 * free tier that needs no explicit project. Best-effort: a non-OK response yields ''
 * rather than throwing, since streamGenerateContent can still work without it.
 */
export async function resolveCodeAssistProject(accessToken: string): Promise<string> {
  try {
    const r = await fetch(`${CODE_ASSIST_BASE}:loadCodeAssist`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata: { pluginType: 'GEMINI' } }),
    });
    if (!r.ok) return '';
    const j = (await r.json()) as any;
    return j.cloudaicompanionProject || j.project || '';
  } catch {
    return '';
  }
}

export { CLI_SPECS };
