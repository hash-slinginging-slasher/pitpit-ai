import { spawn } from 'child_process';
import type { AgentConfig } from '../config.js';
import { readJulesApiKey, readJulesSource } from '../config.js';
import type { AgentRunOptions, AgentRunResult } from '../local-agent.js';
import type { ChatMessage } from '../agent.js';
import { remoteGithubSlug, currentBranch } from '../git.js';
import { resolveCliPath } from './credentials.js';

/**
 * `jules` transport for the cli/jules router. Jules is NOT a completion endpoint —
 * it is an async autonomous agent that works on a connected GitHub repo in its own
 * VM and opens a pull request. So unlike the other routers it does NOT drive our
 * local tool loop or edit the current directory: we submit the task, stream Jules's
 * plan/progress/messages back as events, and return a summary plus the PR link.
 *
 * API: https://jules.googleapis.com/v1alpha, authed with an x-goog-api-key header
 * (a Jules API key from the jules.google web app, set via Settings or JULES_API_KEY).
 */

const JULES_BASE = 'https://jules.googleapis.com/v1alpha';
const POLL_INTERVAL_MS = 3000;
const DEFAULT_TIMEOUT_MS = 600_000; // 10 min; override with JULES_TIMEOUT_MS

function timeoutMs(): number {
  const v = Number(process.env.JULES_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
}

async function julesFetch(apiKey: string, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${JULES_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey, ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err: any = new Error(`Jules ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? {} : res.json();
}

interface JulesSource {
  name: string;
  githubRepo?: { owner?: string; repo?: string; defaultBranch?: { displayName?: string } };
}

/** Resolve which Jules source (GitHub repo) + branch to run against. */
async function resolveSource(apiKey: string): Promise<{ source: string; branch?: string }> {
  const branch = (await currentBranch(process.cwd())) || undefined;
  const explicit = readJulesSource();
  if (explicit) return { source: explicit, branch };

  const slug = await remoteGithubSlug(process.cwd());
  if (!slug) {
    throw new Error(
      'cli/jules needs a GitHub repo. Run inside a repo whose `origin` is on GitHub and connected to ' +
        'Jules, or set a default source (JULES_SOURCE / Settings).',
    );
  }
  const body = (await julesFetch(apiKey, '/sources?pageSize=100')) as { sources?: JulesSource[] };
  const match = (body.sources ?? []).find(
    (s) =>
      s.githubRepo?.owner?.toLowerCase() === slug.owner.toLowerCase() &&
      s.githubRepo?.repo?.toLowerCase() === slug.repo.toLowerCase(),
  );
  if (!match) {
    throw new Error(
      `No Jules source is connected for ${slug.owner}/${slug.repo}. Connect the repo at https://jules.google, ` +
        `or set a default source (JULES_SOURCE / Settings).`,
    );
  }
  return { source: match.name, branch: branch || match.githubRepo?.defaultBranch?.displayName };
}

export type ActivityKind = 'agent' | 'progress' | 'plan' | 'completed' | 'failed' | 'other';

/**
 * Classify one activity object into a kind + human text, tolerating the API's
 * nested/flat field variants. Exported for unit testing (no network).
 */
export function classifyActivity(a: any): { kind: ActivityKind; text?: string; reason?: string; prUrl?: string } {
  const first = (...vals: any[]) => vals.find((v) => typeof v === 'string' && v);
  // Pull request link may live on a changeSet artifact.
  const prUrl = first(
    a.pullRequest?.url,
    a.prUrl,
    ...(a.artifacts ?? []).map((art: any) => art?.changeSet?.pullRequestUrl || art?.changeSet?.url),
  );
  if (a.sessionFailed || a.sessionFailure) return { kind: 'failed', reason: first(a.sessionFailed?.reason, a.sessionFailure?.reason) ?? 'unknown reason', prUrl };
  if (a.sessionCompleted || a.sessionCompletion) return { kind: 'completed', prUrl };
  const agent = first(a.agentMessaged?.agentMessage, a.agentMessaged?.message, a.agentMessage);
  if (agent) return { kind: 'agent', text: agent, prUrl };
  if (a.planGenerated || a.plan) {
    const steps = (a.planGenerated?.plan?.steps ?? a.plan?.steps ?? a.planGenerated?.steps ?? [])
      .map((s: any) => (typeof s === 'string' ? s : s.title || s.description))
      .filter(Boolean);
    return { kind: 'plan', text: steps.length ? `Plan:\n- ${steps.join('\n- ')}` : 'Plan generated.', prUrl };
  }
  if (a.progressUpdated || a.progressUpdate) {
    const p = a.progressUpdated ?? a.progressUpdate;
    const t = [p.title, p.description].filter(Boolean).join(' — ');
    return { kind: 'progress', text: t || 'Working…', prUrl };
  }
  return { kind: 'other', prUrl };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

/**
 * Extract the latest user prompt from string-or-history input.
 */
function latestPrompt(input: string | ChatMessage[]): string {
  return typeof input === 'string' ? input : [...input].reverse().find((m) => m.role === 'user')?.content ?? '';
}

/**
 * Shell out to the installed `jules` CLI, which uses your own `jules login` (Google
 * OAuth) — no API key needed. `jules new` reads the task from stdin (so the prompt is
 * never interpolated into a command line) and submits a session for the current repo.
 * Jules is async, so this returns the session link; apply results later with
 * `jules remote pull --session <id> --apply` or `jules teleport <id>`.
 */
/** Run the jules CLI with fixed args (+ optional stdin), capturing output. */
function julesExec(
  julesPath: string,
  args: string[],
  opts?: { stdin?: string; onStdout?: (s: string) => void; signal?: AbortSignal },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    // Run without shell so args are passed as a safe argv (no injection, no DEP0190).
    // On Windows the target is an npm `.cmd` shim, which needs cmd.exe to launch.
    const isWin = process.platform === 'win32';
    const cmd = isWin ? process.env.COMSPEC || 'cmd.exe' : julesPath;
    const fullArgs = isWin ? ['/d', '/s', '/c', julesPath, ...args] : args;
    const child = spawn(cmd, fullArgs, { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      opts?.onStdout?.(s);
    });
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    opts?.signal?.addEventListener('abort', () => child.kill(), { once: true });
    child.on('close', (code) => resolvePromise({ code: code ?? 0, stdout, stderr }));
    if (opts?.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}

/** GitHub repos (owner/repo) connected to Jules, via `jules remote list --repo`. */
async function connectedRepos(julesPath: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const { stdout } = await julesExec(julesPath, ['remote', 'list', '--repo'], { signal });
    return [...stdout.matchAll(/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/g)].map((m) => m[1]);
  } catch {
    return [];
  }
}

async function runJulesCliAgent(
  julesPath: string,
  input: string | ChatMessage[],
  options?: AgentRunOptions,
): Promise<AgentRunResult> {
  const prompt = latestPrompt(input);
  if (!prompt.trim()) throw new Error('cli/jules: empty prompt.');

  // Jules only works on a GitHub repo that's connected to it. Validate up front so we
  // give a clear error instead of jules's silent no-op (it prints to stderr + exits 0).
  const slug = await remoteGithubSlug(process.cwd());
  const target = slug ? `${slug.owner}/${slug.repo}` : '';
  const repos = await connectedRepos(julesPath, options?.signal);
  const note = repos.length ? `Connected repos: ${repos.join(', ')}.` : 'No repos are connected to Jules yet (or you are not logged in — run `jules login`).';
  if (!target) {
    throw new Error(`cli/jules works on a GitHub repo connected to Jules — run coder inside one. ${note}`);
  }
  if (repos.length && !repos.some((r) => r.toLowerCase() === target.toLowerCase())) {
    throw new Error(`This repo (${target}) isn't connected to Jules. ${note} Connect it at https://jules.google/docs, or run coder from a connected repo.`);
  }

  options?.onEvent?.({ type: 'text', delta: `Submitting task to Jules for ${target}…\n` });
  const { code, stdout, stderr } = await julesExec(julesPath, ['new', '--repo', target], {
    stdin: prompt,
    onStdout: (s) => options?.onEvent?.({ type: 'text', delta: s }),
    signal: options?.signal,
  });

  // jules exits 0 even on failure and writes errors to stderr — so treat empty stdout
  // or an "Error:" line as a failure and surface the real message.
  if (code !== 0 || !stdout.trim() || /^\s*error[: ]/im.test(stderr)) {
    const detail = stderr.trim() || stdout.trim() || 'no output from jules';
    const hint = /login|auth|sign in|unauthenticated/i.test(detail) ? ' Run `jules login` first.' : '';
    throw new Error(`jules new failed: ${detail.slice(0, 300)}.${hint}`);
  }

  const text =
    stdout.trim() +
    `\n\n(Jules works asynchronously on ${target} and opens a PR. Bring the result back with ` +
    '`jules remote pull --session <id> --apply` or `jules teleport <id>`.)';
  return { text, usage: { inputTokens: 0, outputTokens: 0 }, output: [] };
}

export async function runJulesAgent(
  config: AgentConfig,
  model: string,
  input: string | ChatMessage[],
  options?: AgentRunOptions,
): Promise<AgentRunResult> {
  // Prefer the installed jules CLI (reuses your `jules login` — no API key).
  const julesPath = resolveCliPath('jules');
  if (julesPath) return runJulesCliAgent(julesPath, input, options);

  // Fall back to the Jules API when the CLI isn't installed.
  const apiKey = readJulesApiKey();
  if (!apiKey) {
    throw new Error('cli/jules needs the jules CLI (run `jules login`) or a Jules API key (Settings / JULES_API_KEY).');
  }
  return runJulesApiAgent(config, model, input, options);
}

async function runJulesApiAgent(
  _config: AgentConfig,
  _model: string,
  input: string | ChatMessage[],
  options?: AgentRunOptions,
): Promise<AgentRunResult> {
  const apiKey = readJulesApiKey();
  // Jules takes a single task prompt; use the latest user message.
  const prompt = typeof input === 'string' ? input : [...input].reverse().find((m) => m.role === 'user')?.content ?? '';
  if (!prompt.trim()) throw new Error('cli/jules: empty prompt.');

  const { source, branch } = await resolveSource(apiKey);
  options?.onEvent?.({ type: 'reasoning', delta: `Submitting task to Jules (${source}${branch ? ` @ ${branch}` : ''})…\n` });

  const session = await julesFetch(apiKey, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      prompt,
      title: prompt.slice(0, 80),
      sourceContext: { source, githubRepoContext: branch ? { startingBranch: branch } : undefined },
      requirePlanApproval: false,
      automationMode: 'AUTO_CREATE_PR',
    }),
  });
  const sessionName: string = session.name || (session.id ? `sessions/${session.id}` : '');
  if (session.url) options?.onEvent?.({ type: 'reasoning', delta: `Jules session: ${session.url}\n` });

  // Poll activities until the session completes/fails or we time out.
  const seen = new Set<string>();
  const collected: string[] = [];
  let prUrl = '';
  const deadline = Date.now() + timeoutMs();
  let done = false;
  while (Date.now() < deadline && !done) {
    if (options?.signal?.aborted) break;
    const body = (await julesFetch(apiKey, `/${sessionName}/activities?pageSize=100`)) as { activities?: any[] };
    const acts = [...(body.activities ?? [])].sort((x, y) => String(x.createTime ?? '').localeCompare(String(y.createTime ?? '')));
    for (const a of acts) {
      const id = a.name || a.id || `${a.createTime}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const c = classifyActivity(a);
      if (c.prUrl) prUrl = c.prUrl;
      if (c.kind === 'agent' && c.text) {
        collected.push(c.text);
        options?.onEvent?.({ type: 'text', delta: c.text + '\n' });
      } else if ((c.kind === 'plan' || c.kind === 'progress') && c.text) {
        options?.onEvent?.({ type: 'reasoning', delta: c.text + '\n' });
      } else if (c.kind === 'completed') {
        done = true;
      } else if (c.kind === 'failed') {
        throw new Error(`Jules session failed: ${c.reason}`);
      }
    }
    if (!done) await sleep(POLL_INTERVAL_MS, options?.signal);
  }

  let text = collected.join('\n\n').trim();
  if (prUrl) text += `\n\nPull request: ${prUrl}`;
  if (session.url) text += `\n\nJules session: ${session.url}`;
  if (!done && !options?.signal?.aborted) {
    text += `\n\n(Jules is still working — it runs asynchronously. Check the session link for the final result.)`;
  }
  return { text: text || 'Jules session started.', usage: { inputTokens: 0, outputTokens: 0 }, output: [] };
}
